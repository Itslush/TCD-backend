# totalcrimdeath.py
from flask import Flask, request, jsonify, render_template
from flask_socketio import SocketIO
import time
import threading
import logging
from collections import defaultdict
import os
import json
from queue import Queue # Import Queue
import atexit         # To ensure queue is processed on exit (best effort)
import queue          # Needed for queue.Empty exception

DISK_MOUNT_PATH = "/data"
FLING_HISTORY_DIR = os.path.join(DISK_MOUNT_PATH, "flings")
FLING_HISTORY_FILE = os.path.join(FLING_HISTORY_DIR, "flings_history.jsonl")

app = Flask(__name__, template_folder='templates', static_folder='static')
app.config['SECRET_KEY'] = os.environ.get('FLASK_SECRET_KEY', 'a_very_strong_default_secret_key_for_dev_!@#$%')

# Using eventlet for async operations with SocketIO
socketio = SocketIO(app, async_mode='eventlet', cors_allowed_origins="*")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Ensure Storage Directory Exists ---
try:
    os.makedirs(FLING_HISTORY_DIR, exist_ok=True)
    logging.info(f"Ensured storage directory exists: {FLING_HISTORY_DIR}")

    # Touch the file to ensure it exists (worker thread will append)
    if not os.path.exists(FLING_HISTORY_FILE):
        with open(FLING_HISTORY_FILE, 'w') as f:
            pass # Create empty file
        logging.info(f"Created empty fling history file: {FLING_HISTORY_FILE}")

except OSError as e:
    logging.error(f"FATAL: Could not create storage directories/files in {DISK_MOUNT_PATH}. Check disk mount and permissions. Error: {e}")
    # Consider exiting if storage is critical and fails to initialize
    # exit(1)
# --- End Storage Setup ---

# --- Configuration ---
SERVER_RESERVATION_TIMEOUT = 30  # Seconds for initial reservation
IN_SERVER_TIMEOUT_SECONDS = 30 * 60 # 30 minutes for active/flinging status
CLEANUP_INTERVAL = 60           # Seconds between cleanup checks
# --- End Configuration ---

# --- Shared State ---
shared_data = {
    "serverReservations": {},
    "last_stats_calc": {"time": 0, "fling_count": 0}
}
total_flings_reported = 0 # In-memory counter, source of truth for immediate stats
data_lock = threading.Lock() # Protects shared_data and total_flings_reported
# --- End Shared State ---

# --- Add a Queue and a Worker Thread for Fling Writes ---
fling_write_queue = Queue()
_stop_event = threading.Event()

def fling_writer_worker():
    """Pulls fling events from a queue and writes them to the history file."""
    logging.info("Fling Writer Thread started.")
    while not _stop_event.is_set() or not fling_write_queue.empty(): # Process queue fully on stop
        try:
            # Wait up to 1 second for an item
            fling_event = fling_write_queue.get(timeout=1)
            try:
                # Write the event to the JSONL file
                # No need for file_lock here as this is the only writer
                with open(FLING_HISTORY_FILE, 'a', encoding='utf-8') as f:
                    json.dump(fling_event, f)
                    f.write('\n')
                logging.debug(f"Fling Writer: Successfully wrote event for target '{fling_event.get('target')}'")
                fling_write_queue.task_done()
            except IOError as e:
                logging.error(f"Fling Writer: Failed to write fling event to {FLING_HISTORY_FILE}: {e}")
                # Optional: Implement retry logic or move to a dead-letter queue
                fling_write_queue.task_done() # Mark done even on error to prevent blocking shutdown
            except Exception as e:
                logging.error(f"Fling Writer: Unexpected error during write: {e}", exc_info=True)
                fling_write_queue.task_done() # Mark done even on error
        except queue.Empty:
            # Timed out waiting for an item, loop again and check stop_event
            continue
        except Exception as e:
            # Handle potential errors from queue.get or stop_event logic
            logging.error(f"Fling Writer: Error in main loop: {e}", exc_info=True)
            time.sleep(1) # Avoid busy-looping on unexpected errors
    logging.info(f"Fling Writer Thread finished. Queue empty: {fling_write_queue.empty()}")

# Start the worker thread
fling_writer_thread = threading.Thread(target=fling_writer_worker, daemon=True) # Daemon allows main thread to exit
fling_writer_thread.start()

# Ensure queue is flushed on shutdown (best effort)
def shutdown_handler():
    """Signals the writer thread to stop and waits for it briefly."""
    logging.info("Shutdown triggered. Signaling fling writer to stop...")
    _stop_event.set()
    try:
        # Give the writer some time to finish processing the queue
        fling_writer_thread.join(timeout=5.0)
        if fling_writer_thread.is_alive():
             logging.warning("Fling writer thread did not finish in time.")
        else:
             logging.info("Fling writer thread stopped.")
    except Exception as e:
         logging.error(f"Error during fling writer shutdown: {e}", exc_info=True)
    logging.info(f"Exiting. {fling_write_queue.qsize()} items may remain in fling queue.")

