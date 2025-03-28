# totalcrimdeath.py
from flask import Flask, request, jsonify, render_template
from flask_socketio import SocketIO  # <-- Import SocketIO
import time
import threading
import logging
from collections import defaultdict
import os  # <-- Import OS module
import json # <-- Import JSON module

# --- Configuration ---
DISK_MOUNT_PATH = "/data"  # The Mount Path you set in Render
# Use JSON Lines format (.jsonl) for easy appending
FLING_HISTORY_FILE = os.path.join(DISK_MOUNT_PATH, "flings", "flings_history.jsonl")

# --- Flask App Setup ---
app = Flask(__name__, template_folder='templates', static_folder='static')
# IMPORTANT: Use an environment variable for the secret key in production!
app.config['SECRET_KEY'] = os.environ.get('FLASK_SECRET_KEY', 'a_very_strong_default_secret_key_for_dev_!@#$%')

# --- Initialize SocketIO ---
# Use eventlet as the async mode, recommended for Render deployments with SocketIO
socketio = SocketIO(app, async_mode='eventlet', cors_allowed_origins="*") # Allow all origins for now, refine later if needed

# --- Logging Setup ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Ensure Storage Directories/Files Exist on Startup ---
try:
    # Create parent directory for the file if it doesn't exist
    os.makedirs(os.path.dirname(FLING_HISTORY_FILE), exist_ok=True)
    logging.info(f"Ensured storage directory exists: {os.path.dirname(FLING_HISTORY_FILE)}")

    # Create an empty file if it doesn't exist to avoid errors on first access
    # This check is important for the first run after mounting the disk.
    if not os.path.exists(FLING_HISTORY_FILE):
        with open(FLING_HISTORY_FILE, 'w') as f:
            pass # Just create the empty file
        logging.info(f"Created empty fling history file: {FLING_HISTORY_FILE}")

except OSError as e:
    # Log a fatal error if directory/file creation fails. This likely indicates
    # a problem with the disk mount or permissions.
    logging.error(f"FATAL: Could not create storage directories/files in {DISK_MOUNT_PATH}. Check disk mount and permissions. Error: {e}")
    # Depending on severity, you might want to add sys.exit(1) here

# --- Shared Data & Locks ---
SERVER_RESERVATION_TIMEOUT = 30
IN_SERVER_TIMEOUT_SECONDS = 30 * 60
CLEANUP_INTERVAL = 60

# In-memory storage for current reservations and stats calculation helpers
shared_data = {
    "serverReservations": {},
    "last_stats_calc": {"time": 0, "fling_count": 0}
}

# In-memory counter for total flings (provides fast access for the '/' stats endpoint)
total_flings_reported = 0

# Locks to prevent race conditions when accessing shared resources
data_lock = threading.Lock() # For in-memory shared_data (reservations, stats calc)
file_lock = threading.Lock() # For writing to the fling history file on disk

# --- Helper Functions ---

def redact_reservation_info(reservation):
    """Redacts sensitive information (like botName) for public view."""
    if not reservation:
        return None
    redacted_res = reservation.copy()
    if "botName" in redacted_res:
        # For now, always redact publicly. Login implementation will modify this later.
        redacted_res["botName"] = "[REDACTED]"
    return redacted_res

def is_reservation_stale(reservation):
    """Checks if a reservation has timed out based on its status and timestamp."""
    now = time.time()
    timestamp = reservation.get('timestamp', 0)
    status = reservation.get('status', 'reserved')

    if status == 'reserved' and (now - timestamp > SERVER_RESERVATION_TIMEOUT):
        return True, f"Initial reservation timed out (>{SERVER_RESERVATION_TIMEOUT}s)"
    if status in ['active', 'flinging'] and (now - timestamp > IN_SERVER_TIMEOUT_SECONDS):
         return True, f"'{status}' status timed out (>{IN_SERVER_TIMEOUT_SECONDS / 60:.1f} mins)"
    return False, ""

# --- Background Cleanup Thread ---

