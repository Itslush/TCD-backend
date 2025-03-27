from flask import Flask, request, jsonify
import json
import threading
import time
import uuid
import os

app = Flask(__name__)

shared_data = {}
server_reservations = {}
bot_data = {}

# Constants
SERVER_RESERVATION_TIMEOUT = 30
MAX_POPULATION = 37
MIN_POPULATION = 15
REGION_PRIORITY = ["DE", "NL", "GB", "FR", "US"]
LOCK_TIMEOUT = 60

# --- Helper Functions ---

def acquire_lock(lock_name, timeout=LOCK_TIMEOUT):
    lock_file = f"{lock_name}.lock"
    start_time = time.time()
    while os.path.exists(lock_file):
        if time.time() - start_time >= timeout:
            raise TimeoutError(f"Timeout acquiring lock for {lock_name}")
        time.sleep(0.1)
    with open(lock_file, "w") as f:
        f.write(str(time.time()))

def release_lock(lock_name):
    lock_file = f"{lock_name}.lock"
    try:
        os.remove(lock_file)
        print(f"Lock released successfully: {lock_name}")
    except FileNotFoundError:
        print(f"No lock file found to release: {lock_name}")
    except OSError as e:
        print(f"Error releasing lock: {lock_name} - {e}")

def load_shared_data_from_file():
    data_file = r"B:\flingbotapi\shared_data.json"  # Explicit Windows path
    try:
        if os.path.exists(data_file):
            with open(data_file, "r") as f:
                data = json.load(f)
            print("Loaded shared data from file.")
            return data
        else:
            print("Shared data file not found, initializing.")
            return {"serverReservations": {}, "accounts": []}
    except Exception as e:
        print(f"Error loading shared data from file: {e}.  Returning empty dictionary.")
        return {"serverReservations": {}, "accounts": []}

def save_shared_data_to_file(data):
    data_file = r"B:\flingbotapi\shared_data.json" # Explicit Windows path
    try:
        os.makedirs(os.path.dirname(data_file), exist_ok=True)
        with open(data_file, "w") as f:
            json.dump(data, f, indent=4)
        print("Saved shared data to file.")
    except Exception as e:
        print(f"Error saving shared data to file: {e}")

def get_reserved_servers():
    now = time.time()
    valid_reservations = {}

    acquire_lock("shared_data")
    try:
        shared_data = load_shared_data_from_file()
        reservations = shared_data.get("serverReservations", {})

        for server_id, reservation_info in reservations.items():
            if now - reservation_info["timestamp"] <= SERVER_RESERVATION_TIMEOUT:
                valid_reservations[server_id] = reservation_info
            else:
                print(f"Reservation for Server ID: {server_id} by Bot: {reservation_info['botName']} timed out.")
    finally:
        release_lock("shared_data")
    return valid_reservations

def select_best_server(server_data, reserved_servers):
    for region in REGION_PRIORITY:
        if "Casual" in server_data and region in server_data["Casual"]:
            casual_servers = server_data["Casual"][region]
            for server_info in casual_servers:
                if server_info["serverId"] not in reserved_servers:
                    return server_info
    return None

def add_or_update_reservation(server_id, bot_name, server_region, initial_player_count):
    acquire_lock("shared_data")
    try:
        shared_data = load_shared_data_from_file()
        shared_data["serverReservations"] = shared_data.get("serverReservations", {})

        bot_reservations = {}
        for existing_server_id, reservation in shared_data["serverReservations"].items():
            if reservation["botName"] == bot_name:
                bot_reservations.setdefault(bot_name, []).append(existing_server_id)

        if bot_name in bot_reservations and len(bot_reservations[bot_name]) >= 1:
            print(f"Bot {bot_name} already has a reservation. Cannot reserve another.")
            return False, "Bot already has a reservation"

        if server_id in shared_data["serverReservations"]:
            print("Server already reserved.")
            return False, "Server already reserved"

        shared_data["serverReservations"][server_id] = {
            "serverId": server_id,
            "botName": bot_name,
            "timestamp": time.time(),
            "status": "reserved",
            "region": server_region,
            "initialPlayerCount": initial_player_count,
            "currentPlayerCount": None,
        }
        save_shared_data_to_file(shared_data)
        return True, "Reservation successful"
    finally:
        release_lock("shared_data")
    return False,

def update_player_count(server_id, player_count):
    acquire_lock("shared_data")
    try:
        shared_data = load_shared_data_from_file()
        if "serverReservations" in shared_data and server_id in shared_data["serverReservations"]:
            shared_data["serverReservations"][server_id]["currentPlayerCount"] = player_count
            shared_data["serverReservations"][server_id]["status"] = "active"
            shared_data["serverReservations"][server_id]["timestamp"] = time.time()
            save_shared_data_to_file(shared_data)
            return True
        else:
            print("Server ID does not have a reservation")
            return False
    finally:
        release_lock("shared_data")

def set_server_status(server_id, status):
    acquire_lock("shared_data")
    try:
        shared_data = load_shared_data_from_file()
        if "serverReservations" in shared_data and server_id in shared_data["serverReservations"]:
            shared_data["serverReservations"][server_id]["status"] = status
            save_shared_data_to_file(shared_data)
    finally:
        release_lock("shared_data")

def release_server_reservation(server_id, bot_name):
    acquire_lock("shared_data")
    try:
        shared_data = load_shared_data_from_file()
        if ("serverReservations" in shared_data and
            server_id in shared_data["serverReservations"] and
            shared_data["serverReservations"][server_id]["botName"] == bot_name):

            del shared_data["serverReservations"][server_id]
            save_shared_data_to_file(shared_data)
            print(f"Reservation released for Server ID: {server_id}")
            return True
        else:
            print(f"No reservation found for Server ID: {server_id} by bot {bot_name} to release.")
            return False
    finally:
        release_lock("shared_data")

