import time
import threading
import logging
import os
from flask import Flask, request, jsonify, render_template
from collections import defaultdict, deque

# --- Configuration ---
# Basic logging setup
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Flask App Initialization
app = Flask(__name__, template_folder='templates', static_folder='static')
# It's highly recommended to set this via environment variables for production
app.config['SECRET_KEY'] = os.environ.get('FLASK_SECRET_KEY', 'a_very_strong_default_secret_key_for_dev_!@#$%')

# --- Constants ---
SERVER_RESERVATION_TIMEOUT = 30  # Seconds before an initial 'reserved' status becomes stale
IN_SERVER_TIMEOUT_SECONDS = 30 * 60  # Minutes * 60 = Seconds before 'active'/'flinging' becomes stale
CLEANUP_INTERVAL = 60  # Seconds between checks for stale reservations
MAX_RECENT_FLINGS = 50  # Max fling events to keep in recent list
MAX_CHAT_LOGS = 1000  # Max chat log entries to keep in memory

# --- Shared State ---
# Using a dictionary to hold shared data structures, protected by a lock
shared_data = {
    "serverReservations": {},  # Stores current server reservations {serverId: reservation_dict}
    "last_stats_calc": {"time": 0, "fling_count": 0},  # For calculating fling rate
    "recent_flings": deque(maxlen=MAX_RECENT_FLINGS),  # Stores recent fling events
    "chat_logs": deque(maxlen=MAX_CHAT_LOGS)  # Stores recent chat log entries
}
total_flings_reported = 0  # Global counter for total flings (consider persistence for production)
data_lock = threading.Lock()  # Lock to protect access to shared_data and total_flings_reported

# --- Helper Functions ---

def redact_reservation_info(reservation):
    """Creates a copy of a reservation with sensitive info (like botName) redacted."""
    if not reservation:
        return None
    redacted_res = reservation.copy()
    # Example: Redact botName. Add other fields if needed.
    if "botName" in redacted_res:
        redacted_res["botName"] = "[REDACTED]" # Or hash/anonymize differently
    return redacted_res

def is_reservation_stale(reservation):
    """Checks if a reservation has exceeded its timeout based on status."""
    now = time.time()
    timestamp = reservation.get('timestamp', 0)
    status = reservation.get('status', 'reserved') # Default to 'reserved' if status missing

    if status == 'reserved' and (now - timestamp > SERVER_RESERVATION_TIMEOUT):
        return True, f"Initial reservation timed out (>{SERVER_RESERVATION_TIMEOUT}s)"
    if status in ['active', 'flinging'] and (now - timestamp > IN_SERVER_TIMEOUT_SECONDS):
        return True, f"'{status}' status timed out (>{IN_SERVER_TIMEOUT_SECONDS / 60:.1f} mins)"

    # Add checks for other statuses if necessary
    # if status == 'some_other_status' and (now - timestamp > SOME_OTHER_TIMEOUT):
    #     return True, "Reason for other status timeout"

    return False, "" # Not stale

# --- Background Tasks ---

def cleanup_stale_reservations():
    """Background thread function to periodically remove stale reservations."""
    logging.info("Background reservation cleanup thread started.")
    while True:
        time.sleep(CLEANUP_INTERVAL)
        removed_count = 0
        stale_ids_to_remove = []
        logging.debug("Cleanup: Starting check for stale reservations...")
        with data_lock:
            # Iterate over a copy of items to avoid modification issues during iteration
            reservations = shared_data.get("serverReservations", {})
            for server_id, res in list(reservations.items()):
                is_stale, reason = is_reservation_stale(res)
                if is_stale:
                    logging.info(f"Cleanup: Marking stale reservation for {server_id} by bot '{res.get('botName', 'N/A')}'. Reason: {reason}")
                    stale_ids_to_remove.append(server_id)

            # Remove marked reservations
            for server_id in stale_ids_to_remove:
                if server_id in reservations:
                    del reservations[server_id]
                    removed_count += 1

        if removed_count > 0:
            logging.info(f"Cleanup: Removed {removed_count} stale reservations.")
        else:
            logging.debug("Cleanup: No stale reservations found this cycle.")

# Start the background thread
cleanup_thread = threading.Thread(target=cleanup_stale_reservations, daemon=True)
cleanup_thread.start()

# --- API Endpoints ---

# == Reservation Endpoints ==

