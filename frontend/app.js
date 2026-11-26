let CORRIDOR_ID = null;
const $ = (selector) => document.querySelector(selector);
const state = { status: null, waves: null, map: null, mapReady: false, mapAttempted: false, routeLayer: null, stopLayer: null, waveLayer: null, trackerMarker: null };
const tracker = { watchId: null, alertedStopId: null, audioContext: null };

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

function nearestRoadPosition(status, latitude, longitude) {
  const features = new Map((status.shape?.features || []).map((feature) => [feature.properties?.segment_id, feature.geometry]));
  const routeStopIds = status.route.stop_ids;
  const segments = routeStopIds.slice(0, -1).map((stopId, index) => status.segments.find((segment) =>
    segment.from_stop_id === stopId && segment.to_stop_id === routeStopIds[index + 1]
  ));
  let best = null;
  segments.forEach((segment, segmentIndex) => {
    if (!segment) return;
    const coordinates = features.get(segment.segment_id)?.coordinates;
    if (!coordinates || coordinates.length < 2) return;
    const lengths = coordinates.slice(0, -1).map((point, index) => roadDistanceKm(point, coordinates[index + 1]));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let traversed = 0;
    lengths.forEach((length, edgeIndex) => {
      const start = coordinates[edgeIndex], end = coordinates[edgeIndex + 1];
      const meanLat = (start[1] + end[1] + latitude) / 3 * Math.PI / 180;
      const sx = start[0] * 111.32 * Math.cos(meanLat), sy = start[1] * 110.574;
      const ex = end[0] * 111.32 * Math.cos(meanLat), ey = end[1] * 110.574;
      const px = longitude * 111.32 * Math.cos(meanLat), py = latitude * 110.574;
      const dx = ex - sx, dy = ey - sy;
      const fraction = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy || 1)));
      const distance = Math.hypot(px - sx - fraction * dx, py - sy - fraction * dy);
      if (!best || distance < best.distanceKm) {
        best = {
          distanceKm: distance,
          segmentIndex,
          fraction: total ? (traversed + length * fraction) / total : 0,
          point: [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction]
        };
      }
      traversed += length;
    });
  });
  return best;
}

