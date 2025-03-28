from flask import Flask, request, jsonify, render_template
import time
import threading
import logging
from collections import defaultdict

app = Flask(__name__, template_folder='templates', static_folder='static')

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

SERVER_RESERVATION_TIMEOUT = 30
IN_SERVER_TIMEOUT_SECONDS = 30 * 60
CLEANUP_INTERVAL = 60

shared_data = {
    "serverReservations": {},
    "last_stats_calc": {"time": 0, "fling_count": 0}
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
    while True:
        time.sleep(CLEANUP_INTERVAL)
        removed_count = 0
        logging.debug("Cleanup: Starting check for stale reservations...")
        with data_lock:
            reservations = shared_data.get("serverReservations", {})
            stale_ids_to_remove = []
            for server_id, res in reservations.items():
                is_stale, reason = is_reservation_stale(res)
                if is_stale:
                    logging.info(f"Cleanup: Marking stale reservation for {server_id} by {res.get('botName', 'N/A')}. Reason: {reason}")
                    stale_ids_to_remove.append(server_id)

            for server_id in stale_ids_to_remove:
                if server_id in reservations:
                    del reservations[server_id]
                    removed_count += 1

        if removed_count > 0:
            logging.info(f"Cleanup: Removed {removed_count} stale reservations.")
        else:
             logging.debug("Cleanup: No stale reservations found.")

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
                logging.warning(f"Reserve: Bot {bot_name} reserving {server_id} but already has {s_id}. Releasing old.")
                existing_reservation_to_release = s_id
                break
        if existing_reservation_to_release and existing_reservation_to_release in reservations:
            del reservations[existing_reservation_to_release]


        current_reservation = reservations.get(server_id)
        if current_reservation:
             is_stale, _ = is_reservation_stale(current_reservation)
             if not is_stale and current_reservation.get("botName") != bot_name :
                 logging.warning(f"Reserve Conflict: {server_id} already reserved by {current_reservation.get('botName')}")
                 error_response = {"error": "Server already reserved", "reservedBy": "[REDACTED]"}
                 return jsonify(error_response), 409

        new_reservation = {
            "serverId": server_id, "botName": bot_name, "timestamp": time.time(),
            "status": "reserved", "region": region,
            "initialPlayerCount": initial_player_count, "currentPlayerCount": None
        }
        reservations[server_id] = new_reservation
        logging.info(f"Reserve Success: {bot_name} reserved {server_id}")
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
        reservations = shared_data.get("serverReservations", {});
        current_reservation = reservations.get(server_id)

        if not current_reservation:
            logging.warning(f"Update: Reservation for {server_id} by {bot_name} not found. Creating.")
            new_reservation = {
                "serverId": server_id, "botName": bot_name, "timestamp": time.time(),
                "status": new_status or "active", "region": data.get('region', 'Unknown'),
                "initialPlayerCount": current_player_count,
                "currentPlayerCount": current_player_count
            }
            reservations[server_id] = new_reservation
            response_data = new_reservation
            status_code = 201
        else:
            if current_reservation.get("botName") != bot_name:
                logging.error(f"Update Auth Fail: {bot_name} tried to update {server_id} owned by {current_reservation.get('botName')}")
                return jsonify({"error": "Reservation owned by another bot"}), 403

            updated = False
            if new_status is not None and current_reservation.get('status') != new_status:
                current_reservation['status'] = new_status; updated = True
            if current_player_count is not None and current_reservation.get('currentPlayerCount') != current_player_count:
                current_reservation['currentPlayerCount'] = current_player_count; updated = True

            current_reservation['timestamp'] = time.time()

            if updated:
                logging.info(f"Update Success: {bot_name} updated {server_id} (status={current_reservation['status']}, players={current_reservation['currentPlayerCount']})")
            else:
                 logging.debug(f"Heartbeat Received: {bot_name} for {server_id}")

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
            logging.warning(f"Release Not Found: {server_id} by {bot_name}")
            return jsonify({"message": "Reservation not found or already released"}), 200

        if current_reservation.get("botName") != bot_name:
            logging.error(f"Release Auth Fail: {bot_name} tried to release {server_id} owned by {current_reservation.get('botName')}")
            return jsonify({"error": "Reservation owned by another bot"}), 403

        del reservations[server_id]
        logging.info(f"Release Success: {bot_name} released reservation for {server_id}")
        return jsonify({"message": "Reservation released successfully"}), 200

@app.route('/stats/increment_fling', methods=['POST'])
def increment_fling_count():
    global total_flings_reported
    with data_lock:
        total_flings_reported += 1
        current_count = total_flings_reported
    logging.info(f"Fling reported via API. Total now: {current_count}")
    return jsonify({"message": "Fling count incremented", "totalFlings": current_count}), 200

@app.route('/dashboard', methods=['GET'])
def serve_dashboard_page():
    logging.info("Serving dashboard HTML page.")
    return render_template('dashboard.html')

@app.route('/', methods=['GET'])
def get_stats_data():
    bot_names = set()
    server_count = 0
    bots_by_region = defaultdict(set)
    now = time.time()

    logging.debug("Calculating stats for / endpoint.")
    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        for server_id, res in reservations.items():
            is_stale, _ = is_reservation_stale(res)
            if not is_stale:
                bot_name = res.get("botName", "UnknownBot")
                region = res.get("region", "UnknownRegion")
                bot_names.add(bot_name)
                bots_by_region[region].add(bot_name)
                server_count += 1

        bot_count = len(bot_names)
        regional_bot_counts = {region: len(bots) for region, bots in bots_by_region.items()}

        current_total_flings = total_flings_reported
        last_calc = shared_data["last_stats_calc"]
        time_diff = now - last_calc["time"]
        fling_diff = current_total_flings - last_calc["fling_count"]

        fling_rate_per_minute = 0.0
        if last_calc["time"] > 0 and time_diff > 1:
            flings_per_second = fling_diff / time_diff
            fling_rate_per_minute = flings_per_second * 60
            fling_rate_per_minute = max(0.0, fling_rate_per_minute)

        shared_data["last_stats_calc"]["time"] = now
        shared_data["last_stats_calc"]["fling_count"] = current_total_flings

        stats_data = {
            "botCount": bot_count,
            "serverCount": server_count,
            "totalFlings": current_total_flings,
            "flingRatePerMinute": fling_rate_per_minute,
            "botsPerRegion": regional_bot_counts
        }

    logging.debug(f"Returning stats: {stats_data}")
    return jsonify(stats_data)

cleanup_thread = threading.Thread(target=cleanup_stale_reservations, daemon=True)
cleanup_thread.start()
logging.info("Background cleanup started.")

if __name__ == '__main__':
    logging.info("Starting TCD-API...")
    app.run(host='0.0.0.0', port=5000, debug=False)