@app.route('/reservations', methods=['GET'])
def get_reservations():
    """Returns a list of current, non-stale reservations (redacted)."""
    valid_reservations_list = []
    redacted_list = []
    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        # Filter out stale reservations before redacting
        for server_id, res in reservations.items():
             is_stale, _ = is_reservation_stale(res)
             if not is_stale:
                 valid_reservations_list.append(res)

    # Sort by timestamp (most recent first) - optional
    valid_reservations_list.sort(key=lambda x: x.get('timestamp', 0), reverse=True)

    # Redact information for public viewing
    for res in valid_reservations_list:
        redacted_list.append(redact_reservation_info(res))

    return jsonify(redacted_list)

@app.route('/reservations/reserve', methods=['POST'])
def reserve_server():
    """Allows a bot to reserve a specific server ID."""
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']
    region = data.get('region', 'Unknown') # Optional data from Luau
    initial_player_count = data.get('initialPlayerCount', -1) # Optional

    with data_lock:
        reservations = shared_data.get("serverReservations", {})

        # Check if this bot already holds a DIFFERENT reservation and release it
        existing_reservation_to_release = None
        for s_id, res in reservations.items():
            if res.get("botName") == bot_name and s_id != server_id:
                logging.warning(f"Reserve: Bot '{bot_name}' reserving {server_id} but already holds {s_id}. Releasing old.")
                existing_reservation_to_release = s_id
                break # Assuming one bot holds max one reservation

        if existing_reservation_to_release and existing_reservation_to_release in reservations:
            del reservations[existing_reservation_to_release]

        # Check if the target server is currently reserved by someone else (and not stale)
        current_reservation = reservations.get(server_id)
        if current_reservation:
             is_stale, _ = is_reservation_stale(current_reservation)
             if not is_stale and current_reservation.get("botName") != bot_name:
                 # Server is actively reserved by another bot
                 logging.warning(f"Reserve Conflict: {server_id} already reserved by '{current_reservation.get('botName')}' (requester: '{bot_name}')")
                 # Provide redacted info about who holds the reservation
                 error_response = {
                     "error": "Server already reserved",
                     "reservedBy": redact_reservation_info(current_reservation).get("botName") # Show redacted name
                 }
                 return jsonify(error_response), 409 # HTTP 409 Conflict

        # Proceed with creating the new reservation
        new_reservation = {
            "serverId": server_id,
            "botName": bot_name, # Store the actual bot name internally
            "timestamp": time.time(),
            "status": "reserved", # Initial status
            "region": region,
            "initialPlayerCount": initial_player_count,
            "currentPlayerCount": None # Will be updated by heartbeat
        }
        reservations[server_id] = new_reservation
        logging.info(f"Reserve Success: Bot '{bot_name}' reserved {server_id} in region '{region}'")

        # Return the newly created reservation (redacted for the response)
        return jsonify(redact_reservation_info(new_reservation)), 201 # HTTP 201 Created

@app.route('/reservations/update', methods=['PUT', 'PATCH']) # Allow PUT or PATCH
def update_reservation():
    """Allows a bot to update its reservation status or player count (heartbeat)."""
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']
    new_status = data.get('status') # e.g., 'active', 'flinging'
    current_player_count = data.get('currentPlayerCount') # Number

    # Validate status if provided
    if new_status is not None and new_status not in ['active', 'flinging']:
         return jsonify({"error": "Invalid status. Must be 'active' or 'flinging'."}), 400

    response_data = None
    status_code = 200 # Default OK

    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
             # If heartbeat received for an unknown/stale reservation, create it (self-healing)
             logging.warning(f"Update: Reservation for {server_id} by bot '{bot_name}' not found or was stale. Creating/Reactivating.")
             new_reservation = {
                 "serverId": server_id, "botName": bot_name, "timestamp": time.time(),
                 "status": new_status or "active", # Use provided status or default to active
                 "region": data.get('region', 'Unknown'), # Try to get region if available
                 "initialPlayerCount": current_player_count, # Use current count as initial if creating
                 "currentPlayerCount": current_player_count
             }
             reservations[server_id] = new_reservation
             response_data = new_reservation
             status_code = 201 # Indicate resource was created
        else:
            # Verify ownership
            if current_reservation.get("botName") != bot_name:
                logging.error(f"Update Auth Fail: Bot '{bot_name}' tried to update {server_id} owned by '{current_reservation.get('botName')}'")
                return jsonify({"error": "Reservation owned by another bot"}), 403 # HTTP 403 Forbidden

            # Update fields if they have changed
            updated = False
            if new_status is not None and current_reservation.get('status') != new_status:
                current_reservation['status'] = new_status
                updated = True
                logging.info(f"Update: Bot '{bot_name}' changed status for {server_id} to '{new_status}'")
            if current_player_count is not None and current_reservation.get('currentPlayerCount') != current_player_count:
                current_reservation['currentPlayerCount'] = current_player_count
                updated = True

            # Always update the timestamp to keep the reservation alive
            current_reservation['timestamp'] = time.time()

            if updated:
                logging.debug(f"Update Success: Bot '{bot_name}' updated {server_id} (status={current_reservation['status']}, players={current_reservation['currentPlayerCount']})")
            else:
                 logging.debug(f"Heartbeat Received (No Change): Bot '{bot_name}' for {server_id}")

            response_data = current_reservation
            status_code = 200 # OK

    # Return the current state (redacted)
    redacted_response = redact_reservation_info(response_data)
    return jsonify(redacted_response), status_code