def cleanup_stale_reservations():
    """Periodically checks for and removes stale reservations from in-memory store."""
    while True:
        time.sleep(CLEANUP_INTERVAL)
        removed_count = 0
        logging.debug("Cleanup: Starting check for stale reservations...")
        with data_lock: # Acquire lock for accessing shared_data['serverReservations']
            reservations = shared_data.get("serverReservations", {})
            stale_ids_to_remove = []
            for server_id, res in list(reservations.items()): # Iterate over a copy of items
                is_stale, reason = is_reservation_stale(res)
                if is_stale:
                    logging.info(f"Cleanup: Marking stale reservation for {server_id} by {res.get('botName', 'N/A')}. Reason: {reason}")
                    stale_ids_to_remove.append(server_id)

            # Remove marked reservations
            for server_id in stale_ids_to_remove:
                if server_id in reservations:
                    del reservations[server_id]
                    removed_count += 1

        if removed_count > 0:
            logging.info(f"Cleanup: Removed {removed_count} stale reservations.")
        else:
             logging.debug("Cleanup: No stale reservations found.")

# === Routes ===

# --- Reservation API Endpoints ---

@app.route('/reservations', methods=['GET'])
def get_reservations():
    """Returns a list of current, non-stale server reservations (redacted)."""
    valid_reservations_list = []
    redacted_list = []
    with data_lock: # Access in-memory reservations
        reservations = shared_data.get("serverReservations", {})
        # Filter out stale reservations
        for server_id, res in reservations.items():
             is_stale, _ = is_reservation_stale(res)
             if not is_stale:
                 valid_reservations_list.append(res)

    # Sort by timestamp, newest first
    valid_reservations_list.sort(key=lambda x: x.get('timestamp', 0), reverse=True)

    # Redact information before sending
    for res in valid_reservations_list:
        redacted_list.append(redact_reservation_info(res))

    return jsonify(redacted_list)

@app.route('/reservations/reserve', methods=['POST'])
def reserve_server():
    """Allows a bot to reserve a server slot."""
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']
    region = data.get('region', 'Unknown')
    initial_player_count = data.get('initialPlayerCount', -1) # Get initial count if provided

    with data_lock: # Modify in-memory reservations
        reservations = shared_data.get("serverReservations", {})

        # --- Check if the bot already holds another reservation and release it ---
        existing_reservation_to_release = None
        for s_id, res in reservations.items():
            if res.get("botName") == bot_name and s_id != server_id:
                logging.warning(f"Reserve: Bot {bot_name} reserving {server_id} but already has {s_id}. Releasing old.")
                existing_reservation_to_release = s_id
                break
        if existing_reservation_to_release and existing_reservation_to_release in reservations:
            del reservations[existing_reservation_to_release]

        # --- Check if the target server is already reserved by *another* bot ---
        current_reservation = reservations.get(server_id)
        if current_reservation:
             is_stale, _ = is_reservation_stale(current_reservation)
             # If it exists, isn't stale, and is owned by a different bot -> Conflict
             if not is_stale and current_reservation.get("botName") != bot_name :
                 logging.warning(f"Reserve Conflict: {server_id} already reserved by {current_reservation.get('botName')}")
                 # Redact the owner's name in the error response
                 error_response = {"error": "Server already reserved", "reservedBy": "[REDACTED]"}
                 return jsonify(error_response), 409
             # If it's stale or owned by the same bot, we allow overwriting

        # --- Create or Overwrite the reservation ---
        new_reservation = {
            "serverId": server_id,
            "botName": bot_name,
            "timestamp": time.time(),
            "status": "reserved", # Initial status
            "region": region,
            "initialPlayerCount": initial_player_count,
            "currentPlayerCount": None # Current count is unknown at reservation time
        }
        reservations[server_id] = new_reservation
        logging.info(f"Reserve Success: {bot_name} reserved {server_id}")

        # Redact the successful response before sending
        return jsonify(redact_reservation_info(new_reservation)), 201 # 201 Created