def get_server_reservation_by_botname(bot_name):
    acquire_lock("shared_data")
    try:
        shared_data = load_shared_data_from_file()
        if "serverReservations" in shared_data:
            for server_id, reservation_data in shared_data["serverReservations"].items():
                if(reservation_data["botName"] == bot_name):
                    return reservation_data
        return None
    finally:
        release_lock("shared_data")
# --- API Endpoints ---
@app.route('/register', methods=['POST'])
def register_client():
    print("--> /register endpoint hit") # Added log at start of function
    data = request.get_json()
    print(f"--> Received data: {data}") # Log received data

    if not data or "botName" not in data:
        error_message = "Invalid request data. 'botName' is required."
        print(f"--> Error: {error_message}") # Log error
        return jsonify({"error": error_message}), 400

    bot_name = data["botName"]
    client_id = bot_name  # Use bot_name as client_id
    bot_data[client_id] = {"botName": bot_name, "last_heartbeat": time.time()}
    print(f"--> Registered client {client_id} with botName {bot_name}")
    response_message = "Registration successful"
    print(f"--> Sending response: {response_message}") # Log response
    return jsonify({"message": response_message}), 201 # Return simple success JSON

@app.route('/heartbeat', methods=['POST'])
def receive_heartbeat():
    data = request.get_json()
    if not data or "client_id" not in data:
        return jsonify({"error": "Invalid request data. 'client_id' is required."}), 400

    client_id = data["client_id"]

    if client_id not in bot_data:
        return jsonify({"error": "Unregistered client"}), 401

    bot_data[client_id]["last_heartbeat"] = time.time()

    player_count = data.get("playerCount")
    server_id = data.get("serverId")
    server_status = data.get("status")
    bot_name = bot_data[client_id]["botName"]

    if server_id:
        reservation = get_server_reservation_by_botname(bot_name)
        if(reservation != None and reservation["serverId"] == server_id):
            if player_count is not None:
                update_player_count(server_id, player_count)
            if server_status is not None:
                set_server_status(server_id, server_status)
    return jsonify({"message": "Heartbeat received", "timestamp": time.time()}), 200

@app.route('/reserve_server', methods=['POST'])
def reserve_server():
    data = request.get_json()
    if not data or "client_id" not in data or "serverData" not in data:
        return jsonify({"error": "Invalid request data. 'client_id' and 'serverData' are required."}), 400

    client_id = data["client_id"]
    server_data = data["serverData"]
    bot_name = bot_data[client_id]["botName"]

    if client_id not in bot_data:
         return jsonify({"error": "Unregistered client"}), 401

    reserved_servers = get_reserved_servers()

    best_server = select_best_server(server_data, reserved_servers)

    if best_server:
        server_id = best_server["serverId"]
        server_region = best_server["region"]
        initial_player_count = best_server["playerCount"]

        success, message = add_or_update_reservation(server_id, bot_name, server_region, initial_player_count)

        if success:
            return jsonify({"message": message, "serverId": server_id, "region": server_region}), 200
        else:
            return jsonify({"error": message}), 409
    else:
        return jsonify({"error": "No suitable server found"}), 404

@app.route('/release_server', methods=['POST'])
def release_server():
    data = request.get_json()
    if not data or "client_id" not in data or "serverId" not in data:
        return jsonify({"error": "Invalid request data. 'client_id' and 'serverId' are required."}), 400

    client_id = data["client_id"]
    server_id = data["serverId"]
    bot_name = bot_data[client_id]["botName"]

    if client_id not in bot_data:
        return jsonify({"error": "Unregistered client"}), 401

    if release_server_reservation(server_id, bot_name):
        return jsonify({"message": "Server reservation released"}), 200
    else:
        return jsonify({"error": "Failed to release server reservation"}), 400

@app.route('/get_reservations', methods=['GET'])
def get_all_reservations():
    reserved_servers = get_reserved_servers()
    return jsonify(reserved_servers), 200

@app.route('/get_shared_data', methods=['GET'])
def get_shared_data():
    acquire_lock("shared_data")
    try:
        shared_data = load_shared_data_from_file()
        return jsonify(shared_data)
    finally:
        release_lock("shared_data")

def cleanup_inactive_clients():
    inactive_timeout = 60
    now = time.time()
    clients_to_remove = []

    for client_id, data in bot_data.items():
        if now - data["last_heartbeat"] > inactive_timeout:
            clients_to_remove.append(client_id)

    for client_id in clients_to_remove:
        del bot_data[client_id]
        print(f"Removed inactive client: {client_id}")

def cleanup_reservations():
    acquire_lock("shared_data")
    try:
        shared_data = load_shared_data_from_file()
        if("serverReservations" in shared_data):
            current_time = time.time()
            for server_id in list(shared_data["serverReservations"].keys()):
                if current_time - shared_data["serverReservations"][server_id]["timestamp"] > SERVER_RESERVATION_TIMEOUT:
                    del shared_data["serverReservations"][server_id]
                    print(f"Removing timed out reservation: {server_id}")
        save_shared_data_to_file(shared_data)

    finally:
        release_lock("shared_data")

def monitoring_thread():
    while True:
        cleanup_inactive_clients()
        cleanup_reservations()
        print(f"Active clients: {len(bot_data)}")

        time.sleep(30)

# --- Main Execution ---
if __name__ == '__main__':
    shared_data = load_shared_data_from_file()
    monitoring_thread = threading.Thread(target=monitoring_thread, daemon=True)
    monitoring_thread.start()

    app.run(debug=True, host='0.0.0.0', port=5000, threaded=True)