@app.route('/reservations/release', methods=['DELETE'])
def release_reservation():
    """Allows a bot to explicitly release its reservation."""
    data = request.get_json()
    # Require serverId and botName for verification
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']

    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
            # Reservation doesn't exist or already released/stale
            logging.warning(f"Release Ignored: Reservation for {server_id} by bot '{bot_name}' not found.")
            # Return 200 OK even if not found, as the desired state (released) is achieved
            return jsonify({"message": "Reservation not found or already released"}), 200

        # Verify ownership before deleting
        if current_reservation.get("botName") != bot_name:
            logging.error(f"Release Auth Fail: Bot '{bot_name}' tried to release {server_id} owned by '{current_reservation.get('botName')}'")
            return jsonify({"error": "Reservation owned by another bot"}), 403 # Forbidden

        # Delete the reservation
        del reservations[server_id]
        logging.info(f"Release Success: Bot '{bot_name}' released reservation for {server_id}")
        return jsonify({"message": "Reservation released successfully"}), 200

# == Fling Tracking Endpoints ==

@app.route('/stats/increment_fling', methods=['POST'])
def increment_fling_count():
    """Increments the total fling count and adds event to recent flings list."""
    request_start_time = time.time()
    global total_flings_reported # Need global keyword to modify the counter
    data = request.get_json()

    # Extract details from the payload sent by Luau (use defaults if missing)
    target_name = data.get('target', 'Unknown') if data else 'Unknown'
    bot_name = data.get('botName', 'Unknown') if data else 'Unknown'
    server_id = data.get('serverId', 'Unknown') if data else 'Unknown'
    timestamp = time.time() # Use server time for the event record

    fling_event = {
        "timestamp": timestamp,
        "botName": bot_name,
        "serverId": server_id,
        "target": target_name,
    }

    with data_lock:
        total_flings_reported += 1
        current_total_count = total_flings_reported # Get current value after incrementing
        shared_data["recent_flings"].appendleft(fling_event) # Add to the start of the deque

    logging.info(f"Fling reported by '{bot_name}' on {server_id} for '{target_name}'. New total: {current_total_count}.")

    request_end_time = time.time()
    logging.debug(f"Fling Inc Request handled in {request_end_time - request_start_time:.4f}s")

    # Return confirmation and current total
    return jsonify({"message": "Fling count incremented", "totalFlings": current_total_count}), 200

@app.route('/flings', methods=['GET'])
def get_recent_flings():
    """Returns the list of most recent fling events."""
    with data_lock:
        # Create a list copy of the deque to return as JSON
        recent_flings_list = list(shared_data["recent_flings"])
    return jsonify(recent_flings_list)

# == Chat Log Endpoints ==

@app.route('/chatlogs', methods=['POST'])
def receive_chat_log():
    """Receives a chat log entry from a bot."""
    data = request.get_json()

    if not data:
        return jsonify({"error": "Missing JSON payload"}), 400

    # Validate required fields expected from Luau
    player_name = data.get('playerName')
    message = data.get('message')
    bot_name = data.get('botName') # Provided by Luau

    if not player_name or message is None: # Allow empty messages, but not missing field
        logging.warning(f"ChatLog Receive Fail: Missing playerName or message field in payload: {data}")
        return jsonify({"error": "Missing required fields: playerName, message"}), 400

    # Get optional fields provided by Luau
    server_id = data.get('serverId') # Can be None if Luau couldn't get it
    client_timestamp = data.get('timestamp') # Timestamp from Luau client

    # Create the log entry dictionary
    log_entry = {
        "received_at": time.time(), # Server-side timestamp when received
        "client_timestamp": client_timestamp,
        "botName": bot_name,
        "serverId": server_id,
        "playerName": player_name,
        "message": message, # Store the message content
    }

    with data_lock:
        shared_data["chat_logs"].appendleft(log_entry) # Add to the beginning of the deque

    # Log confirmation (adjust level as needed)
    logging.info(f"ChatLog Received: Server='{server_id}', Player='{player_name}'")
    # logging.debug(f"ChatLog Content by Bot='{bot_name}': {message}") # Uncomment for verbose debugging

    return jsonify({"message": "Chat log received"}), 200 # Send success response