function updateTrackerPosition(position) {
  const status = state.status;
  const lat = position.coords.latitude, lng = position.coords.longitude;
  const stops = [...status.stops].sort((a, b) => a.sequence_order - b.sequence_order);
  const direction = $('#track-direction').value;
  const target = stops.find((stop) => stop.stop_id === $('#dropoff-stop').value);
  const nearest = stops.reduce((best, stop) => {
    const distance = roadDistanceKm([lng, lat], [stop.lng, stop.lat]);
    return !best || distance < best.distance ? { stop, distance } : best;
  }, null);
  const projected = nearestRoadPosition(status, lat, lng);
  const destinationIndex = stops.findIndex((stop) => stop.stop_id === target?.stop_id);
  const durationById = new Map(status.segments.map((segment) => [segment.segment_id, Number(segment.live_duration_sec)]));
  let etaSeconds = null;
  if (projected && destinationIndex >= 0) {
    if (direction === 'northbound' && destinationIndex > projected.segmentIndex) {
      const current = status.segments[projected.segmentIndex];
      etaSeconds = (1 - projected.fraction) * durationById.get(current.segment_id);
      for (let index = projected.segmentIndex + 1; index < destinationIndex; index += 1) etaSeconds += durationById.get(status.segments[index].segment_id);
    } else if (direction === 'southbound' && destinationIndex <= projected.segmentIndex) {
      const current = status.segments[projected.segmentIndex];
      etaSeconds = projected.fraction * durationById.get(current.segment_id);
      for (let index = projected.segmentIndex - 1; index >= destinationIndex; index -= 1) etaSeconds += durationById.get(status.segments[index].segment_id);
    }
  } else if (destinationIndex >= 0 && nearest) {
    const nearestIndex = stops.findIndex((stop) => stop.stop_id === nearest.stop.stop_id);
    if (direction === 'northbound' && destinationIndex > nearestIndex) {
      etaSeconds = status.segments.slice(nearestIndex, destinationIndex)
        .reduce((sum, segment) => sum + durationById.get(segment.segment_id), 0);
    } else if (direction === 'southbound' && destinationIndex < nearestIndex) {
      etaSeconds = status.segments.slice(destinationIndex, nearestIndex)
        .reduce((sum, segment) => sum + durationById.get(segment.segment_id), 0);
    }
  }
  const etaCopy = etaSeconds == null ? 'Destination may be behind you on this trip.' : `Estimated time to ${shortName(target.stop_name)}: ${formatDuration(etaSeconds)}.`;
  $('#track-status').textContent = tracker.alertedStopId === target?.stop_id
    ? `Para Alert: You are within 500 m of ${shortName(target.stop_name)}.`
    : `Nearest checkpoint: ${shortName(nearest.stop.stop_name)} · ${etaCopy}`;
  if (state.mapReady && window.L) {
    if (!state.trackerMarker) {
      state.trackerMarker = window.L.circleMarker([lat, lng], {
        radius: 8, color: '#fff', weight: 2, fillColor: '#8655a7', fillOpacity: 1
      }).bindPopup('Your location stays on this device.').addTo(state.map);
    } else state.trackerMarker.setLatLng([lat, lng]);
  }

  if (target && nearest && roadDistanceKm([lng, lat], [target.lng, target.lat]) <= 0.5 && tracker.alertedStopId !== target.stop_id) {
    tracker.alertedStopId = target.stop_id;
    if (navigator.vibrate) navigator.vibrate([250, 100, 250]);
    try {
      const audio = tracker.audioContext;
      if (audio) {
        if (audio.state === 'suspended') audio.resume().catch(() => {});
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.frequency.value = 880;
        gain.gain.value = 0.12;
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start();
        oscillator.stop(audio.currentTime + 0.35);
      }
    } catch { /* vibration remains available when browser audio is blocked */ }
  }
}

function setDropoffOptions(stops) {
  const select = $('#dropoff-stop');
  select.replaceChildren();
  stops.forEach((stop) => {
    const option = document.createElement('option');
    option.value = stop.stop_id;
    option.textContent = `${stop.stop_name} — ${(stop.landmarks || []).join(', ')}`;
    select.append(option);
  });
  select.value = stops.at(-1)?.stop_id || '';
  updateDropoffLandmarks();
}

function updateDropoffLandmarks() {
  const stop = state.status?.stops.find((item) => item.stop_id === $('#dropoff-stop').value);
  $('#dropoff-landmarks').textContent = stop?.landmarks?.join(' · ') || 'No landmark notes available.';
  tracker.alertedStopId = null;
}

function toggleTracking() {
  const button = $('#track-me');
  if (tracker.watchId != null) {
    navigator.geolocation.clearWatch(tracker.watchId);
    tracker.watchId = null;
    state.trackerMarker?.remove();
    state.trackerMarker = null;
    tracker.audioContext?.close().catch(() => {});
    tracker.audioContext = null;
    button.querySelector('span:first-child').textContent = 'Just Track Me';
    $('#track-status').textContent = 'Tracking stopped. Your location was not uploaded.';
    return;
  }
  if (!window.isSecureContext || !navigator.geolocation) {
    $('#track-status').textContent = 'Browser location requires HTTPS or localhost and location permission.';
    return;
  }
  try {
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (AudioContextType) {
      tracker.audioContext = new AudioContextType();
      tracker.audioContext.resume().catch(() => {});
    }
  } catch {
    tracker.audioContext = null;
  }
  button.querySelector('span:first-child').textContent = 'Stop tracking';
  $('#track-status').textContent = 'Waiting for a GPS fix… Your location stays in this browser.';
  tracker.watchId = navigator.geolocation.watchPosition(updateTrackerPosition, (error) => {
    $('#track-status').textContent = error.code === 1 ? 'Location permission was denied.' : 'Location is unavailable. Try again where GPS reception is clearer.';
    if (error.code === 1) {
      navigator.geolocation.clearWatch(tracker.watchId);
      tracker.watchId = null;
      state.trackerMarker?.remove();
      state.trackerMarker = null;
      tracker.audioContext?.close().catch(() => {});
      tracker.audioContext = null;
      button.querySelector('span:first-child').textContent = 'Just Track Me';
    }
  }, { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 });
}

