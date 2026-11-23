let CORRIDOR_ID = null;
const $ = (selector) => document.querySelector(selector);
const state = { status: null, waves: null, vehicles: [], map: null, mapReady: false, mapAttempted: false, routeLayer: null, stopLayer: null, waveLayer: null, liveVehicleLayer: null };
const driverSession = { tripId: null, reporterToken: null, watchId: null, demoTimer: null, demoStartedAt: 0, demoSpeedMultiplier: 10, isDemo: false, lastSentAt: 0, sending: false };

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes} min`;
}

function phtDateTimeInput() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const rounded = Math.ceil(Number(values.minute) / 5) * 5;
  const date = new Date(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:00+08:00`);
  if (rounded >= 60) date.setTime(date.getTime() + (60 - Number(values.minute)) * 60_000);
  else date.setTime(date.getTime() + (rounded - Number(values.minute)) * 60_000);
  const next = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const p = Object.fromEntries(next.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function setStopOptions(stops) {
  const origin = $('#origin-stop');
  const destination = $('#destination-stop');
  origin.innerHTML = '';
  destination.innerHTML = '';
  stops.forEach((stop, index) => {
    const a = document.createElement('option');
    a.value = stop.stop_id;
    a.textContent = stop.stop_name;
    if (index > stops.length - 2) a.disabled = true;
    origin.append(a);
    const b = a.cloneNode(true);
    b.disabled = index === 0;
    destination.append(b);
  });
  origin.value = stops[0]?.stop_id || '';
  destination.value = stops.at(-1)?.stop_id || '';
}

function statusColor(level) {
  return level === 'SEVERE' ? 'severe' : level === 'MODERATE' ? 'moderate' : 'clear';
}

function roadDistanceKm(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const deltaLat = radians(b[1] - a[1]);
  const deltaLng = radians(b[0] - a[0]);
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}

function locateOnRoadLine(coordinates, ratio) {
  if (!coordinates?.length) return null;
  if (coordinates.length === 1) return { point: coordinates[0], edgeIndex: 0 };
  const lengths = coordinates.slice(0, -1).map((point, index) => roadDistanceKm(point, coordinates[index + 1]));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const target = total * Math.max(0, Math.min(1, ratio));
  let traversed = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (target <= traversed + length || index === lengths.length - 1) {
      const fraction = length ? Math.max(0, Math.min(1, (target - traversed) / length)) : 0;
      const from = coordinates[index], to = coordinates[index + 1];
      return { point: [from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction], edgeIndex: index };
    }
    traversed += length;
  }
  return { point: coordinates.at(-1), edgeIndex: coordinates.length - 2 };
}

function sliceRoadLineFrom(coordinates, ratio) {
  const located = locateOnRoadLine(coordinates, ratio);
  if (!located) return [];
  const remainder = coordinates.slice(located.edgeIndex + 1);
  if (remainder.length && roadDistanceKm(located.point, remainder[0]) < 0.000001) remainder.shift();
  return [located.point, ...remainder];
}

function sliceRoadLineTo(coordinates, ratio) {
  const located = locateOnRoadLine(coordinates, ratio);
  if (!located) return [];
  const prefix = coordinates.slice(0, located.edgeIndex + 1);
  if (!prefix.length || roadDistanceKm(prefix.at(-1), located.point) >= 0.000001) prefix.push(located.point);
  return prefix;
}

