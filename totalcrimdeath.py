# totalcrimdeath.py
from flask import Flask, request, jsonify, render_template
from flask_socketio import SocketIO
import time
import threading
import logging
from collections import defaultdict
import os
import json
# REMOVED: from queue import Queue
# REMOVED: import atexit
# REMOVED: import queue

# REMOVED: DISK_MOUNT_PATH, FLING_HISTORY_DIR, FLING_HISTORY_FILE definitions

app = Flask(__name__, template_folder='templates', static_folder='static')
app.config['SECRET_KEY'] = os.environ.get('FLASK_SECRET_KEY', 'a_very_strong_default_secret_key_for_dev_!@#$%')

socketio = SocketIO(app, async_mode='eventlet', cors_allowed_origins="*")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# REMOVED: Storage setup block (try...except OSError for creating directories/files)

# --- Configuration ---
SERVER_RESERVATION_TIMEOUT = 30
IN_SERVER_TIMEOUT_SECONDS = 30 * 60
CLEANUP_INTERVAL = 60
# --- End Configuration ---

# --- Shared State ---
shared_data = {
    "serverReservations": {},
    "last_stats_calc": {"time": 0, "fling_count": 0} # fling_count here will reset on restart
}
total_flings_reported = 0 # In-memory counter, resets on restart
data_lock = threading.Lock()
# --- End Shared State ---

# REMOVED: Fling writer queue, stop event, worker function, thread start, shutdown handler, atexit registration

# --- Helper Functions ---
def redact_reservation_info(reservation):
    if not reservation:
        return None
    redacted_res = reservation.copy()
    if "botName" in redacted_res:
        redacted_res["botName"] = "[REDACTED]"
    return redacted_res

def is_reservation_stale(reservation):
    now = time.time()
    timestamp = reservation.get('timestamp', 0)
    status = reservation.get('status', 'reserved')

    if status == 'reserved' and (now - timestamp > SERVER_RESERVATION_TIMEOUT):
        return True, f"Initial reservation timed out (>{SERVER_RESERVATION_TIMEOUT}s)"
    if status in ['active', 'flinging'] and (now - timestamp > IN_SERVER_TIMEOUT_SECONDS):
         return True, f"'{status}' status timed out (>{IN_SERVER_TIMEOUT_SECONDS / 60:.1f} mins)"
    return False, ""
# --- End Helper Functions ---


# --- Background Task (Cleanup Stale Reservations - unchanged) ---
def cleanup_stale_reservations():
    while True:
        time.sleep(CLEANUP_INTERVAL)
        removed_count = 0
        stale_ids_to_remove = []
        logging.debug("Cleanup: Starting check for stale reservations...")
        with data_lock:
            reservations = shared_data.get("serverReservations", {})
            for server_id, res in list(reservations.items()):
                is_stale, reason = is_reservation_stale(res)
                if is_stale:
                    logging.info(f"Cleanup: Marking stale reservation for {server_id} by bot '{res.get('botName', 'N/A')}'. Reason: {reason}")
                    stale_ids_to_remove.append(server_id)

            for server_id in stale_ids_to_remove:
                if server_id in reservations:
                    del reservations[server_id]
                    removed_count += 1
        if removed_count > 0:
            logging.info(f"Cleanup: Removed {removed_count} stale reservations.")
        else:
             logging.debug("Cleanup: No stale reservations found.")

cleanup_thread = threading.Thread(target=cleanup_stale_reservations, daemon=True)
cleanup_thread.start()
logging.info("Background reservation cleanup thread started.")
# --- End Background Task ---


# --- Flask Routes (Reservation routes - unchanged) ---
@app.route('/reservations', methods=['GET'])
def get_reservations():
    valid_reservations_list = []
    redacted_list = []
    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        for server_id, res in reservations.items():
             is_stale, _ = is_reservation_stale(res)
             if not is_stale:
                 valid_reservations_list.append(res)
    valid_reservations_list.sort(key=lambda x: x.get('timestamp', 0), reverse=True)
    for res in valid_reservations_list:
        redacted_list.append(redact_reservation_info(res))
    return jsonify(redacted_list)