function updateMapRouteCopy(status) {
  const hasRoadRoute = status?.geometry_quality === 'osm_road_route';
  $('#map-caption').textContent = !hasRoadRoute
    ? 'OpenStreetMap streets · road route unavailable'
    : 'OpenStreetMap streets · road-following corridor route';
  $('#map-footnote-copy').textContent = !hasRoadRoute
    ? 'Road-following line could not be loaded. Stop locations are approximate planning anchors.'
    : 'Corridor line follows mapped roads; stop locations are approximate planning anchors.';
}

function drawSchematic(status, waves) {
  const svg = $('#schematic');
  svg.style.display = 'block';
  $('#osm-map').style.display = 'none';
  const stops = status.stops;
  const roadFeatures = status.shape?.features || [];
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
      const level = feature.properties?.congestion_level;
      return { color: level === 'SEVERE' ? '#d16d53' : level === 'MODERATE' ? '#e5b34d' : '#32896b', weight: 4, opacity: 0.88, dashArray: '7 6' };
    }
  }).addTo(state.map);
  state.stopLayer = L.layerGroup().addTo(state.map);
  state.waveLayer = L.layerGroup().addTo(state.map);
  state.mapReady = true;
  updateOsmLayers(status, waves);
  const routePoints = (status.shape?.features || []).flatMap((feature) => feature.geometry?.coordinates || [])
    .map(([lng, lat]) => [lat, lng]);
  const bounds = L.latLngBounds([...status.stops.map((stop) => [stop.lat, stop.lng]), ...routePoints]);
  state.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 11 });
  window.setTimeout(() => state.map?.invalidateSize(), 0);
  updateMapRouteCopy(status);
  return true;
}

function updateRoadRouteLayer(status) {
  if (!state.mapReady || !state.routeLayer || !status) return;
  const features = status.shape?.features || [];
  state.routeLayer.clearLayers();
  state.routeLayer.addData({ type: 'FeatureCollection', features });
}

