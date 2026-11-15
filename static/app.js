const $ = (id) => document.getElementById(id);
const map = L.map("map").setView([12.9716, 77.5946], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let busMarkers = new Map();
let stopMarkers = [];
let selectedRoute = null;
let selectedBusId = null;
let fromStop = null;
let toStop = null;
let chosenFare = null;
let refreshTimer = null;

function status(message, error=false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
async function api(url, options={}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function clearMap() {
  for (const marker of busMarkers.values()) map.removeLayer(marker);
  busMarkers.clear();
  stopMarkers.forEach(m => map.removeLayer(m));
  stopMarkers = [];
}
function busIcon() {
  return L.divIcon({className:"",html:'<div style="background:#087f5b;color:white;border:2px solid white;border-radius:50%;width:29px;height:29px;display:grid;place-items:center;box-shadow:0 2px 8px #0004;font-size:15px">🚌</div>',iconSize:[29,29],iconAnchor:[14,14]});
}
function addBus(bus) {
  const lat = Number(bus.centerlat ?? bus.latitude ?? bus.currlatitude);
  const lon = Number(bus.centerlong ?? bus.longitude ?? bus.currlongitude);
  const id = String(bus.vehicleid ?? bus.vehicleId ?? bus.vehiclenumber ?? Math.random());
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !lat || !lon) return;
  const popup = `<b>${esc(bus.vehiclenumber || bus.vehicleregno || "BMTC bus")}</b><br>Route: ${esc(bus.route_no || bus.routeno || "—")}<br>Next stop: ${esc(bus.nextstop || "—")}<br>Last update: ${esc(bus.lastrefreshon || "Not supplied")}`;
  if (busMarkers.has(id)) {
    busMarkers.get(id).setLatLng([lat,lon]).setPopupContent(popup);
  } else {
    busMarkers.set(id, L.marker([lat,lon],{icon:busIcon()}).addTo(map).bindPopup(popup));
  }
}
function renderBuses(buses) {
  $("busList").innerHTML = "";
  if (!buses.length) {
    $("busList").className = "bus-list empty";
    $("busList").textContent = "No buses with GPS coordinates were returned for this route right now. Try again shortly.";
    return;
  }
  $("busList").className = "bus-list";
  buses.forEach(bus => {
    addBus(bus);
    const card = document.createElement("div");
    card.className = "bus-card";
    const reg = bus.vehiclenumber || bus.vehicleregno || `Vehicle ${bus.vehicleid}`;
    const lat = bus.centerlat ?? bus.latitude ?? "—";
    const lon = bus.centerlong ?? bus.longitude ?? "—";
    const eta = bus.eta || bus.etastatusmapview || bus.etastatus || bus.sch_arrivaltime || "Not available";
    card.innerHTML = `<div class="bus-top"><span>${esc(reg)}</span><span class="tag">${esc(bus.servicetype || bus.route_direction || "BMTC")}</span></div>
      <div class="bus-meta">Next stop: ${esc(bus.nextstop || "Not available")}<br>Estimated arrival at stop: <b>${esc(eta)}</b><br>GPS: ${esc(lat)}, ${esc(lon)}<br>Updated: ${esc(bus.lastrefreshon || "Timestamp not supplied")}</div>`;
    card.addEventListener("click", () => {
      if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) map.setView([Number(lat),Number(lon)],16);
      if (bus.vehicleid) trackVehicle(bus.vehicleid);
    });
    $("busList").appendChild(card);
  });
}
async function loadRoute(parentId, routeNo) {
  selectedRoute = {parentId,routeNo};
  $("selectedTitle").textContent = `Route ${routeNo}`;
  status("Loading route stops and live vehicles…");
  clearMap();
  try {
    const data = await api(`/api/route/${parentId}`);
    const buses = data.buses || [];
    renderBuses(buses);
    let points = [];
    for (const direction of (data.directions || [])) {
      for (const stop of (direction.stops || [])) {
        const lat = Number(stop.centerlat), lon = Number(stop.centerlong);
        if (lat && lon && Number.isFinite(lat) && Number.isFinite(lon)) {
          const marker = L.circleMarker([lat,lon],{radius:5,color:"#087f5b",fillColor:"#fff",fillOpacity:1,weight:2})
            .addTo(map).bindPopup(`<b>${esc(stop.stationname)}</b><br>${esc(direction.direction)} direction`);
          stopMarkers.push(marker); points.push([lat,lon]);
        }
      }
    }
    if (points.length) map.fitBounds(points,{padding:[25,25]});
    else if (buses.length) {
      const b = buses[0]; const lat = Number(b.centerlat), lon = Number(b.centerlong);
      if(lat && lon) map.setView([lat,lon],14);
    }
    status(`Route loaded. ${buses.length} vehicle(s) returned by the live service.`);
    $("refreshLabel").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) { status(e.message,true); }
}
async function trackVehicle(id) {
  selectedBusId = id;
  try {
    const data = await api(`/api/vehicle/${id}`);
    const live = data.live || {};
    if (live.latitude && live.longitude) {
      addBus({...live,vehicleid:id});
      map.setView([Number(live.latitude),Number(live.longitude)],16);
      const details = data.route_details || [];
      const next = details.find(x => x.etastatusmapview || x.etastatus);
      status(`Bus ${live.vehiclenumber || ""}: ${live.location || "GPS location received"}. Next stop: ${live.nextstop || "—"}${next ? ` · ETA shown by service: ${next.etastatusmapview || next.etastatus}` : ""}`);
    } else {
      status("The live service did not return a current GPS fix for this vehicle.",true);
    }
  } catch(e) { status(e.message,true); }
}
function showResults(container, items, onPick, titleFn, subFn) {
  container.innerHTML = "";
  items.forEach(item => {
    const btn = document.createElement("button");
    btn.className = "result-item";
    btn.innerHTML = `${esc(titleFn(item))}<small>${esc(subFn(item))}</small>`;
    btn.addEventListener("click", () => { container.innerHTML = ""; onPick(item); });
    container.appendChild(btn);
  });
}
async function doRouteSearch() {
  const q = $("routeSearch").value.trim();
  if(!q) return;
  status("Searching BMTC routes…");
  try {
    const data = await api(`/api/routes?q=${encodeURIComponent(q)}`);
    showResults($("routeResults"),data.data || [],r => loadRoute(r.routeparentid,r.routeno),
      r=>r.routeno, r=>`Route ID ${r.routeparentid}`);
    status(`${(data.data||[]).length} route result(s). Select one to view its buses.`);
  } catch(e) { status(e.message,true); }
}
async function doVehicleSearch() {
  const q = $("vehicleSearch").value.trim();
  if(!q) return;
  try {
    const data = await api(`/api/vehicles?q=${encodeURIComponent(q)}`);
    showResults($("vehicleResults"),data.data || [],v=>trackVehicle(v.vehicleid),
      v=>v.vehicleregno, v=>`Vehicle ID ${v.vehicleid}`);
    status(`${(data.data||[]).length} matching vehicle(s).`);
  } catch(e) { status(e.message,true); }
}
async function stopSearch(inputId, resultsId, which) {
  const q = $(inputId).value.trim();
  if(q.length < 2) return;
  try {
    const data = await api(`/api/stops?q=${encodeURIComponent(q)}`);
    showResults($(resultsId),data.data || [],stop=>{
      const chosen = {id:stop.routeid,name:stop.routename};
      if(which==="from") fromStop=chosen; else toStop=chosen;
      $(inputId).value = chosen.name;
      status(`${which==="from"?"Boarding":"Destination"} stop selected: ${chosen.name}`);
    },s=>s.routename,s=>`Stop ID ${s.routeid}`);
  } catch(e) { status(e.message,true); }
}
async function findFare() {
  if(!fromStop || !toStop) { status("Select both stops from the search suggestions first.",true); return; }
  try {
    const data = await api("/api/fare",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({fromStationId:fromStop.id,toStationId:toStop.id})
    });
    const fares=data.data||[];
    $("fareResults").innerHTML="";
    $("demoCheckout").hidden=true;
    if(!fares.length){$("fareResults").textContent="No fare options returned for this stop pair.";return;}
    fares.forEach(fare=>{
      const card=document.createElement("button");
      card.className="fare-card result-item";
      card.innerHTML=`<span><b>${esc(fare.route_no)}</b><small>${esc(fare.source)} → ${esc(fare.destination)} · ${esc(fare.service_type)}</small></span><strong>₹${esc(fare.fare)}</strong>`;
      card.addEventListener("click",()=>{
        chosenFare=fare;
        $("demoCheckout").hidden=false;
        status("Fare quote selected. Checkout below creates a demo receipt only.");
      });
      $("fareResults").appendChild(card);
    });
  } catch(e) { status(e.message,true); }
}
async function createDemoTicket() {
  if(!chosenFare) return;
  const passenger=$("passengerName").value.trim();
  try {
    const result=await api("/api/tickets/demo",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        passenger_name:passenger,route_no:chosenFare.route_no,
        source:chosenFare.source,destination:chosenFare.destination,fare:chosenFare.fare
      })
    });
    $("ticketResult").innerHTML=`<div class="ticket-receipt"><b>DEMO RECEIPT — NOT VALID FOR TRAVEL</b><p>Code: ${esc(result.ticket_code)}<br>Route: ${esc(chosenFare.route_no)}<br>${esc(chosenFare.source)} → ${esc(chosenFare.destination)}<br>Fare quote: ₹${esc(chosenFare.fare)}</p><img src="${esc(result.qr_url)}" alt="Demo QR code"><small>${esc(result.warning)}</small></div>`;
  } catch(e) { status(e.message,true); }
}