@app.route('/get_chatlogs', methods=['GET'])
def get_chat_logs():
    """Returns the most recent chat logs stored in memory, with optional limit."""
    limit_str = request.args.get('limit', default=str(MAX_CHAT_LOGS), type=str)
    try:
        limit = int(limit_str)
    except ValueError:
        limit = MAX_CHAT_LOGS # Default to max if invalid input

    # Ensure limit is within reasonable bounds
    limit = max(1, min(limit, MAX_CHAT_LOGS))

    with data_lock:
        # Return a *copy* of the relevant portion of the deque
        logs_to_return = list(shared_data["chat_logs"])[:limit]

    return jsonify(logs_to_return)

# == Dashboard and Stats ==

@app.route('/dashboard', methods=['GET'])
def serve_dashboard_page():
    """Serves the main HTML dashboard page."""
    # Assumes you have a 'dashboard.html' file in a 'templates' directory
    # relative to where you run the script.
    logging.info("Serving dashboard HTML page.")
    try:
        return render_template('dashboard.html')
    except Exception as e:
        logging.error(f"Error rendering dashboard template: {e}", exc_info=True)
        return "Error loading dashboard.", 500

@app.route('/', methods=['GET'])
@app.route('/stats', methods=['GET']) # Provide an explicit /stats endpoint too
def get_stats_data():
    """Calculates and returns current bot/server stats and fling rate."""
    stats_start_time = time.time()
    bot_names = set()
    server_count = 0
    bots_by_region = defaultdict(set)
    now = time.time()
    current_total_flings = 0
    fling_rate_per_minute = 0.0

    logging.debug("Calculating stats for / or /stats endpoint.")
    with data_lock:
        # Get non-stale reservations
        reservations = shared_data.get("serverReservations", {})
        valid_reservations = {sid: res for sid, res in reservations.items() if not is_reservation_stale(res)[0]}

        # Calculate bot counts and regions from valid reservations
        for server_id, res in valid_reservations.items():
            bot_name = res.get("botName", "UnknownBot") # Use actual name for counting
            region = res.get("region", "UnknownRegion")
            bot_names.add(bot_name)
            bots_by_region[region].add(bot_name) # Add bot name to the set for that region

        server_count = len(valid_reservations) # Count of active servers
        bot_count = len(bot_names) # Count of unique active bot names
        # Count unique bots per region
        regional_bot_counts = {region: len(bots) for region, bots in bots_by_region.items()}

        # Get current fling total and calculate rate
        current_total_flings = total_flings_reported
        last_calc = shared_data["last_stats_calc"]
        time_diff = now - last_calc["time"]
        fling_diff = current_total_flings - last_calc["fling_count"]

        # Calculate rate if enough time has passed and data is available
        if last_calc["time"] > 0 and time_diff > 1: # Avoid division by zero or tiny intervals
            # Basic check for counter resets (heuristic)
            if fling_diff < 0 and abs(fling_diff) > last_calc["fling_count"] * 0.5:
                 logging.warning(f"Potential fling counter reset detected or large decrease. Old: {last_calc['fling_count']}, New: {current_total_flings}. Rate calculation skipped/reset.")
                 fling_diff = 0 # Reset diff if counter seems reset

            flings_per_second = max(0.0, fling_diff / time_diff) # Ensure rate isn't negative
            fling_rate_per_minute = flings_per_second * 60
        else:
            # Not enough data or first calculation
            fling_rate_per_minute = 0.0

        # Update last calculation time and count for next interval
        shared_data["last_stats_calc"]["time"] = now
        shared_data["last_stats_calc"]["fling_count"] = current_total_flings

    # Prepare the stats payload
    stats_data = {
        "botCount": bot_count,
        "serverCount": server_count,
        "totalFlings": current_total_flings,
        "flingRatePerMinute": round(fling_rate_per_minute, 2), # Round for display
        "botsPerRegion": regional_bot_counts # Dictionary of {region: count}
    }

    stats_end_time = time.time()
    logging.debug(f"Stats calculation took {stats_end_time - stats_start_time:.4f}s.")
    return jsonify(stats_data)

# --- Main Execution Guard ---

if __name__ == '__main__':
    # Get port from environment variable or default to 5000
    port = int(os.environ.get('PORT', 5000))
    logging.info(f"Starting Flask API on port {port}...")

    # Run the Flask development server
    # For production, use a proper WSGI server like Gunicorn or Waitress
    # Example: gunicorn --bind 0.0.0.0:5000 api:app
    app.run(host='0.0.0.0', port=port, debug=False) # Set debug=False for production