atexit.register(shutdown_handler)
# --- End Queue and Worker Thread ---


# --- Helper Functions ---
def redact_reservation_info(reservation):
    """Creates a copy of reservation data with sensitive info redacted."""
    if not reservation:
        return None
    redacted_res = reservation.copy()
    # Redact botName, potentially add others later if needed
    if "botName" in redacted_res:
        redacted_res["botName"] = "[REDACTED]"
    return redacted_res

def is_reservation_stale(reservation):
    """Checks if a reservation has expired based on its status and timestamp."""
    now = time.time()
    timestamp = reservation.get('timestamp', 0)
    status = reservation.get('status', 'reserved')

    if status == 'reserved' and (now - timestamp > SERVER_RESERVATION_TIMEOUT):
        return True, f"Initial reservation timed out (>{SERVER_RESERVATION_TIMEOUT}s)"
    if status in ['active', 'flinging'] and (now - timestamp > IN_SERVER_TIMEOUT_SECONDS):
         return True, f"'{status}' status timed out (>{IN_SERVER_TIMEOUT_SECONDS / 60:.1f} mins)"
    return False, ""
# --- End Helper Functions ---


# --- Background Task ---
def cleanup_stale_reservations():
    """Periodically checks for and removes stale server reservations."""
    while True: # Runs indefinitely in the background
        time.sleep(CLEANUP_INTERVAL)
        removed_count = 0
        stale_ids_to_remove = []
        logging.debug("Cleanup: Starting check for stale reservations...")
        with data_lock: # Lock access to shared reservation data
            reservations = shared_data.get("serverReservations", {})
            # Iterate over a copy of items to allow deletion during iteration
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
        # Log results outside the lock
        if removed_count > 0:
            logging.info(f"Cleanup: Removed {removed_count} stale reservations.")
        else:
             logging.debug("Cleanup: No stale reservations found.")

# Start the cleanup thread
cleanup_thread = threading.Thread(target=cleanup_stale_reservations, daemon=True)
cleanup_thread.start()
logging.info("Background reservation cleanup thread started.")
# --- End Background Task ---


# --- Flask Routes ---
@app.route('/reservations', methods=['GET'])
def get_reservations():
    """Returns a list of current, non-stale, redacted reservations."""
    valid_reservations_list = []
    redacted_list = []
    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        for server_id, res in reservations.items():
             is_stale, _ = is_reservation_stale(res)
             if not is_stale:
                 valid_reservations_list.append(res) # Add the original, non-redacted data

    # Sort outside the lock
    valid_reservations_list.sort(key=lambda x: x.get('timestamp', 0), reverse=True)

    # Redact after sorting
    for res in valid_reservations_list:
        redacted_list.append(redact_reservation_info(res))

    return jsonify(redacted_list)