function remainingRoadFeatures(status, vehicles) {
  if (!status || !vehicles?.length || status.geometry_quality !== 'osm_road_route') return [];
  const geometryById = new Map((status.shape?.features || []).map((feature) => [feature.properties?.segment_id, feature.geometry]));
  const stops = status.route?.stop_ids || [];
  const segments = stops.slice(0, -1).map((stopId, index) => status.segments.find((segment) =>
    segment.from_stop_id === stopId && segment.to_stop_id === stops[index + 1]
  ));
  if (!segments.length || segments.some((segment) => !segment)) return [];
  const lengths = segments.map((segment) => Number(segment.distance_km));
  const segmentStarts = [];
  const totalKm = lengths.reduce((sum, length) => {
    segmentStarts.push(sum);
    return sum + length;
  }, 0);
  if (!totalKm) return [];

  return vehicles.flatMap((vehicle) => {
    const reverse = vehicle.direction === 'reverse';
    const storedProgress = Number(vehicle.progress_km);
    const progress = Math.max(0, Math.min(totalKm, reverse ? totalKm - storedProgress : storedProgress));
    const features = [];
    let needsSharedStart = true;
    const appendFeature = (segment, coordinates) => {
      if (coordinates.length < 2) return;
      if (needsSharedStart) {
        coordinates = [[Number(vehicle.longitude), Number(vehicle.latitude)], ...coordinates];
        needsSharedStart = false;
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: { is_remaining_route: true, reporter_type: vehicle.reporter_type || 'commuter', segment_id: segment.segment_id }
      });
    };

    if (!reverse) {
      segments.forEach((segment, index) => {
        const segmentStart = segmentStarts[index];
        const segmentEndKm = segmentStart + lengths[index];
        if (progress < segmentEndKm) {
          const coordinates = geometryById.get(segment.segment_id)?.coordinates || [];
          const ratio = Math.max(0, (progress - segmentStart) / Math.max(lengths[index], 0.001));
          appendFeature(segment, progress > segmentStart ? sliceRoadLineFrom(coordinates, ratio) : coordinates);
        }
      });
    } else {
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index];
        const segmentStart = segmentStarts[index];
        const segmentEndKm = segmentStart + lengths[index];
        if (progress > segmentStart) {
          const coordinates = geometryById.get(segment.segment_id)?.coordinates || [];
          const ratio = Math.max(0, Math.min(1, (progress - segmentStart) / Math.max(lengths[index], 0.001)));
          appendFeature(segment, progress < segmentEndKm ? sliceRoadLineTo(coordinates, ratio).reverse() : [...coordinates].reverse());
        }
      }
    }
    return features;
  });
}

function roadLocationAtProgress(status, progressKm) {
  const featureById = new Map((status.shape?.features || []).map((feature) => [feature.properties?.segment_id, feature.geometry]));
  const stopIds = status.route?.stop_ids || [];
  const segments = stopIds.slice(0, -1).map((stopId, index) => status.segments.find((segment) =>
    segment.from_stop_id === stopId && segment.to_stop_id === stopIds[index + 1]
  ));
  let distanceBeforeKm = 0;
  for (const segment of segments) {
    if (!segment) return null;
    const lengthKm = Number(segment.distance_km);
    const geometry = featureById.get(segment.segment_id);
    if (progressKm <= distanceBeforeKm + lengthKm && geometry?.coordinates?.length) {
      return locateOnRoadLine(geometry.coordinates, (progressKm - distanceBeforeKm) / Math.max(lengthKm, 0.001))?.point || null;
    }
    distanceBeforeKm += lengthKm;
  }
  const lastSegment = segments.at(-1);
  return lastSegment ? featureById.get(lastSegment.segment_id)?.coordinates?.at(-1) || null : null;
}

function updateMapRouteCopy(status, vehicles = state.vehicles) {
  const hasRoadRoute = status?.geometry_quality === 'osm_road_route';
  $('#map-caption').textContent = !hasRoadRoute
    ? 'OpenStreetMap streets · road route unavailable'
    : vehicles?.length ? 'OpenStreetMap streets · active route from shared location' : 'OpenStreetMap streets · road-following corridor route';
  $('#map-footnote-copy').textContent = !hasRoadRoute
    ? 'Road-following line could not be loaded. Stop locations are approximate planning anchors.'
    : vehicles?.length ? 'Highlighted road line starts at the shared location and follows the vehicle direction.' : 'Corridor line follows mapped roads; stop locations remain approximate planning anchors.';
}

