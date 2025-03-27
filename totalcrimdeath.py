from flask import Flask, request, jsonify
import time
import threading
import logging

app = Flask(__name__)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

SERVER_RESERVATION_TIMEOUT = 30
IN_SERVER_TIMEOUT_SECONDS = 30 * 60
CLEANUP_INTERVAL = 60

shared_data = {
    "serverReservations": {}
}

total_flings_reported = 0
data_lock = threading.Lock()

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
    with data_lock:
        valid_reservations = {}
        for server_id, res in shared_data.get("serverReservations", {}).items():
             is_stale, _ = is_reservation_stale(res)
             if not is_stale:
                 valid_reservations[server_id] = res
        return jsonify(valid_reservations)

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
                logging.warning(f"Reserve: Bot {bot_name} reserving {server_id} but already has {s_id}. Releasing old reservation.")
                existing_reservation_to_release = s_id
                break

        if existing_reservation_to_release:
             if existing_reservation_to_release in reservations:
                 del reservations[existing_reservation_to_release]

        current_reservation = reservations.get(server_id)
        if current_reservation:
             is_stale, _ = is_reservation_stale(current_reservation)
             if not is_stale and current_reservation.get("botName") != bot_name :
                 logging.warning(f"Reserve Conflict: {server_id} already reserved by {current_reservation.get('botName')}")
                 return jsonify({"error": "Server already reserved", "reservedBy": current_reservation.get('botName')}), 409

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
        logging.info(f"Reserve Success: {bot_name} reserved {server_id}")
        return jsonify(new_reservation), 201

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
         return jsonify({"error": "Invalid status provided. Must be 'active' or 'flinging'."}), 400

    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        current_reservation = reservations.get(server_id)

        if not current_reservation:
            logging.warning(f"Update: Reservation for {server_id} by {bot_name} not found. Creating based on update data.")
            new_reservation = {
                "serverId": server_id,
                "botName": bot_name,
                "timestamp": time.time(),
                "status": new_status or "active",
                "region": data.get('region', 'Unknown'),
                "initialPlayerCount": current_player_count,
                "currentPlayerCount": current_player_count
            }
            reservations[server_id] = new_reservation
            return jsonify(new_reservation), 201

        if current_reservation.get("botName") != bot_name:
            logging.error(f"Update Auth Fail: {bot_name} tried to update reservation for {server_id} owned by {current_reservation.get('botName')}")
            return jsonify({"error": "Reservation owned by another bot"}), 403


        updated = False
        if new_status is not None and current_reservation.get('status') != new_status:
             current_reservation['status'] = new_status
             updated = True
        if current_player_count is not None and current_reservation.get('currentPlayerCount') != current_player_count:
             current_reservation['currentPlayerCount'] = current_player_count
             updated = True

        current_reservation['timestamp'] = time.time()

        if updated:
             logging.info(f"Update Success: {bot_name} updated {server_id} (status={current_reservation['status']}, players={current_reservation['currentPlayerCount']})")
        else:
             logging.debug(f"Heartbeat Received: {bot_name} for {server_id} (status={current_reservation['status']}, players={current_reservation['currentPlayerCount']})")

        return jsonify(current_reservation), 200

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
            logging.warning(f"Release Not Found: Attempt to release non-existent reservation for {server_id} by {bot_name}")
            return jsonify({"message": "Reservation not found or already released"}), 200

        if current_reservation.get("botName") != bot_name:
            logging.error(f"Release Auth Fail: {bot_name} tried to release reservation for {server_id} owned by {current_reservation.get('botName')}")
            return jsonify({"error": "Reservation owned by another bot"}), 403 # Forbidden

        del reservations[server_id]
        logging.info(f"Release Success: {bot_name} released reservation for {server_id}")
        return jsonify({"message": "Reservation released successfully"}), 200 # OK

@app.route('/stats/increment_fling', methods=['POST'])
def increment_fling_count():
    global total_flings_reported
    with data_lock:
        total_flings_reported += 1
        current_count = total_flings_reported
    logging.info(f"Fling reported via API. Total now: {current_count}")
    return jsonify({"message": "Fling count incremented", "totalFlings": current_count}), 200

@app.route('/', methods=['GET'])
def dashboard_placeholder():
    logging.info("Root URL accessed (placeholder).")
    with data_lock:
        reservations = shared_data.get("serverReservations", {})
        num_reservations = 0
        for res_id, res_data in reservations.items():
             is_stale, _ = is_reservation_stale(res_data)
             if not is_stale:
                 num_reservations += 1

        num_flings = total_flings_reported

    return jsonify({
        "message": "TCD-API is running.",
        "current_active_reservations_count": num_reservations,
        "total_flings_reported": num_flings
    })
cleanup_thread = threading.Thread(target=cleanup_stale_reservations, daemon=True)
cleanup_thread.start()
logging.info("Background cleanup started.")

if __name__ == '__main__':
    logging.info("Starting Flask app")
    app.run(host='0.0.0.0', port=5000, debug=True)