@app.route('/reservations/reserve', methods=['POST'])
def reserve_server():
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']
    region = data.get('region', 'Unknown')
    initial_player_count = data.get('initialPlayerCount', -1)

    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        existing_reservation_to_release = None
        for s_id, res in reservations.items():
            if res.get("botName") == bot_name and s_id != server_id:
                logging.warning(f"Reserve: Bot '{bot_name}' reserving {server_id} but already holds {s_id}. Releasing old.")
                existing_reservation_to_release = s_id
                break
        if existing_reservation_to_release and existing_reservation_to_release in reservations:
            del reservations[existing_reservation_to_release]

        current_reservation = reservations.get(server_id)
        if current_reservation:
             is_stale, _ = is_reservation_stale(current_reservation)
             if not is_stale and current_reservation.get("botName") != bot_name:
                 logging.warning(f"Reserve Conflict: {server_id} already reserved by '{current_reservation.get('botName')}' (requester: '{bot_name}')")
                 error_response = {"error": "Server already reserved", "reservedBy": redact_reservation_info(current_reservation).get("botName")}
                 return jsonify(error_response), 409

        new_reservation = {
            "serverId": server_id, "botName": bot_name, "timestamp": time.time(),
            "status": "reserved", "region": region,
            "initialPlayerCount": initial_player_count, "currentPlayerCount": None
        }
        reservations[server_id] = new_reservation
        logging.info(f"Reserve Success: Bot '{bot_name}' reserved {server_id} in region '{region}'")
        return jsonify(redact_reservation_info(new_reservation)), 201

@app.route('/reservations/update', methods=['PUT', 'PATCH'])
def update_reservation():
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']
    new_status = data.get('status')
    current_player_count = data.get('currentPlayerCount')

    if new_status is not None and new_status not in ['active', 'flinging']:
         return jsonify({"error": "Invalid status. Must be 'active' or 'flinging'."}), 400

    response_data = None
    status_code = 200

    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
             logging.warning(f"Update: Reservation for {server_id} by bot '{bot_name}' not found. Creating.")
             new_reservation = {
                 "serverId": server_id, "botName": bot_name, "timestamp": time.time(),
                 "status": new_status or "active",
                 "region": data.get('region', 'Unknown'),
                 "initialPlayerCount": current_player_count,
                 "currentPlayerCount": current_player_count
             }
             reservations[server_id] = new_reservation
             response_data = new_reservation
             status_code = 201
        else:
            if current_reservation.get("botName") != bot_name:
                logging.error(f"Update Auth Fail: Bot '{bot_name}' tried to update {server_id} owned by '{current_reservation.get('botName')}'")
                return jsonify({"error": "Reservation owned by another bot"}), 403

            updated = False
            if new_status is not None and current_reservation.get('status') != new_status:
                current_reservation['status'] = new_status
                updated = True
                logging.info(f"Update: Bot '{bot_name}' changed status for {server_id} to '{new_status}'")
            if current_player_count is not None and current_reservation.get('currentPlayerCount') != current_player_count:
                current_reservation['currentPlayerCount'] = current_player_count
                updated = True

            current_reservation['timestamp'] = time.time()

            if updated:
                logging.debug(f"Update Success: Bot '{bot_name}' updated {server_id} (status={current_reservation['status']}, players={current_reservation['currentPlayerCount']})")
            else:
                 logging.debug(f"Heartbeat Received: Bot '{bot_name}' for {server_id}")

            response_data = current_reservation
            status_code = 200

    redacted_response = redact_reservation_info(response_data)
    return jsonify(redacted_response), status_code

@app.route('/reservations/release', methods=['DELETE'])
def release_reservation():
    data = request.get_json()
    if not data or 'serverId' not in data or 'botName' not in data:
        return jsonify({"error": "Missing serverId or botName"}), 400

    server_id = data['serverId']
    bot_name = data['botName']

    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
            logging.warning(f"Release Ignored: Reservation for {server_id} by bot '{bot_name}' not found.")
            return jsonify({"message": "Reservation not found or already released"}), 200

        if current_reservation.get("botName") != bot_name:
            logging.error(f"Release Auth Fail: Bot '{bot_name}' tried to release {server_id} owned by '{current_reservation.get('botName')}'")
            return jsonify({"error": "Reservation owned by another bot"}), 403

        del reservations[server_id]
        logging.info(f"Release Success: Bot '{bot_name}' released reservation for {server_id}")
        return jsonify({"message": "Reservation released successfully"}), 200