@app.route('/reservations/reserve', methods=['POST'])
def reserve_server():
    """Allows a bot to reserve a server."""
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName'] # Keep original case from request
    region = data.get('region', 'Unknown')
    initial_player_count = data.get('initialPlayerCount', -1) # Optional player count

    with data_lock:
        reservations = shared_data.get("serverReservations", {})

        # Check if this bot already has another reservation and release it
        existing_reservation_to_release = None
        for s_id, res in reservations.items():
            # Case-sensitive comparison for bot names is generally safer
            if res.get("botName") == bot_name and s_id != server_id:
                logging.warning(f"Reserve: Bot '{bot_name}' reserving {server_id} but already holds {s_id}. Releasing old.")
                existing_reservation_to_release = s_id
                break # Assume only one other reservation per bot
        if existing_reservation_to_release and existing_reservation_to_release in reservations:
            del reservations[existing_reservation_to_release]

        # Check if the target server is currently reserved by someone else
        current_reservation = reservations.get(server_id)
        if current_reservation:
             is_stale, _ = is_reservation_stale(current_reservation)
             # Only conflict if it's not stale AND it's a different bot
             if not is_stale and current_reservation.get("botName") != bot_name:
                 logging.warning(f"Reserve Conflict: {server_id} already reserved by '{current_reservation.get('botName')}' (requester: '{bot_name}')")
                 # Return redacted info about the current holder
                 error_response = {"error": "Server already reserved", "reservedBy": redact_reservation_info(current_reservation).get("botName")}
                 return jsonify(error_response), 409 # 409 Conflict

        # Create or overwrite the reservation for this serverId
        new_reservation = {
            "serverId": server_id,
            "botName": bot_name, # Store the original bot name
            "timestamp": time.time(),
            "status": "reserved",
            "region": region,
            "initialPlayerCount": initial_player_count,
            "currentPlayerCount": None # Not known at reservation time
        }
        reservations[server_id] = new_reservation
        logging.info(f"Reserve Success: Bot '{bot_name}' reserved {server_id} in region '{region}'")

        # Return the redacted version of the newly created reservation
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

    if new_status is not None and new_status not in ['active', 'flinging']:
         return jsonify({"error": "Invalid status. Must be 'active' or 'flinging'."}), 400

    response_data = None
    status_code = 200 # Default to 200 OK for updates

    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
            # If not found, maybe it timed out or was never reserved?
            # Option 1: Reject update (safer)
            # logging.warning(f"Update Rejected: Reservation for {server_id} by bot '{bot_name}' not found.")
            # return jsonify({"error": "Reservation not found or expired"}), 404

            # Option 2: Create it (more lenient, as implemented before)
             logging.warning(f"Update: Reservation for {server_id} by bot '{bot_name}' not found. Creating.")
             new_reservation = {
                 "serverId": server_id, "botName": bot_name, "timestamp": time.time(),
                 "status": new_status or "active", # Default to active if creating on update
                 "region": data.get('region', current_reservation.get('region', 'Unknown') if current_reservation else 'Unknown'), # Try to preserve region
                 "initialPlayerCount": current_player_count, # Use current count as initial if creating
                 "currentPlayerCount": current_player_count
             }
             reservations[server_id] = new_reservation
             response_data = new_reservation
             status_code = 201 # Created
        else:
            # Verify the bot owns the reservation
            if current_reservation.get("botName") != bot_name:
                logging.error(f"Update Auth Fail: Bot '{bot_name}' tried to update {server_id} owned by '{current_reservation.get('botName')}'")
                return jsonify({"error": "Reservation owned by another bot"}), 403 # 403 Forbidden

            # Update fields if provided
            updated = False
            if new_status is not None and current_reservation.get('status') != new_status:
                current_reservation['status'] = new_status
                updated = True
                logging.info(f"Update: Bot '{bot_name}' changed status for {server_id} to '{new_status}'")
            if current_player_count is not None and current_reservation.get('currentPlayerCount') != current_player_count:
                current_reservation['currentPlayerCount'] = current_player_count
                updated = True
                # Avoid logging every player count change if too noisy
                # logging.info(f"Update: Bot '{bot_name}' updated player count for {server_id} to {current_player_count}")


            # Always update timestamp to prevent timeout (heartbeat)
            current_reservation['timestamp'] = time.time()

            if updated:
                logging.debug(f"Update Success: Bot '{bot_name}' updated {server_id} (status={current_reservation['status']}, players={current_reservation['currentPlayerCount']})")
            else:
                 logging.debug(f"Heartbeat Received: Bot '{bot_name}' for {server_id}")

            response_data = current_reservation
            status_code = 200 # OK

    # Return redacted response
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

    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
            # Not an error if it's already gone (e.g., timed out)
            logging.warning(f"Release Ignored: Reservation for {server_id} by bot '{bot_name}' not found (already released or timed out?).")
            return jsonify({"message": "Reservation not found or already released"}), 200 # OK, desired state achieved

        # Verify ownership
        if current_reservation.get("botName") != bot_name:
            logging.error(f"Release Auth Fail: Bot '{bot_name}' tried to release {server_id} owned by '{current_reservation.get('botName')}'")
            return jsonify({"error": "Reservation owned by another bot"}), 403 # Forbidden

        # Delete the reservation
        del reservations[server_id]
        logging.info(f"Release Success: Bot '{bot_name}' released reservation for {server_id}")
        return jsonify({"message": "Reservation released successfully"}), 200 # OK


@app.route('/stats/increment_fling', methods=['POST'])
def increment_fling_count():
    """Increments the fling counter, queues data for writing, and emits SocketIO event."""
    request_start_time = time.time()
    global total_flings_reported
    data = request.get_json()

    # Extract data safely
    target_name = data.get('target', 'Unknown') if data else 'Unknown'
    bot_name = data.get('botName', 'Unknown') if data else 'Unknown'
    server_id = data.get('serverId', 'Unknown') if data else 'Unknown'
    timestamp = time.time()

    # --- Update shared in-memory counter quickly ---
    with data_lock:
        total_flings_reported += 1
        current_total_count = total_flings_reported # Capture count after increment
    # --- Release data_lock ---

    # Prepare event data for queue and socket emission
    fling_event = {
        "timestamp": timestamp,
        "botName": bot_name,
        "serverId": server_id,
        "target": target_name,
        "total_at_event": current_total_count # Use the captured total
    }

    # --- Put the event onto the queue for background writing (Non-blocking) ---
    try:
        fling_write_queue.put(fling_event)
        # Log queuing success, not writing success
        logging.info(f"Fling by '{bot_name}' on {server_id} for '{target_name}'. Total: {current_total_count}. Queued for writing.")
    except Exception as e:
         logging.error(f"Failed to queue fling event: {e}", exc_info=True)
    # --- Continue immediately ---

    # Emit via Socket.IO (should be non-blocking with eventlet)
    try:
        # Emit the same event data that was queued
        socketio.emit('new_fling', fling_event)
        logging.debug(f"Emitted 'new_fling' event via Socket.IO for target '{target_name}'.")
    except Exception as e:
        logging.error(f"Error emitting Socket.IO event 'new_fling': {e}", exc_info=True)

    request_end_time = time.time()
    logging.debug(f"Fling Inc: Request handled in {request_end_time - request_start_time:.4f}s (Write deferred)")

    # Respond quickly to the client
    return jsonify({"message": "Fling count incremented (queued)", "totalFlings": current_total_count}), 200


