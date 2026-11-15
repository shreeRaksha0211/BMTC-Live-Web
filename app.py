import os
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

import requests
import qrcode
from flask import Flask, jsonify, render_template, request, send_from_directory
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

BMTC_BASE = os.getenv(
    "BMTC_API_BASE",
    "https://bmtcmobileapi.karnataka.gov.in/WebAPI"
).rstrip("/")
DB_PATH = Path(os.getenv("DATABASE_PATH", "bmtc_demo.db"))
QR_DIR = Path("static/qr")
QR_DIR.mkdir(parents=True, exist_ok=True)

SESSION = requests.Session()
SESSION.headers.update({
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "lan": "en",
    "deviceType": "WEB",
    "User-Agent": "BMTC-Community-Tracker/0.1 (contact: configure-your-email)"
})


def init_db():
    with sqlite3.connect(DB_PATH) as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS demo_tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_code TEXT UNIQUE NOT NULL,
                passenger_name TEXT NOT NULL,
                route_no TEXT NOT NULL,
                source_name TEXT NOT NULL,
                destination_name TEXT NOT NULL,
                fare REAL NOT NULL,
                created_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'DEMO_ONLY'
            )
        """)


def upstream_post(endpoint, payload=None):
    """Call the community-documented BMTC endpoint from the server, not browser JS."""
    try:
        response = SESSION.post(
            f"{BMTC_BASE}/{endpoint}",
            json=payload or {},
            timeout=15
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("Unexpected response format from BMTC service")
        return data
    except requests.RequestException as exc:
        raise RuntimeError(f"BMTC service request failed: {exc}") from exc
    except ValueError as exc:
        raise RuntimeError(f"BMTC service returned invalid JSON: {exc}") from exc


def data_list(payload, *keys):
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify({
        "ok": True,
        "service": "BMTC tracker backend",
        "ticketing": "DEMO_ONLY - no valid BMTC tickets or payments",
        "live_data": "Unofficial endpoint; availability is not guaranteed"
    })


@app.get("/api/routes")
def search_routes():
    query = request.args.get("q", "").strip()
    if len(query) < 1:
        return jsonify({"data": []})
    try:
        result = upstream_post("SearchRoute_v2", {"routetext": query})
        return jsonify({"data": data_list(result, "data"), "source": "BMTC endpoint"})
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502


@app.get("/api/stops")
def search_stops():
    query = request.args.get("q", "").strip()
    if len(query) < 2:
        return jsonify({"data": []})
    try:
        result = upstream_post("FindNearByBusStop_v2", {"stationName": query})
        return jsonify({"data": data_list(result, "data"), "source": "BMTC endpoint"})
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502


@app.get("/api/route/<int:route_parent_id>")
def route_live(route_parent_id):
    try:
        result = upstream_post(
            "SearchByRouteDetails_v4",
            {"routeid": route_parent_id, "servicetypeid": 0}
        )

        directions = []
        buses_by_id = {}
        for direction_name in ("up", "down"):
            direction = result.get(direction_name) or {}
            stops = data_list(direction, "data")
            directions.append({
                "direction": direction_name.upper(),
                "stops": stops
            })

            # Vehicle details are usually attached to route-stop records.
            for stop in stops:
                for bus in data_list(stop, "vehicleDetails"):
                    bus_id = str(bus.get("vehicleid", ""))
                    if bus_id:
                        buses_by_id[bus_id] = {
                            **bus,
                            "route_direction": direction_name.upper(),
                            "route_no": stop.get("routeno")
                        }

            # Some responses also expose a mapData array.
            for bus in data_list(direction, "mapData"):
                bus_id = str(bus.get("vehicleid", ""))
                if bus_id:
                    buses_by_id[bus_id] = {
                        **buses_by_id.get(bus_id, {}),
                        **bus,
                        "route_direction": direction_name.upper()
                    }

        return jsonify({
            "route_parent_id": route_parent_id,
            "directions": directions,
            "buses": list(buses_by_id.values()),
            "message": result.get("message") or result.get("Message"),
            "live_data": True
        })
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502


@app.get("/api/vehicles")
def search_vehicles():
    query = request.args.get("q", "").strip()
    if len(query) < 2:
        return jsonify({"data": []})
    try:
        result = upstream_post(
            "ListVehicles",
            {"vehicleRegNo": query, "deviceType": "WEB"}
        )
        return jsonify({"data": data_list(result, "data")})
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502


@app.get("/api/vehicle/<int:vehicle_id>")
def vehicle_live(vehicle_id):
    try:
        result = upstream_post("VehicleTripDetails_v2", {"vehicleId": vehicle_id})
        locations = data_list(result, "LiveLocation")
        route_details = data_list(result, "RouteDetails")

        live = locations[0] if locations else {}
        return jsonify({
            "live": live,
            "route_details": route_details,
            "message": result.get("Message"),
            "live_data": bool(live)
        })
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502


@app.post("/api/fare")
def fare_quote():
    body = request.get_json(silent=True) or {}
    try:
        from_id = int(body.get("fromStationId"))
        to_id = int(body.get("toStationId"))
        if from_id == to_id:
            return jsonify({"error": "Choose two different bus stops."}), 400
    except (TypeError, ValueError):
        return jsonify({"error": "Valid source and destination stop IDs are required."}), 400

    try:
        routes_result = upstream_post(
            "GetFareRoutes",
            {"fromStationId": from_id, "toStationId": to_id}
        )
        fare_routes = data_list(routes_result, "data")
        quotes = []
        for route in fare_routes[:5]:
            fare_result = upstream_post("GetMobileFareData_v2", {
                "routeno": route.get("routeno"),
                "routeid": route.get("routeid"),
                "route_direction": route.get("route_direction"),
                "source_code": route.get("source_code"),
                "destination_code": route.get("destination_code")
            })
            for fare_item in data_list(fare_result, "data"):
                quotes.append({
                    "route_no": route.get("routeno"),
                    "route_name": route.get("routename"),
                    "source": route.get("fromstationname"),
                    "destination": route.get("tostationname"),
                    "fare": fare_item.get("fare"),
                    "service_type": fare_item.get("servicetype"),
                    "fromStationId": from_id,
                    "toStationId": to_id
                })
        return jsonify({"data": quotes})
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502


@app.post("/api/tickets/demo")
def create_demo_ticket():
    """
    Demonstration ticket only.
    This endpoint deliberately does not collect payment and cannot issue a BMTC-valid ticket.
    Replace only after written BMTC ticketing integration approval and payment-provider setup.
    """
    body = request.get_json(silent=True) or {}
    passenger = str(body.get("passenger_name", "")).strip()
    route_no = str(body.get("route_no", "")).strip()
    source = str(body.get("source", "")).strip()
    destination = str(body.get("destination", "")).strip()

    try:
        fare = float(body.get("fare"))
        if fare < 0 or fare > 1000:
            raise ValueError()
    except (TypeError, ValueError):
        return jsonify({"error": "Enter a valid fare returned by the fare lookup."}), 400

    if not all([passenger, route_no, source, destination]):
        return jsonify({"error": "Passenger, route, source and destination are required."}), 400

    ticket_code = "DEMO-" + uuid.uuid4().hex[:10].upper()
    created_at = datetime.now().astimezone().isoformat(timespec="seconds")
    with sqlite3.connect(DB_PATH) as con:
        con.execute("""
            INSERT INTO demo_tickets
            (ticket_code, passenger_name, route_no, source_name,
             destination_name, fare, created_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'DEMO_ONLY')
        """, (ticket_code, passenger, route_no, source, destination, fare, created_at))

    qr_payload = (
        "DEMO ONLY - NOT A VALID BMTC TICKET\n"
        f"Code: {ticket_code}\nPassenger: {passenger}\nRoute: {route_no}\n"
        f"From: {source}\nTo: {destination}\nFare quote: INR {fare:.2f}"
    )
    qr_path = QR_DIR / f"{ticket_code}.png"
    qrcode.make(qr_payload).save(qr_path)

    return jsonify({
        "ticket_code": ticket_code,
        "qr_url": f"/static/qr/{ticket_code}.png",
        "status": "DEMO_ONLY",
        "warning": "This is a demonstration receipt, not a valid BMTC ticket. Do not use it for travel."
    }), 201


@app.get("/api/tickets/demo/<ticket_code>")
def get_demo_ticket(ticket_code):
    with sqlite3.connect(DB_PATH) as con:
        con.row_factory = sqlite3.Row
        row = con.execute(
            "SELECT * FROM demo_tickets WHERE ticket_code = ?",
            (ticket_code,)
        ).fetchone()
    if not row:
        return jsonify({"error": "Ticket not found"}), 404
    return jsonify(dict(row))


@app.errorhandler(404)
def not_found(_):
    return jsonify({"error": "Not found"}), 404


if __name__ == "__main__":
    init_db()
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "5000")),
        debug=os.getenv("FLASK_DEBUG", "false").lower() == "true"
    )
