import time
import threading
import logging
import os
from flask import Flask, request, jsonify, render_template
from collections import defaultdict, deque

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

app = Flask(__name__, template_folder='templates', static_folder='static')
app.config['SECRET_KEY'] = os.environ.get('FLASK_SECRET_KEY', 'may_criminality_die_i_beg')

SERVER_RESERVATION_TIMEOUT = 30
IN_SERVER_TIMEOUT_SECONDS = 30 * 60
CLEANUP_INTERVAL = 60
MAX_RECENT_FLINGS = 50
MAX_CHAT_LOGS = 1000

shared_data = {
    "serverReservations": {},
    "last_stats_calc": {"time": 0, "fling_count": 0},
    "recent_flings": deque(maxlen=MAX_RECENT_FLINGS),
    "chat_logs": deque(maxlen=MAX_CHAT_LOGS)
}
total_flings_reported = 0
data_lock = threading.Lock()
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

def cleanup_stale_reservations():
    logging.info("Background reservation cleanup thread started.")
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
            logging.debug("Cleanup: No stale reservations found this cycle.")

cleanup_thread = threading.Thread(target=cleanup_stale_reservations, daemon=True)
cleanup_thread.start()

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
                 error_response = {
                     "error": "Server already reserved",
                     "reservedBy": redact_reservation_info(current_reservation).get("botName")
                 }
                 return jsonify(error_response), 409

        new_reservation = {
            "serverId": server_id,
            "botName": bot_name,
            "timestamp": time.time(),
            "status": "reserved",
            "region": region,
            "initialPlayerCount": initial_player_count,
            "currentPlayerCount": None
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
             logging.warning(f"Update: Reservation for {server_id} by bot '{bot_name}' not found or was stale. Creating/Reactivating.")
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
                logging.debug(f"Heartbeat Received (No Change): Bot '{bot_name}' for {server_id}")

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
    request_start_time = time.time()
    global total_flings_reported
    data = request.get_json()

    target_name = data.get('target', 'Unknown') if data else 'Unknown'
    bot_name = data.get('botName', 'Unknown') if data else 'Unknown'
    server_id = data.get('serverId', 'Unknown') if data else 'Unknown'
    timestamp = time.time()

    fling_event = {
        "timestamp": timestamp,
        "botName": bot_name,
        "serverId": server_id,
        "target": target_name,
    }

    with data_lock:
        total_flings_reported += 1
        current_total_count = total_flings_reported
        shared_data["recent_flings"].appendleft(fling_event)

    logging.info(f"Fling reported by '{bot_name}' on {server_id} for '{target_name}'. New total: {current_total_count}.")

    request_end_time = time.time()
    logging.debug(f"Fling Inc Request handled in {request_end_time - request_start_time:.4f}s")

    return jsonify({"message": "Fling count incremented", "totalFlings": current_total_count}), 200

@app.route('/flings', methods=['GET'])
def get_recent_flings():
    with data_lock:
        recent_flings_list = list(shared_data["recent_flings"])
    return jsonify(recent_flings_list)

@app.route('/chatlogs', methods=['POST'])
def receive_chat_log():
    data = request.get_json()

    if not data:
        return jsonify({"error": "Missing JSON payload"}), 400

    player_name = data.get('playerName')
    message = data.get('message')
    bot_name = data.get('botName')

    if not player_name or message is None:
        logging.warning(f"ChatLog Receive Fail: Missing playerName or message field in payload: {data}")
        return jsonify({"error": "Missing required fields: playerName, message"}), 400

    server_id = data.get('serverId')
    client_timestamp = data.get('timestamp')

    log_entry = {
        "received_at": time.time(),
        "client_timestamp": client_timestamp,
        "botName": bot_name,
        "serverId": server_id,
        "playerName": player_name,
        "message": message,
    }

    with data_lock:
        shared_data["chat_logs"].appendleft(log_entry)

    logging.info(f"ChatLog Received: Server='{server_id}', Player='{player_name}'")

    return jsonify({"message": "Chat log received"}), 200

@app.route('/get_chatlogs', methods=['GET'])
def get_chat_logs():

    limit_str = request.args.get('limit', default=str(MAX_CHAT_LOGS), type=str)
    try:
        limit = int(limit_str)
    except ValueError:
        limit = MAX_CHAT_LOGS 
    limit = max(1, min(limit, MAX_CHAT_LOGS))

    with data_lock:
        logs_to_return = list(shared_data["chat_logs"])[:limit]

    return jsonify(logs_to_return)

@app.route('/dashboard', methods=['GET'])
def serve_dashboard_page():
    logging.info("Serving dashboard HTML page.")
    try:
        return render_template('dashboard.html')
    except Exception as e:
        logging.error(f"Error rendering dashboard template: {e}", exc_info=True)
        return "Error loading dashboard.", 500

@app.route('/', methods=['GET'])
@app.route('/stats', methods=['GET'])
def get_stats_data():
    stats_start_time = time.time()
    bot_names = set()
    server_count = 0
    bots_by_region = defaultdict(set)
    now = time.time()
    current_total_flings = 0
    fling_rate_per_minute = 0.0

    logging.debug("Calculating stats for / or /stats endpoint.")
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

        current_total_flings = total_flings_reported
        last_calc = shared_data["last_stats_calc"]
        time_diff = now - last_calc["time"]
        fling_diff = current_total_flings - last_calc["fling_count"]

        if last_calc["time"] > 0 and time_diff > 1:
            if fling_diff < 0 and abs(fling_diff) > last_calc["fling_count"] * 0.5:
                logging.warning(f"Potential fling counter reset detected or large decrease. Old: {last_calc['fling_count']}, New: {current_total_flings}. Rate calculation skipped/reset.")
                fling_diff = 0

            flings_per_second = max(0.0, fling_diff / time_diff)
            fling_rate_per_minute = flings_per_second * 60
        else:
            fling_rate_per_minute = 0.0

        shared_data["last_stats_calc"]["time"] = now
        shared_data["last_stats_calc"]["fling_count"] = current_total_flings

    stats_data = {
        "botCount": bot_count,
        "serverCount": server_count,
        "totalFlings": current_total_flings,
        "flingRatePerMinute": round(fling_rate_per_minute, 2),
        "botsPerRegion": regional_bot_counts
    }

    stats_end_time = time.time()
    logging.debug(f"Stats calculation took {stats_end_time - stats_start_time:.4f}s.")
    return jsonify(stats_data)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    logging.info(f"Starting Flask API on port {port}...")

    app.run(host='0.0.0.0', port=port, debug=False)