@app.route('/dashboard', methods=['GET'])
def serve_dashboard_page():
    """Serves the main HTML dashboard page."""
    logging.info("Serving dashboard HTML page.")
    return render_template('dashboard.html')


@app.route('/', methods=['GET'])
def get_stats_data():
    """Calculates and returns current operational statistics."""
    stats_start_time = time.time()
    bot_names = set()
    server_count = 0
    bots_by_region = defaultdict(set)
    now = time.time()
    current_total_flings = 0

    logging.debug("Calculating stats for / endpoint.")
    with data_lock: # Lock access to reservations and fling count
        reservations = shared_data.get("serverReservations", {})
        # Filter out stale reservations *within the lock* for consistency
        valid_reservations = {sid: res for sid, res in reservations.items() if not is_reservation_stale(res)[0]}

        # Process valid reservations
        for server_id, res in valid_reservations.items():
            bot_name = res.get("botName", "UnknownBot")
            region = res.get("region", "UnknownRegion")
            bot_names.add(bot_name)
            bots_by_region[region].add(bot_name) # Store bot names per region

        server_count = len(valid_reservations)
        bot_count = len(bot_names) # Count unique bot names
        # Count unique bots per region
        regional_bot_counts = {region: len(bots) for region, bots in bots_by_region.items()}

        # Get current total flings from the in-memory counter
        current_total_flings = total_flings_reported

        # Calculate fling rate based on previous calculation
        last_calc = shared_data["last_stats_calc"]
        time_diff = now - last_calc["time"]
        fling_diff = current_total_flings - last_calc["fling_count"]

        fling_rate_per_minute = 0.0
        # Avoid division by zero and ensure meaningful time difference
        if last_calc["time"] > 0 and time_diff > 1:
            flings_per_second = fling_diff / time_diff
            # Ensure rate is not negative (e.g., if counter somehow reset)
            fling_rate_per_minute = max(0.0, flings_per_second * 60)

        # Update last calculation stats *within the lock*
        shared_data["last_stats_calc"]["time"] = now
        shared_data["last_stats_calc"]["fling_count"] = current_total_flings
    # --- Release data_lock ---

    stats_data = {
        "botCount": bot_count,
        "serverCount": server_count,
        "totalFlings": current_total_flings,
        "flingRatePerMinute": fling_rate_per_minute,
        "botsPerRegion": regional_bot_counts
    }

    stats_end_time = time.time()
    logging.debug(f"Stats calculation took {stats_end_time - stats_start_time:.4f}s. Returning: {stats_data}")
    return jsonify(stats_data)
# --- End Flask Routes ---


# --- Socket.IO Event Handlers ---
@socketio.on('connect')
def handle_connect():
    """Logs when a client connects via Socket.IO."""
    logging.info(f"Client connected via Socket.IO: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    """Logs when a client disconnects from Socket.IO."""
    logging.info(f"Client disconnected from Socket.IO: {request.sid}")

@socketio.on_error_default
def default_error_handler(e):
    """Logs default Socket.IO errors."""
    # Check if request context exists before accessing request.sid
    sid = request.sid if request else 'N/A'
    logging.error(f"Socket.IO Error: {e} (SID: {sid})", exc_info=True)
# --- End Socket.IO Handlers ---


# --- Main Execution ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000)) # Use Render's assigned port or default to 5000
    logging.info(f"Starting TCD-API with Socket.IO, Disk Storage, and Fling Writer Thread on port {port}...")
    # Run the SocketIO app with eventlet worker
    # debug=False and use_reloader=False are recommended for production
    try:
        socketio.run(app, host='0.0.0.0', port=port, debug=False, use_reloader=False)
    except Exception as e:
         logging.critical(f"Failed to start SocketIO server: {e}", exc_info=True)
         # Attempt graceful shutdown of writer before exiting
         shutdown_handler()
         exit(1)

# --- End Main Execution ---