function drawSchematic(status, waves) {
  const svg = $('#schematic');
  svg.style.display = 'block';
  $('#osm-map').style.display = 'none';
  const stops = status.stops;
  const roadFeatures = state.vehicles.length ? remainingRoadFeatures(status, state.vehicles) : status.shape?.features || [];
  const roadCoordinates = roadFeatures.flatMap((feature) => feature.geometry?.coordinates || []);
  const boundsPoints = [...stops.map((stop) => ({ lat: stop.lat, lng: stop.lng })), ...roadCoordinates.map(([lng, lat]) => ({ lat, lng }))];
  const left = 65, right = 840, top = 62, bottom = 326;
  const minLng = Math.min(...boundsPoints.map((point) => point.lng)), maxLng = Math.max(...boundsPoints.map((point) => point.lng));
  const minLat = Math.min(...boundsPoints.map((point) => point.lat)), maxLat = Math.max(...boundsPoints.map((point) => point.lat));
  const px = (stop) => left + ((stop.lng - minLng) / (maxLng - minLng || 1)) * (right - left);
  const py = (stop) => bottom - ((stop.lat - minLat) / (maxLat - minLat || 1)) * (bottom - top);
  let body = '<rect class="schematic-bg" x="0" y="0" width="900" height="390"/>';
  body += '<path class="schematic-water" d="M 0 287 Q 220 240 360 265 T 900 224"/>';
  roadFeatures.forEach((feature) => {
    const path = (feature.geometry?.coordinates || []).map(([lng, lat], index) =>
      `${index ? 'L' : 'M'} ${px({ lng })} ${py({ lat })}`
    ).join(' ');
    if (!path) return;
    const level = feature.properties?.is_remaining_route
      ? feature.properties.reporter_type === 'demo' ? 'demo' : 'live'
      : statusColor(feature.properties?.congestion_level);
    body += `<path class="schematic-road" d="${path}"/><path class="schematic-track ${level}" d="${path}"/>`;
  });
  stops.forEach((stop, index) => {
    const anchor = index < 2 ? 'start' : index > stops.length - 3 ? 'end' : 'middle';
    const x = px(stop), y = py(stop);
    body += `<circle class="schematic-stop ${stop.is_transfer_hub ? 'hub' : ''}" cx="${x}" cy="${y}" r="${stop.is_transfer_hub ? 7 : 5}"/><text class="schematic-stop-label" text-anchor="${anchor}" x="${x}" y="${y - 16}">${escapeHtml(shortName(stop.stop_name))}</text>`;
    const eta = `+${Math.round((stop.eta_from_origin_sec || 0) / 60)}m`;
    body += `<text class="schematic-stop-tag" text-anchor="${anchor}" x="${x}" y="${y + 20}">${stop.is_transfer_hub ? 'TRANSFER · ' : ''}${eta}</text>`;
  });
  (waves?.waves || []).forEach((wave) => {
    const x = left + ((wave.position[0] - minLng) / (maxLng - minLng || 1)) * (right - left);
    const y = bottom - ((wave.position[1] - minLat) / (maxLat - minLat || 1)) * (bottom - top);
    body += `<circle class="schematic-wave-ring" cx="${x}" cy="${y}" r="12"/><circle class="schematic-wave" cx="${x}" cy="${y}" r="5"><title>Estimated Wave · ±${wave.confidence_window_minutes} min</title></circle>`;
  });
  svg.innerHTML = body;
}

function shortName(name) {
  return name.replace('Ateneo de Naga University (Bagumbayan)', 'ADNU').replace('Naga Central / Eastbound Terminal', 'Naga terminal').replace('Concepcion Pequeña / Grande area', 'Concepcion').replace('Palestina, Pili', 'Palestina').replace('Del Rosario (Naga boundary area)', 'Del Rosario').replace('Pili Centro / Capitol area', 'Pili Centro').replace('Anayan / Bula Junction', 'Anayan').replace('Baao Centro / Crossing', 'Baao Centro');
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function loadLeaflet() {
  return new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L);
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.append(css);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => resolve(window.L);
    script.onerror = reject;
    document.head.append(script);
  });
}

function initializeOsm(status, waves, L) {
  if (!L) return false;
  $('#schematic').style.display = 'none';
  $('#osm-map').style.display = 'block';
  state.map = L.map('osm-map', { attributionControl: true, scrollWheelZoom: false });
  const tileUrl = window.BYAHE30_OSM_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  L.tileLayer(tileUrl, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
  }).addTo(state.map);
  state.routeLayer = L.geoJSON(null, {
    style: (feature) => {
      if (feature.properties?.is_remaining_route) {
        const simulated = feature.properties.reporter_type === 'demo';
        return { color: simulated ? '#8655a7' : '#16705b', weight: 6, opacity: 0.96, dashArray: simulated ? '7 5' : null };
      }
      const level = feature.properties?.congestion_level;
      return { color: level === 'SEVERE' ? '#d16d53' : level === 'MODERATE' ? '#e5b34d' : '#32896b', weight: 4, opacity: 0.88, dashArray: '7 6' };
    }
  }).addTo(state.map);
  state.stopLayer = L.layerGroup().addTo(state.map);
  state.waveLayer = L.layerGroup().addTo(state.map);
  state.liveVehicleLayer = L.layerGroup().addTo(state.map);
  state.mapReady = true;
  updateOsmLayers(status, waves);
  updateLiveVehicleLayer(state.vehicles);
  const routePoints = (status.shape?.features || []).flatMap((feature) => feature.geometry?.coordinates || [])
    .map(([lng, lat]) => [lat, lng]);
  const bounds = L.latLngBounds([...status.stops.map((stop) => [stop.lat, stop.lng]), ...routePoints]);
  state.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 11 });
  window.setTimeout(() => state.map?.invalidateSize(), 0);
  updateMapRouteCopy(status);
  return true;
}