@app.route('/reservations/update', methods=['PUT', 'PATCH'])
def update_reservation():
    """Allows a bot to update its reservation status or player count (heartbeat)."""
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']
    new_status = data.get('status') # Optional: 'active' or 'flinging'
    current_player_count = data.get('currentPlayerCount') # Optional

    # Validate status if provided
    if new_status is not None and new_status not in ['active', 'flinging']:
         return jsonify({"error": "Invalid status. Must be 'active' or 'flinging'."}), 400

    response_data = None
    status_code = 200 # Assume 200 OK unless created

    with data_lock: # Modify in-memory reservations
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
            # Reservation doesn't exist - Create it based on this update (e.g., if bot joined without reserving)
            logging.warning(f"Update: Reservation for {server_id} by {bot_name} not found. Creating.")
            # Note: Region/initialPlayerCount might be inaccurate if created here
            new_reservation = {
                "serverId": server_id,
                "botName": bot_name,
                "timestamp": time.time(),
                "status": new_status or "active", # Default to 'active' if status missing
                "region": data.get('region', 'Unknown'), # Try to get region if provided
                "initialPlayerCount": current_player_count, # Best guess for initial count
                "currentPlayerCount": current_player_count
            }
            reservations[server_id] = new_reservation
            response_data = new_reservation
            status_code = 201 # 201 Created
        else:
            # Reservation exists - Verify ownership before updating
            if current_reservation.get("botName") != bot_name:
                logging.error(f"Update Auth Fail: {bot_name} tried to update {server_id} owned by {current_reservation.get('botName')}")
                return jsonify({"error": "Reservation owned by another bot"}), 403

            # Check if any data actually changed
            updated = False
            if new_status is not None and current_reservation.get('status') != new_status:
                current_reservation['status'] = new_status
                updated = True
            if current_player_count is not None and current_reservation.get('currentPlayerCount') != current_player_count:
                current_reservation['currentPlayerCount'] = current_player_count
                updated = True

            # ALWAYS update the timestamp on any valid update/heartbeat to keep it alive
            current_reservation['timestamp'] = time.time()

            if updated:
                logging.info(f"Update Success: {bot_name} updated {server_id} (status={current_reservation['status']}, players={current_reservation['currentPlayerCount']})")
            else:
                 # If nothing changed, it's just a heartbeat
                 logging.debug(f"Heartbeat Received: {bot_name} for {server_id}")

            response_data = current_reservation
            status_code = 200 # 200 OK

    # Redact the response before sending
    redacted_response = redact_reservation_info(response_data)
    return jsonify(redacted_response), status_code


@app.route('/reservations/release', methods=['DELETE'])
def release_reservation():
    """Allows a bot to explicitly release its server reservation."""
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']

    with data_lock: # Modify in-memory reservations
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
            # If not found, it might have timed out or been released already.
            # This is not an error from the client's perspective.
            logging.warning(f"Release Not Found: {server_id} by {bot_name} - already gone?")
            return jsonify({"message": "Reservation not found or already released"}), 200 # Return 200 OK

        # Verify ownership before deleting
        if current_reservation.get("botName") != bot_name:
            logging.error(f"Release Auth Fail: {bot_name} tried to release {server_id} owned by {current_reservation.get('botName')}")
            return jsonify({"error": "Reservation owned by another bot"}), 403

        # Owner matches, proceed with deletion
        del reservations[server_id]
        logging.info(f"Release Success: {bot_name} released reservation for {server_id}")
        return jsonify({"message": "Reservation released successfully"}), 200


# --- Fling Reporting & Real-time Feed ---
@app.route('/stats/increment_fling', methods=['POST'])
def increment_fling_count():
    """Increments fling count, logs to disk, and emits Socket.IO event."""
    global total_flings_reported
    data = request.get_json()

    # Extract details from the request payload sent by Luau script
    target_name = data.get('target', 'Unknown') if data else 'Unknown'
    bot_name = data.get('botName', 'Unknown') if data else 'Unknown'
    server_id = data.get('serverId', 'Unknown') if data else 'Unknown'
    timestamp = time.time()

    # Increment the in-memory counter (used for quick stats)
    with data_lock:
        total_flings_reported += 1
        current_count = total_flings_reported

    # Prepare the event data for logging and Socket.IO emission
    fling_event = {
        "timestamp": timestamp,
        "botName": bot_name,
        "serverId": server_id,
        "target": target_name,
        "total_at_event": current_count # Include the total count at the time of the event
    }

    # --- Append event to the history file on disk ---
    try:
        # Use file_lock to prevent concurrent writes from multiple bots
        with file_lock:
             # 'a' mode appends; creates file if it doesn't exist (handled at startup)
             with open(FLING_HISTORY_FILE, 'a', encoding='utf-8') as f:
                json.dump(fling_event, f) # Write the event object as a JSON string
                f.write('\n') # Add a newline to make it JSON Lines format
        # Log success only if write succeeds
        logging.info(f"Fling reported by {bot_name} on {server_id} for {target_name}. Total: {current_count}. Saved to history.")
    except IOError as e:
        # Log the error but don't stop the request just because file write failed
        logging.error(f"Failed to write fling event to {FLING_HISTORY_FILE}: {e}")

    # --- Emit event via Socket.IO to update live feed ---
    try:
        # Emit the event named 'new_fling' with the fling_event data
        # broadcast=True ensures all connected dashboard clients receive it
        socketio.emit('new_fling', fling_event, broadcast=True)
        logging.info(f"Emitted 'new_fling' event via Socket.IO.")
    except Exception as e:
        # Log any errors during the emit process
        logging.error(f"Error emitting Socket.IO event: {e}")

    # Return the current total fling count (from the in-memory counter)
    return jsonify({"message": "Fling count incremented", "totalFlings": current_count}), 200