@app.route('/stats/increment_fling', methods=['POST'])
def increment_fling_count():
    """Increments the in-memory fling counter and emits SocketIO event. NO DISK STORAGE."""
    request_start_time = time.time()
    global total_flings_reported
    data = request.get_json()

    target_name = data.get('target', 'Unknown') if data else 'Unknown'
    bot_name = data.get('botName', 'Unknown') if data else 'Unknown'
    server_id = data.get('serverId', 'Unknown') if data else 'Unknown'
    timestamp = time.time()

    # --- Update shared in-memory counter quickly ---
    with data_lock:
        total_flings_reported += 1
        current_total_count = total_flings_reported
    # --- Release data_lock ---

    # Prepare event data for socket emission
    fling_event = {
        "timestamp": timestamp,
        "botName": bot_name,
        "serverId": server_id,
        "target": target_name,
        "total_at_event": current_total_count
    }

    # REMOVED: Queueing for file writing

    logging.info(f"Fling reported by '{bot_name}' on {server_id} for '{target_name}'. New total (in-memory): {current_total_count}.")

    # Emit via Socket.IO
    try:
        socketio.emit('new_fling', fling_event)
        logging.debug(f"Emitted 'new_fling' event via Socket.IO for target '{target_name}'.")
    except Exception as e:
        logging.error(f"Error emitting Socket.IO event 'new_fling': {e}", exc_info=True)

    request_end_time = time.time()
    logging.debug(f"Fling Inc: Request handled in {request_end_time - request_start_time:.4f}s (No Disk IO)")

    # Respond quickly
    # Message updated to reflect no persistent storage
    return jsonify({"message": "Fling count incremented (in-memory)", "totalFlings": current_total_count}), 200


@app.route('/dashboard', methods=['GET'])
def serve_dashboard_page():
    logging.info("Serving dashboard HTML page.")
    return render_template('dashboard.html')


@app.route('/', methods=['GET'])
def get_stats_data():
    stats_start_time = time.time()
    bot_names = set()
    server_count = 0
    bots_by_region = defaultdict(set)
    now = time.time()
    current_total_flings = 0 # Will be read from in-memory counter

    logging.debug("Calculating stats for / endpoint.")
    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        valid_reservations = {sid: res for sid, res in reservations.items() if not is_reservation_stale(res)[0]}

        for server_id, res in valid_reservations.items():
            bot_name = res.get("botName", "UnknownBot")
            region = res.get("region", "UnknownRegion")
            bot_names.add(bot_name)
            bots_by_region[region].add(bot_name)

        server_count = len(valid_reservations)
        bot_count = len(bot_names)
        regional_bot_counts = {region: len(bots) for region, bots in bots_by_region.items()}

        # Get current total flings from the in-memory counter
        current_total_flings = total_flings_reported # THIS VALUE RESETS ON RESTART

        # Calculate fling rate
        last_calc = shared_data["last_stats_calc"]
        time_diff = now - last_calc["time"]
        # Calculate diff against the in-memory counter, which might have reset
        fling_diff = current_total_flings - last_calc["fling_count"]

        fling_rate_per_minute = 0.0
        if last_calc["time"] > 0 and time_diff > 1:
            # If fling_diff is massively negative, it means the counter reset.
            # Report 0 rate in that case or rate since restart might be more accurate.
            # For simplicity, just cap at 0. A more complex approach could detect resets.
            if fling_diff < 0 and abs(fling_diff) > last_calc["fling_count"] * 0.5: # Heuristic for reset detection
                 logging.warning(f"Potential fling counter reset detected (last={last_calc['fling_count']}, current={current_total_flings}). Rate calculation might be inaccurate until next interval.")
                 fling_diff = 0 # Or calculate rate based only on current_total_flings if last_calc["time"] is recent?

            flings_per_second = max(0.0, fling_diff / time_diff) # Ensure non-negative rate calc
            fling_rate_per_minute = flings_per_second * 60

        # Update last calculation stats
        shared_data["last_stats_calc"]["time"] = now
        shared_data["last_stats_calc"]["fling_count"] = current_total_flings
    # --- Release data_lock ---

    stats_data = {
        "botCount": bot_count,
        "serverCount": server_count,
        "totalFlings": current_total_flings, # Remember this resets
        "flingRatePerMinute": fling_rate_per_minute,
        "botsPerRegion": regional_bot_counts
    }

    stats_end_time = time.time()
    logging.debug(f"Stats calculation took {stats_end_time - stats_start_time:.4f}s. Returning: {stats_data}")
    return jsonify(stats_data)
# --- End Flask Routes ---


# --- Socket.IO Event Handlers (unchanged) ---
@socketio.on('connect')
def handle_connect():
    logging.info(f"Client connected via Socket.IO: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    logging.info(f"Client disconnected from Socket.IO: {request.sid}")

@socketio.on_error_default
def default_error_handler(e):
    sid = request.sid if request else 'N/A'
    logging.error(f"Socket.IO Error: {e} (SID: {sid})", exc_info=True)
# --- End Socket.IO Handlers ---


# --- Main Execution ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    logging.info(f"Starting TCD-API (In-Memory Fling Count) with Socket.IO on port {port}...")
    try:
        socketio.run(app, host='0.0.0.0', port=port, debug=False, use_reloader=False)
    except Exception as e:
         logging.critical(f"Failed to start SocketIO server: {e}", exc_info=True)
         # No writer thread to shut down anymore
         exit(1)
# --- End Main Execution ---