function updateRoadRouteLayer(status, vehicles = state.vehicles) {
  if (!state.mapReady || !state.routeLayer || !status) return;
  const features = vehicles?.length
    ? remainingRoadFeatures(status, vehicles)
    : status.shape?.features || [];
  state.routeLayer.clearLayers();
  state.routeLayer.addData({ type: 'FeatureCollection', features });
}

function updateOsmLayers(status, waves) {
  if (!state.mapReady || !window.L) return;
  updateRoadRouteLayer(status, state.vehicles);
  state.stopLayer.clearLayers();
  status.stops.forEach((stop) => {
    const eta = formatDuration(stop.eta_from_origin_sec || 0);
    const title = escapeHtml(shortName(stop.stop_name));
    window.L.circleMarker([stop.lat, stop.lng], {
      radius: stop.is_transfer_hub ? 7 : 5,
      color: '#367e65', weight: 2,
      fillColor: stop.is_transfer_hub ? '#367e65' : '#fff', fillOpacity: 1
    }).bindPopup(`<strong>${title}</strong><br>Estimated from origin: +${escapeHtml(eta)}${stop.is_transfer_hub ? '<br>Transfer hub' : ''}`)
      .addTo(state.stopLayer);
  });
  state.waveLayer.clearLayers();
  (waves?.waves || []).forEach((wave) => {
    const label = escapeHtml(wave.label || 'Estimated wave');
    const confidence = Number(wave.confidence_window_minutes) || 0;
    window.L.circleMarker([wave.position[1], wave.position[0]], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#16705b', fillOpacity: 1
    }).bindPopup(`${label}<br>Confidence window: ±${confidence} min`)
      .addTo(state.waveLayer);
  });
}

function setLiveStopOptions(stops) {
  const select = $('#live-stop-select');
  select.innerHTML = '';
  stops.forEach((stop) => {
    const option = document.createElement('option');
    option.value = stop.stop_id;
    option.textContent = shortName(stop.stop_name);
    select.append(option);
  });
  select.value = stops[Math.min(2, stops.length - 1)]?.stop_id || '';
}

function routeDirectionLabel(direction) {
  const stops = [...(state.status?.stops || [])].sort((a, b) => a.sequence_order - b.sequence_order);
  const first = shortName(stops[0]?.stop_name || 'Origin');
  const last = shortName(stops.at(-1)?.stop_name || 'Destination');
  return direction === 'reverse' ? `${last} to ${first}` : `${first} to ${last}`;
}

function updateLiveVehicleLayer(vehicles) {
  if (!state.mapReady || !window.L || !state.liveVehicleLayer) {
    if (state.status && !state.mapReady) drawSchematic(state.status, state.waves);
    return;
  }
  state.liveVehicleLayer.clearLayers();
  vehicles.forEach((vehicle) => {
    const nextStop = vehicle.next_stop ? escapeHtml(shortName(vehicle.next_stop.stop_name)) : 'no downstream checkpoint';
    const eta = vehicle.next_stop ? `~${vehicle.next_stop.eta_minutes} min ±${vehicle.next_stop.confidence_window_minutes} min` : 'ETA unavailable';
    window.L.marker([vehicle.latitude, vehicle.longitude], {
      icon: window.L.divIcon({ className: 'live-vehicle-marker', html: '<span></span>', iconSize: [16, 16], iconAnchor: [8, 8] })
    }).bindPopup(`<strong>${vehicle.reporter_type === 'demo' ? 'Demo simulation' : 'Live phone report'}</strong><br>${escapeHtml(vehicle.vehicle_type)} · ${escapeHtml(routeDirectionLabel(vehicle.direction))}<br>Next checkpoint: ${nextStop} · ${eta}<br>Location updated ${vehicle.age_seconds}s ago`)
      .addTo(state.liveVehicleLayer);
  });
  updateRoadRouteLayer(state.status, vehicles);
  updateMapRouteCopy(state.status, vehicles);
}