# --- Dashboard Page Route ---
@app.route('/dashboard', methods=['GET'])
def serve_dashboard_page():
    """Serves the main HTML dashboard page."""
    # @login_required decorator will be added here later when login is implemented
    logging.info("Serving dashboard HTML page.")
    return render_template('dashboard.html')


# --- Overall Stats API Endpoint (for Dashboard Polling) ---
@app.route('/', methods=['GET'])
def get_stats_data():
    """Returns overall statistics aggregated from current reservations and counters."""
    bot_names = set()
    server_count = 0
    bots_by_region = defaultdict(set)
    now = time.time()
    current_total_flings = 0 # Will be fetched from in-memory counter

    logging.debug("Calculating stats for / endpoint.")
    with data_lock: # Lock required for accessing reservations and stats calc data
        # --- Calculate Bot/Server Counts from Reservations ---
        reservations = shared_data.get("serverReservations", {})
        # Filter out stale reservations *before* calculating counts
        valid_reservations = {sid: res for sid, res in reservations.items() if not is_reservation_stale(res)[0]}

        for server_id, res in valid_reservations.items():
            bot_name = res.get("botName", "UnknownBot")
            region = res.get("region", "UnknownRegion")
            bot_names.add(bot_name)
            bots_by_region[region].add(bot_name)
            # server_count is simply the number of valid reservations
        server_count = len(valid_reservations)
        bot_count = len(bot_names)
        regional_bot_counts = {region: len(bots) for region, bots in bots_by_region.items()}

        # --- Get Total Flings from the In-Memory Counter ---
        current_total_flings = total_flings_reported

        # --- Calculate Fling Rate (Based on In-Memory Counter Changes) ---
        last_calc = shared_data["last_stats_calc"]
        time_diff = now - last_calc["time"]
        # Calculate difference based on the current in-memory total
        fling_diff = current_total_flings - last_calc["fling_count"]

        fling_rate_per_minute = 0.0
        # Ensure enough time (>1 sec) has passed for a meaningful rate calculation
        if last_calc["time"] > 0 and time_diff > 1:
            flings_per_second = fling_diff / time_diff
            fling_rate_per_minute = max(0.0, flings_per_second * 60) # Prevent negative rates

        # Update the last calculation timestamp and count *using the current in-memory total*
        shared_data["last_stats_calc"]["time"] = now
        shared_data["last_stats_calc"]["fling_count"] = current_total_flings

        # --- Prepare the final statistics dictionary ---
        stats_data = {
            "botCount": bot_count,
            "serverCount": server_count,
            "totalFlings": current_total_flings, # Use the live in-memory count
            "flingRatePerMinute": fling_rate_per_minute,
            "botsPerRegion": regional_bot_counts
        }

    logging.debug(f"Returning stats: {stats_data}")
    return jsonify(stats_data)


# --- Socket.IO Event Handlers ---
@socketio.on('connect')
def handle_connect():
    """Logs when a client connects via Socket.IO."""
    logging.info(f"Client connected via Socket.IO: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    """Logs when a client disconnects from Socket.IO."""
    logging.info(f"Client disconnected from Socket.IO: {request.sid}")

@socketio.on_error_default # Catches errors from any namespace if not handled elsewhere
def default_error_handler(e):
    """Logs default Socket.IO errors."""
    logging.error(f"Socket.IO Error: {e} (SID: {request.sid if request else 'N/A'})")


# --- Start Background Thread & Server ---
# Start the cleanup thread (runs in the background)
cleanup_thread = threading.Thread(target=cleanup_stale_reservations, daemon=True)
cleanup_thread.start()
logging.info("Background reservation cleanup thread started.")

# Main entry point
if __name__ == '__main__':
    logging.info("Starting TCD-API with Socket.IO and Disk Storage...")
    # Use socketio.run() to start the server correctly with WebSocket support
    # Make sure debug=False and use_reloader=False for production with eventlet/gevent
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, use_reloader=False)