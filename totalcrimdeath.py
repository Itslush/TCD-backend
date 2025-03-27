# filename: botnet_api.py
from flask import Flask, request, jsonify, render_template
import time
import threading
import logging
import json # For pretty printing JSON on dashboard

app = Flask(__name__)
# Configure logging (optional but recommended)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Configuration ---
SERVER_RESERVATION_TIMEOUT = 30  # Seconds before an initial 'reserved' status expires
IN_SERVER_TIMEOUT_SECONDS = 30 * 60 # Seconds before an 'active' or 'flinging' status expires
CLEANUP_INTERVAL = 60  # Check for stale reservations every 60 seconds

# --- Shared State (In-Memory) ---
# Using a dictionary to hold server reservations and reported flings
shared_data = {
    "serverReservations": {}
}
# Simple counter for total reported flings
# NOTE: This count relies entirely on the Lua script calling /stats/increment_fling
total_flings_reported = 0
# Use a lock to ensure thread safety when accessing shared_data and total_flings_reported
data_lock = threading.Lock()

# --- Helper Functions ---
def is_reservation_stale(reservation):
    """Checks if a reservation is expired based on its status and timestamp."""
    now = time.time()
    timestamp = reservation.get('timestamp', 0)
    status = reservation.get('status', 'reserved')

    if status == 'reserved' and (now - timestamp > SERVER_RESERVATION_TIMEOUT):
        return True, f"Initial reservation timed out (>{SERVER_RESERVATION_TIMEOUT}s)"
    # Consider 'active' and 'flinging' reservations stale after IN_SERVER_TIMEOUT_SECONDS
    if status in ['active', 'flinging'] and (now - timestamp > IN_SERVER_TIMEOUT_SECONDS):
         return True, f"'{status}' status timed out (>{IN_SERVER_TIMEOUT_SECONDS / 60:.1f} mins)"
    # Could add checks for very old 'reserved' as a failsafe, but timeouts should cover most cases
    return False, ""

def cleanup_stale_reservations():
    """Background thread function to periodically remove stale reservations."""
    while True:
        time.sleep(CLEANUP_INTERVAL)
        removed_count = 0
        logging.debug("Cleanup: Starting check for stale reservations...")
        with data_lock:
            reservations = shared_data.get("serverReservations", {})
            # Iterate over a copy of the keys to allow safe deletion during iteration
            stale_ids_to_remove = []
            for server_id, res in reservations.items():
                is_stale, reason = is_reservation_stale(res)
                if is_stale:
                    logging.info(f"Cleanup: Marking stale reservation for {server_id} by {res.get('botName', 'N/A')}. Reason: {reason}")
                    stale_ids_to_remove.append(server_id)

            # Remove identified stale reservations
            for server_id in stale_ids_to_remove:
                if server_id in reservations:
                    del reservations[server_id]
                    removed_count += 1

        if removed_count > 0:
            logging.info(f"Cleanup: Removed {removed_count} stale reservations.")
        else:
             logging.debug("Cleanup: No stale reservations found.")


# --- API Endpoints ---

@app.route('/reservations', methods=['GET'])
def get_reservations():
    """Returns the current valid (non-stale) reservations."""
    with data_lock:
        valid_reservations = {}
        for server_id, res in shared_data.get("serverReservations", {}).items():
             is_stale, _ = is_reservation_stale(res)
             if not is_stale:
                 valid_reservations[server_id] = res
        return jsonify(valid_reservations)

@app.route('/reservations/reserve', methods=['POST'])
def reserve_server():
    """Attempts to reserve a server for a bot. Releases bot's old reservation if any."""
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']
    region = data.get('region', 'Unknown')
    initial_player_count = data.get('initialPlayerCount', -1)

    with data_lock:
        reservations = shared_data.get("serverReservations", {})

        # Check if bot already has *another* reservation and release it
        existing_reservation_to_release = None
        for s_id, res in reservations.items():
            if res.get("botName") == bot_name and s_id != server_id:
                logging.warning(f"Reserve: Bot {bot_name} reserving {server_id} but already has {s_id}. Releasing old reservation.")
                existing_reservation_to_release = s_id
                break # Release only one old one per request

        if existing_reservation_to_release:
             if existing_reservation_to_release in reservations:
                 del reservations[existing_reservation_to_release]

        # Check if the target server is currently reserved (and not stale) by someone else
        current_reservation = reservations.get(server_id)
        if current_reservation:
             is_stale, _ = is_reservation_stale(current_reservation)
             # Only block if the current reservation isn't stale and belongs to another bot
             if not is_stale and current_reservation.get("botName") != bot_name :
                 logging.warning(f"Reserve Conflict: {server_id} already reserved by {current_reservation.get('botName')}")
                 return jsonify({"error": "Server already reserved", "reservedBy": current_reservation.get('botName')}), 409 # Conflict status code

        # Reserve the server (or update if the bot already owned it but maybe status was weird)
        new_reservation = {
            "serverId": server_id,
            "botName": bot_name,
            "timestamp": time.time(),
            "status": "reserved",
            "region": region,
            "initialPlayerCount": initial_player_count,
            "currentPlayerCount": None # Will be set on update
        }
        reservations[server_id] = new_reservation
        logging.info(f"Reserve Success: {bot_name} reserved {server_id}")
        return jsonify(new_reservation), 201 # HTTP 201 Created