function renderLiveVehicles(data) {
  const vehicles = data?.vehicles || [];
  state.vehicles = vehicles;
  $('#live-vehicle-count').textContent = String(vehicles.length);
  const roadEstimate = state.status?.source === 'live_routing' || state.status?.source === 'mixed'
    ? 'Road times use live traffic estimates.'
    : 'Road times use historical or seeded estimates.';
  const reportSummary = vehicles.length
    ? `${vehicles.length} active phone report${vehicles.length === 1 ? '' : 's'} updated within 90 seconds${vehicles.some((vehicle) => vehicle.reporter_type === 'demo') ? ' (includes local demo)' : ''}.`
    : 'No active bus phone reports; scheduled waves are estimates.';
  $('#summary-source').textContent = `${roadEstimate} ${reportSummary}`;
  const selectedStopId = $('#live-stop-select').value;
  const list = $('#live-vehicle-list');
  const matches = vehicles.map((vehicle) => ({
    vehicle,
    arrival: (vehicle.arrivals || []).find((item) => item.stop_id === selectedStopId)
  })).filter((item) => item.arrival);

  if (!matches.length) {
    list.innerHTML = vehicles.length
      ? '<p>No reported vehicle is approaching this stop right now.</p>'
      : '<p>No buses are sharing location right now. Estimated waves remain available above.</p>';
  } else {
    list.innerHTML = matches.map(({ vehicle, arrival }) => {
      const label = vehicle.vehicle_type === 'van' ? 'Van / UV' : vehicle.vehicle_type === 'jeepney' ? 'Jeepney' : 'Bus';
      const reporter = vehicle.reporter_type === 'demo' ? 'DEMO SIMULATION' : vehicle.reporter_type === 'driver' ? 'DRIVER REPORT' : 'RIDER REPORT';
      const stop = escapeHtml(shortName(arrival.stop_name));
      const direction = escapeHtml(routeDirectionLabel(vehicle.direction));
      const accuracy = Math.max(10, Math.round(Number(vehicle.accuracy_m) / 10) * 10);
      return `<article class="live-vehicle-card"><div class="live-vehicle-heading"><strong>${label}</strong><span>${reporter}</span></div><p>${direction} · location ${vehicle.age_seconds}s ago · ±${accuracy}m</p><div><strong>~${arrival.eta_minutes} min</strong> to ${stop}</div><small>Estimate window: ±${arrival.confidence_window_minutes} min</small></article>`;
    }).join('');
  }
  updateLiveVehicleLayer(vehicles);
}
function setDriverStatus(message, isError = false) {
  const status = $('#driver-status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function sendDriverLocation(position) {
  if (!driverSession.tripId || driverSession.sending) return;
  const now = Date.now();
  if (now - driverSession.lastSentAt < 8_000) return;
  driverSession.lastSentAt = now;
  driverSession.sending = true;
  try {
    const response = await fetch(`/api/v1/corridors/${encodeURIComponent(CORRIDOR_ID)}/vehicle-trips/${encodeURIComponent(driverSession.tripId)}/position`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${driverSession.reporterToken}` },
      body: JSON.stringify({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy_m: position.coords.accuracy
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not share this location.');
    setDriverStatus(`${driverSession.isDemo ? 'Demo simulation' : 'Sharing location'} · accuracy ±${Math.round(position.coords.accuracy)}m`);
    await refreshVehicles();
  } catch (error) {
    setDriverStatus(error.message, true);
  } finally {
    driverSession.sending = false;
  }
}

async function endDriverTrip(showMessage = true) {
  const tripId = driverSession.tripId;
  const token = driverSession.reporterToken;
  if (driverSession.watchId != null) navigator.geolocation.clearWatch(driverSession.watchId);
  if (driverSession.demoTimer != null) window.clearInterval(driverSession.demoTimer);
  driverSession.tripId = null;
  driverSession.reporterToken = null;
  driverSession.watchId = null;
  driverSession.demoTimer = null;
  driverSession.demoStartedAt = 0;
  driverSession.isDemo = false;
  driverSession.lastSentAt = 0;
  driverSession.sending = false;
  $('#driver-stop').disabled = true;
  $('#driver-start').disabled = false;
  $('#demo-start').disabled = !state.status || state.status.geometry_quality !== 'osm_road_route';
  if (tripId && token) {
    try {
      await fetch(`/api/v1/corridors/${encodeURIComponent(CORRIDOR_ID)}/vehicle-trips/${encodeURIComponent(tripId)}/end`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }
      });
    } catch { /* the server expires unreported sessions automatically */ }
  }
  if (showMessage) setDriverStatus('Trip ended. Your live location has been removed.');
  await refreshVehicles();
}

async function startDriverTrip(event) {
  event.preventDefault();
  if (driverSession.tripId) return;
  const button = $('#driver-start');
  button.disabled = true;
  $('#demo-start').disabled = true;
  setDriverStatus('Starting trip…');
  try {
    if (!window.isSecureContext) throw new Error('Location sharing requires HTTPS or localhost.');
    if (!navigator.geolocation) throw new Error('This browser does not provide phone location.');
    await createLocationTrip($('#reporter-type').value);
    $('#driver-stop').disabled = false;
    setDriverStatus('Trip started. Waiting for a good phone location fix…');
    driverSession.watchId = navigator.geolocation.watchPosition(
      sendDriverLocation,
      (error) => {
        const message = error.code === 1 ? 'Location permission was denied.' : 'Phone location is unavailable. Move to a clearer location and retry.';
        setDriverStatus(message, true);
        if (error.code === 1) endDriverTrip(false).catch(() => {});
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 }
    );
  } catch (error) {
    const message = error.message;
    if (driverSession.tripId) await endDriverTrip(false);
    button.disabled = false;
    $('#demo-start').disabled = !state.status || state.status.geometry_quality !== 'osm_road_route';
    setDriverStatus(message, true);
  }
}

async function createLocationTrip(reporterType) {
  const response = await fetch(`/api/v1/corridors/${encodeURIComponent(CORRIDOR_ID)}/vehicle-trips`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      route_id: state.status.route.route_id,
      vehicle_type: $('#driver-vehicle-type').value,
      direction: $('#driver-direction').value,
      reporter_type: reporterType
    })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not start trip reporting.');
  driverSession.tripId = result.trip_id;
  driverSession.reporterToken = result.reporter_token;
}

async function startDemoTrip() {
  if (driverSession.tripId) return;
  const button = $('#demo-start');
  const speedMultiplier = Number($('#demo-speed').value) || 10;
  const totalKm = state.status?.segments.reduce((sum, segment) => sum + Number(segment.distance_km), 0) || 0;
  if (state.status?.geometry_quality !== 'osm_road_route' || !totalKm) {
    setDriverStatus('Load the road route before starting the local simulation.', true);
    return;
  }
  button.disabled = true;
  $('#driver-start').disabled = true;
  setDriverStatus(`Starting local demo at ${speedMultiplier}× speed…`);
  try {
    await createLocationTrip('demo');
    driverSession.isDemo = true;
    driverSession.demoSpeedMultiplier = speedMultiplier;
    driverSession.demoStartedAt = Date.now();
    $('#driver-stop').disabled = false;
    const tick = async () => {
      if (!driverSession.tripId) return;
      const elapsedSeconds = (Date.now() - driverSession.demoStartedAt) / 1000;
      const traveledKm = Math.min(totalKm, elapsedSeconds * (35 * speedMultiplier / 3.6) / 1000);
      const forwardProgress = $('#driver-direction').value === 'reverse' ? totalKm - traveledKm : traveledKm;
      const point = roadLocationAtProgress(state.status, forwardProgress);
      if (!point) throw new Error('Could not place the demo vehicle on the road route.');
      await sendDriverLocation({ coords: { longitude: point[0], latitude: point[1], accuracy: 12 } });
      if (traveledKm >= totalKm && driverSession.demoTimer != null) {
        window.clearInterval(driverSession.demoTimer);
        driverSession.demoTimer = null;
        setDriverStatus('Demo reached the end of the corridor. End trip to clear the test report.');
      }
    };
    await tick();
    if (driverSession.tripId) driverSession.demoTimer = window.setInterval(() => {
      tick().catch((error) => {
        setDriverStatus(error.message, true);
        endDriverTrip(false).catch(() => {});
      });
    }, 8_500);
  } catch (error) {
    if (driverSession.tripId) await endDriverTrip(false);
    button.disabled = false;
    $('#driver-start').disabled = false;
    setDriverStatus(error.message, true);
  }
}

function renderStatus(status, waves) {
  state.status = status;
  state.waves = waves;
  const totalSec = status.segments.reduce((sum, segment) => sum + segment.live_duration_sec, 0);
  const baseline = status.segments.reduce((sum, segment) => sum + segment.baseline_duration_sec, 0);
  const highest = Math.max(...status.segments.map((item) => item.congestion_ratio));
  const routeStops = status.route.stop_ids.map((stopId) => status.stops.find((stop) => stop.stop_id === stopId)).filter(Boolean);
  if (routeStops.length) {
    $('#corridor-heading').textContent = `${shortName(routeStops[0].stop_name)} to ${shortName(routeStops.at(-1).stop_name)}`;
    const routeLabels = document.querySelectorAll('.hero-route > span');
    if (routeLabels.length >= 3) {
      routeLabels[0].textContent = shortName(routeStops[0].stop_name).toUpperCase();
      routeLabels[2].textContent = shortName(routeStops.at(-1).stop_name).toUpperCase();
    }
  }
  $('#distance-value').textContent = `~${Number(status.corridor.distance_km).toFixed(1)} km`;
  $('#checkpoint-value').textContent = `${status.stops.length} nodes`;
  const level = highest > 1.6 ? 'heavy' : highest >= 1.2 ? 'slow' : 'clear';
  $('#travel-time').textContent = formatDuration(totalSec);
  $('#delay-copy').textContent = totalSec > baseline ? `+${formatDuration(totalSec - baseline)} vs baseline` : 'around baseline';
  $('#delay-track').style.width = `${Math.min(100, Math.max(8, (totalSec / Math.max(baseline, 1)) * 38))}%`;
  const pill = $('#status-pill');
  pill.className = `status-pill ${level === 'clear' ? '' : level}`;
  const hasCurrentRouting = status.source === 'live_routing' || status.source === 'mixed';
  pill.innerHTML = `<i></i>${!hasCurrentRouting ? 'Baseline only' : level === 'heavy' ? 'Heavy delays' : level === 'slow' ? 'Moving slowly' : 'Running clear'}`;
  $('#wave-count').textContent = `${waves?.waves?.length || 0} shown`;
  $('#updated-at').textContent = status.source === 'live_routing' || status.source === 'mixed' ? `Updated ${new Date(status.as_of).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' })}` : 'Planning baseline';
  updateMapRouteCopy(status, state.vehicles);
  $('#demo-start').disabled = status.geometry_quality !== 'osm_road_route' || Boolean(driverSession.tripId);
  $('#data-mode').textContent = status.source === 'live_routing' ? 'Live routing estimate' : status.source === 'mixed' ? 'Mixed traffic estimate' : 'Baseline estimate';
  const connectionDot = $('.topbar-meta .live-dot');
  connectionDot.style.background = hasCurrentRouting ? '#91c9a8' : '#a9b7ae';
  connectionDot.style.boxShadow = hasCurrentRouting ? '0 0 0 4px #91c9a81f' : '0 0 0 4px #a9b7ae20';
  $('#summary-source').textContent = status.source === 'live_routing' ? 'Routing provider data · estimated corridor travel' : 'Historical / seeded baseline · no vehicle GPS data';
  const bottlenecks = $('#bottleneck-list');
  bottlenecks.innerHTML = status.bottlenecks.length ? status.bottlenecks.map((item) => `<div class="bottleneck-item ${item.congestion_level === 'SEVERE' ? 'severe' : ''}"><strong>${escapeHtml(item.from_stop)} → ${escapeHtml(item.to_stop)}</strong><br>${formatDuration(item.live_duration_sec)} · ${item.congestion_level.toLowerCase()} estimate</div>`).join('') : '';
  if (state.mapReady) {
    updateOsmLayers(status, waves);
  } else drawSchematic(status, waves);
}

async function refreshVehicles() {
  if (!CORRIDOR_ID) return;
  const response = await fetch(`/api/v1/corridors/${encodeURIComponent(CORRIDOR_ID)}/vehicles`);
  if (!response.ok) throw new Error('Live vehicle reports are temporarily unavailable.');
  renderLiveVehicles(await response.json());
}

async function refresh() {
  const [statusResponse, wavesResponse] = await Promise.all([
    fetch(`/api/v1/corridors/${CORRIDOR_ID}/status`),
    fetch(`/api/v1/corridors/${CORRIDOR_ID}/waves?vehicle_type=van`)
  ]);
  if (!statusResponse.ok || !wavesResponse.ok) throw new Error('Corridor service is unavailable. Start the local server and try again.');
  const [status, waves] = await Promise.all([statusResponse.json(), wavesResponse.json()]);
  renderStatus(status, waves);
  if (!state.map && !state.mapAttempted) {
    state.mapAttempted = true;
    try {
      const leaflet = await loadLeaflet();
      if (!initializeOsm(status, waves, leaflet)) throw new Error('Leaflet is unavailable.');
    } catch {
      state.map?.remove();
      state.map = null;
      state.mapReady = false;
      $('#osm-map').style.display = 'none';
      $('#schematic').style.display = 'block';
      $('#map-caption').textContent = 'OpenStreetMap unavailable';
      drawSchematic(state.status, state.waves);
    }
  }
}

function renderPlan(result) {
  const box = $('#plan-result');
  const plan = result.reverse_departure;
  const comparison = result.route_comparison;
  const warnings = plan.warnings.length ? `<div class="result-warning">${plan.warnings.map(escapeHtml).join('<br>')}</div>` : '';
  const recommended = comparison.recommendation === 'direct' ? 'Direct trip' : `Cut trip via ${escapeHtml(comparison.best_cut_trip.transfer_stop)}`;
  box.className = 'plan-result visible';
  box.innerHTML = `<span class="result-kicker">LEAVE HOME BY · ${plan.confidence_window_minutes} MIN CONFIDENCE WINDOW</span><strong class="result-time">${escapeHtml(plan.leave_home_by_pht)}</strong><div class="result-detail">${formatDuration(plan.breakdown.travel_time_sec)} travel + ${Math.round(plan.breakdown.headway_wait_sec / 60)} min typical service wait${plan.breakdown.last_mile_buffer_sec ? ` + ${Math.round(plan.breakdown.last_mile_buffer_sec / 60)} min last-mile buffer` : ''}.</div><div class="result-comparison">Suggested option: <strong>${recommended}</strong> · direct ${formatDuration(comparison.direct.total_time_sec)}${comparison.best_cut_trip ? ` · cut trip ${formatDuration(comparison.best_cut_trip.total_time_sec)}` : ''}</div>${warnings}`;
}

async function submitPlan(event) {
  event.preventDefault();
  const button = $('.plan-button');
  const box = $('#plan-result');
  button.disabled = true;
  button.querySelector('span:first-child').textContent = 'Working it out…';
  box.className = 'plan-result';
  try {
    const response = await fetch('/api/v1/plan/reverse-departure', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        corridor_id: CORRIDOR_ID,
        origin_stop_id: $('#origin-stop').value,
        destination_stop_id: $('#destination-stop').value,
        target_arrival_time: $('#arrival-time').value,
        vehicle_preference: $('#vehicle-type').value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not calculate the departure time.');
    renderPlan(result);
  } catch (error) {
    box.className = 'plan-result visible result-error';
    box.textContent = error.message;
  } finally {
    button.disabled = false;
    button.querySelector('span:first-child').textContent = 'Find my leave time';
  }
}

function setMapMaximized(maximized) {
  const mapCard = $('.map-card');
  const button = $('#map-maximize');
  mapCard.classList.toggle('is-maximized', maximized);
  document.body.classList.toggle('map-maximized', maximized);
  button.setAttribute('aria-pressed', String(maximized));
  button.setAttribute('aria-label', maximized ? 'Restore map size' : 'Maximize map');
  button.title = maximized ? 'Restore map' : 'Maximize map';
  window.setTimeout(() => state.map?.invalidateSize(), 120);
}

async function initialize() {
  $('#arrival-time').value = phtDateTimeInput();
  const localDemoAvailable = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  $('#demo-start').hidden = !localDemoAvailable;
  $('#demo-speed-label').hidden = !localDemoAvailable;
  $('#demo-note').hidden = !localDemoAvailable;
  $('#demo-start').addEventListener('click', startDemoTrip);
  $('#map-maximize').addEventListener('click', () => {
    setMapMaximized(!$('.map-card').classList.contains('is-maximized'));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('.map-card').classList.contains('is-maximized')) setMapMaximized(false);
  });
  $('#planner-form').addEventListener('submit', submitPlan);
  $('#driver-form').addEventListener('submit', startDriverTrip);
  $('#driver-stop').addEventListener('click', () => endDriverTrip());
  $('#live-stop-select').addEventListener('change', () => renderLiveVehicles({ vehicles: state.vehicles }));
  try {
    const corridorResponse = await fetch('/api/v1/corridors');
    if (!corridorResponse.ok) throw new Error('No active corridor is configured.');
    const corridors = await corridorResponse.json();
    CORRIDOR_ID = corridors.corridors[0]?.id;
    if (!CORRIDOR_ID) throw new Error('No active corridor is configured.');
    await refresh();
    setStopOptions(state.status.stops);
    setLiveStopOptions(state.status.stops);
    const orderedStops = [...state.status.stops].sort((a, b) => a.sequence_order - b.sequence_order);
    const directionOptions = $('#driver-direction').options;
    directionOptions[0].textContent = `${shortName(orderedStops[0]?.stop_name || 'Origin')} to ${shortName(orderedStops.at(-1)?.stop_name || 'Destination')}`;
    directionOptions[1].textContent = `${shortName(orderedStops.at(-1)?.stop_name || 'Destination')} to ${shortName(orderedStops[0]?.stop_name || 'Origin')}`;
    await refreshVehicles();
    window.setInterval(() => refreshVehicles().catch(() => {}), 10_000);
    window.setInterval(() => refresh().catch(() => {}), 60_000);
  } catch (error) {
    $('#data-mode').textContent = 'Waiting for local server';
    $('#summary-source').textContent = error.message;
    $('#schematic').innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#73827d" font-size="13">Start the Byahe30 server to load corridor data.</text>';
  }
}

initialize();