function updateOsmLayers(status, waves) {
  if (!state.mapReady || !window.L) return;
  updateRoadRouteLayer(status);
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
  updateMapRouteCopy(status);
  $('#data-mode').textContent = status.source === 'live_routing' ? 'Live routing estimate' : status.source === 'mixed' ? 'Mixed traffic estimate' : 'Baseline estimate';
  const connectionDot = $('.topbar-meta .live-dot');
  connectionDot.style.background = hasCurrentRouting ? '#91c9a8' : '#a9b7ae';
  connectionDot.style.boxShadow = hasCurrentRouting ? '0 0 0 4px #91c9a81f' : '0 0 0 4px #a9b7ae20';
  const rainStatus = status.weather?.raining ? `Rain alert · ${status.weather.multiplier.toFixed(2)}× travel adjustment.` : 'No rain delay adjustment.';
  $('#summary-source').textContent = `${status.source === 'live_routing' ? 'TomTom traffic data' : 'Historical / seeded baseline'} · ${rainStatus}`;
  const bottlenecks = $('#bottleneck-list');
  bottlenecks.innerHTML = status.bottlenecks.length ? status.bottlenecks.map((item) => `<div class="bottleneck-item ${item.congestion_level === 'SEVERE' ? 'severe' : ''}"><strong>${escapeHtml(item.from_stop)} → ${escapeHtml(item.to_stop)}</strong><br>${formatDuration(item.live_duration_sec)} · ${item.congestion_level.toLowerCase()} estimate</div>`).join('') : '';
  const incidentList = $('#incident-list');
  incidentList.innerHTML = (status.incidents || []).map((incident) =>
    `<div class="incident-item"><strong>Road incident</strong>${incident.from || incident.to ? ` · ${escapeHtml([incident.from, incident.to].filter(Boolean).join(' → '))}` : ''}${incident.description ? `<br>${escapeHtml(incident.description)}` : ''}</div>`
  ).join('');
  if (status.weather?.raining) {
    incidentList.insertAdjacentHTML('afterbegin', `<div class="weather-alert">Rain alert · Open-Meteo · ${(status.weather.multiplier * 100 - 100).toFixed(0)}% travel-time adjustment</div>`);
  }
  if (state.mapReady) {
    updateOsmLayers(status, waves);
  } else drawSchematic(status, waves);
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
  const recommended = comparison.recommendation === 'direct' ? 'Direct trip' : `Cut trip via ${escapeHtml(comparison.best_cut_trip.transfer_stop)}`;
  const recommendedRoute = comparison.recommendation === 'direct' ? comparison.direct : comparison.best_cut_trip;
  const bottleneckWarnings = (recommendedRoute?.bottlenecks || []).map((item) => {
    const segment = state.status.segments.find((candidate) => candidate.segment_id === item.segment_id);
    const name = segment ? `${shortName(segment.from_stop)} → ${shortName(segment.to_stop)}` : item.segment_id;
    return `${name}: ${item.congestion_level.toLowerCase()} bottleneck (+${formatDuration(item.delay_sec)}).`;
  });
  const warnings = [...plan.warnings, ...bottleneckWarnings];
  const warningMarkup = warnings.length ? `<div class="result-warning">${warnings.map(escapeHtml).join('<br>')}</div>` : '';
  box.className = 'plan-result visible';
  box.innerHTML = `<span class="result-kicker">LEAVE HOME BY · ${plan.confidence_window_minutes} MIN CONFIDENCE WINDOW</span><strong class="result-time">${escapeHtml(plan.leave_home_by_pht)}</strong><div class="result-detail">${formatDuration(plan.breakdown.travel_time_sec)} travel + ${Math.round(plan.breakdown.headway_wait_sec / 60)} min typical service wait${plan.breakdown.last_mile_buffer_sec ? ` + ${Math.round(plan.breakdown.last_mile_buffer_sec / 60)} min last-mile buffer` : ''}.</div><div class="result-comparison">Suggested option: <strong>${recommended}</strong> · direct ${formatDuration(comparison.direct.total_time_sec)}${comparison.best_cut_trip ? ` · cut trip ${formatDuration(comparison.best_cut_trip.total_time_sec)}` : ''}</div>${warningMarkup}`;
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
  $('#map-maximize').addEventListener('click', () => {
    setMapMaximized(!$('.map-card').classList.contains('is-maximized'));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('.map-card').classList.contains('is-maximized')) setMapMaximized(false);
  });
  $('#planner-form').addEventListener('submit', submitPlan);
  $('#track-me').addEventListener('click', toggleTracking);
  $('#dropoff-stop').addEventListener('change', updateDropoffLandmarks);
  $('#track-direction').addEventListener('change', () => {
    if (!state.status) return;
    const stops = [...state.status.stops].sort((a, b) => a.sequence_order - b.sequence_order);
    $('#dropoff-stop').value = $('#track-direction').value === 'northbound' ? stops.at(-1).stop_id : stops[0].stop_id;
    updateDropoffLandmarks();
  });
  try {
    const corridorResponse = await fetch('/api/v1/corridors');
    if (!corridorResponse.ok) throw new Error('No active corridor is configured.');
    const corridors = await corridorResponse.json();
    CORRIDOR_ID = corridors.corridors[0]?.id;
    if (!CORRIDOR_ID) throw new Error('No active corridor is configured.');
    await refresh();
    setStopOptions(state.status.stops);
    setDropoffOptions(state.status.stops);
    window.setInterval(() => refresh().catch(() => {}), 60_000);
  } catch (error) {
    $('#data-mode').textContent = 'Waiting for local server';
    $('#summary-source').textContent = error.message;
    $('#schematic').innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#73827d" font-size="13">Start the Byahe30 server to load corridor data.</text>';
  }
}

initialize();