@app.route('/reservations/update', methods=['PUT', 'PATCH'])
def update_reservation():
    """Updates the status/heartbeat/playercount of a reservation. Can create if missing."""
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']
    new_status = data.get('status') # e.g., 'active' or 'flinging'
    current_player_count = data.get('currentPlayerCount') # Integer

    # Validate status if provided
    if new_status is not None and new_status not in ['active', 'flinging']:
         return jsonify({"error": "Invalid status provided. Must be 'active' or 'flinging'."}), 400

    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
            # If update is called for a server not in reservations, create it (robustness for heartbeat)
            logging.warning(f"Update: Reservation for {server_id} by {bot_name} not found. Creating based on update data.")
            new_reservation = {
                "serverId": server_id,
                "botName": bot_name,
                "timestamp": time.time(),
                "status": new_status or "active", # Default to active if creating and no status given
                "region": data.get('region', 'Unknown'), # Try to get region if provided
                "initialPlayerCount": current_player_count, # Best guess based on current count
                "currentPlayerCount": current_player_count
            }
            reservations[server_id] = new_reservation
            return jsonify(new_reservation), 201 # Created

        # Verify ownership if reservation exists
        if current_reservation.get("botName") != bot_name:
            logging.error(f"Update Auth Fail: {bot_name} tried to update reservation for {server_id} owned by {current_reservation.get('botName')}")
            return jsonify({"error": "Reservation owned by another bot"}), 403 # Forbidden

        # Update fields if provided and changed
        updated = False
        if new_status is not None and current_reservation.get('status') != new_status:
             current_reservation['status'] = new_status
             updated = True
        if current_player_count is not None and current_reservation.get('currentPlayerCount') != current_player_count:
             current_reservation['currentPlayerCount'] = current_player_count
             updated = True

        # Always update the timestamp to keep the reservation alive
        current_reservation['timestamp'] = time.time()

        if updated:
             logging.info(f"Update Success: {bot_name} updated {server_id} (status={current_reservation['status']}, players={current_reservation['currentPlayerCount']})")
        else:
             logging.debug(f"Heartbeat Received: {bot_name} for {server_id} (status={current_reservation['status']}, players={current_reservation['currentPlayerCount']})")

        return jsonify(current_reservation), 200 # OK

@app.route('/reservations/release', methods=['DELETE'])
def release_reservation():
    """Releases a reservation if held by the requesting bot."""
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']

    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
            logging.warning(f"Release Not Found: Attempt to release non-existent reservation for {server_id} by {bot_name}")
            # Not an error, just means nothing to release
            return jsonify({"message": "Reservation not found or already released"}), 200 # OK (idempotent)

        # Verify ownership before deleting
        if current_reservation.get("botName") != bot_name:
            logging.error(f"Release Auth Fail: {bot_name} tried to release reservation for {server_id} owned by {current_reservation.get('botName')}")
            return jsonify({"error": "Reservation owned by another bot"}), 403 # Forbidden

        # Delete the reservation
        del reservations[server_id]
        logging.info(f"Release Success: {bot_name} released reservation for {server_id}")
        return jsonify({"message": "Reservation released successfully"}), 200 # OK

# --- Endpoint to increment fling counter ---
@app.route('/stats/increment_fling', methods=['POST'])
def increment_fling_count():
    """Increments the total reported fling count. Called by Lua on successful fling."""
    # Could add optional 'botName' or 'serverId' to the request body for logging purposes
    # bot_name = request.json.get('botName') if request.json else None
    global total_flings_reported
    with data_lock:
        total_flings_reported += 1
        current_count = total_flings_reported
    logging.info(f"Fling reported via API. Total now: {current_count}")
    # Return the new total in the response
    return jsonify({"message": "Fling count incremented", "totalFlings": current_count}), 200


# --- NEW: Dashboard Frontend Route ---
# @app.route('/', methods=['GET']) # Serve the dashboard at the root URL
# def dashboard():
#     """Serves the HTML dashboard."""
#     bot_names = set()
#     server_count = 0
#     current_reservations_list = [] # For JSON display
#
#     with data_lock:
#         # Calculate stats based on non-stale reservations
#         reservations = shared_data.get("serverReservations", {})
#         for server_id, res in reservations.items():
#             is_stale, _ = is_reservation_stale(res)
#             if not is_stale:
#                 bot_names.add(res.get("botName", "Unknown"))
#                 server_count += 1
#                 current_reservations_list.append(res) # Add non-stale to list
#
#         bot_count = len(bot_names)
#         flings = total_flings_reported # Get the global count
#
#     # Prepare data for the template
#     try:
#         # Sort by timestamp descending for JSON view?
#         current_reservations_list.sort(key=lambda x: x.get('timestamp', 0), reverse=True)
#         # Pretty print the JSON for display
#         reservations_json_str = json.dumps(current_reservations_list, indent=2)
#     except Exception as e:
#         logging.error(f"Error preparing JSON for dashboard: {e}")
#         reservations_json_str = "Error generating JSON view."
#
#     # Render the HTML template, passing the calculated data
#     # THIS LINE CAUSES THE ERROR IF THE TEMPLATE IS MISSING
#     # return render_template(
#     #     'dashboard.html',
#     #     bot_count=bot_count,
#     #     server_count=server_count,
#     #     total_flings=flings,
#     #     reservations_json=reservations_json_str
#     # )

# --- Start Background Cleanup Thread ---
# daemon=True ensures the thread exits when the main app exits
cleanup_thread = threading.Thread(target=cleanup_stale_reservations, daemon=True)
cleanup_thread.start()
logging.info("Background cleanup thread started.")

# --- Run Flask App ---
if __name__ == '__main__':
    # host='0.0.0.0' makes the server accessible from other devices on the network
    # port=5000 is the default Flask port, change if needed
    # debug=False is important for production/stability; set to True only for development
    logging.info("Starting Flask application...")
    app.run(host='0.0.0.0', port=5000, debug=True)