$("routeSearchBtn").addEventListener("click",doRouteSearch);
$("routeSearch").addEventListener("keydown",e=>{if(e.key==="Enter")doRouteSearch();});
$("vehicleSearchBtn").addEventListener("click",doVehicleSearch);
$("vehicleSearch").addEventListener("keydown",e=>{if(e.key==="Enter")doVehicleSearch();});
$("fromStop").addEventListener("change",()=>stopSearch("fromStop","fromResults","from"));
$("toStop").addEventListener("change",()=>stopSearch("toStop","toResults","to"));
$("fromStop").addEventListener("keydown",e=>{if(e.key==="Enter")stopSearch("fromStop","fromResults","from");});
$("toStop").addEventListener("keydown",e=>{if(e.key==="Enter")stopSearch("toStop","toResults","to");});
$("fareBtn").addEventListener("click",findFare);
$("demoTicketBtn").addEventListener("click",createDemoTicket);
document.querySelectorAll(".tab").forEach(tab=>tab.addEventListener("click",()=>{
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
  tab.classList.add("active");
  const route=tab.dataset.tab==="route";
  $("routePane").hidden=!route;$("vehiclePane").hidden=route;
}));

$("refreshBtn").addEventListener("click",()=>{
  if(selectedRoute) loadRoute(selectedRoute.parentId,selectedRoute.routeNo);
  else if(selectedBusId) trackVehicle(selectedBusId);
  else status("Select a route or bus first.");
});
