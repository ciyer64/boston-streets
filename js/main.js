// ── Section config ────────────────────────────────────────────────────────────

const BOROUGH_META = {
  boston:     { name: 'Boston',     color: '#1a1a1a', bounds: [[-71.191, 42.228], [-71.020, 42.400]] },
  cambridge:  { name: 'Cambridge',  color: '#3a3a3a', bounds: [[-71.160, 42.352], [-71.064, 42.404]] },
  brookline:  { name: 'Brookline',  color: '#5a5a5a', bounds: [[-71.179, 42.295], [-71.106, 42.352]] },
  somerville: { name: 'Somerville', color: '#787878', bounds: [[-71.135, 42.373], [-71.073, 42.418]] },
};

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  view: 'overview',
  activeBorough: null,
  streetNames: {},
  progress: Object.fromEntries(
    Object.keys(BOROUGH_META).map(b => [b, { guessed: new Set(), total: 0 }])
  ),
};

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem('boston-street-progress') || '{}');
    for (const [b, guessed] of Object.entries(saved)) {
      if (state.progress[b]) state.progress[b].guessed = new Set(guessed);
    }
  } catch (e) { /* ignore */ }
}

function saveProgress() {
  const serialisable = Object.fromEntries(
    Object.entries(state.progress).map(([b, p]) => [b, [...p.guessed]])
  );
  localStorage.setItem('boston-street-progress', JSON.stringify(serialisable));
}

// ── Map setup ─────────────────────────────────────────────────────────────────

const isMobile = () => window.innerWidth <= 767;

// Overall bounds: capped at inner harbour edge (-71.01) — outer harbour masked
const BOSTON_BOUNDS = [[-71.25, 42.20], [-71.01, 42.44]];

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [-71.10, 42.34],
  zoom: 12,
  minZoom: 9,
  maxZoom: 17,
  maxBounds: [[-71.50, 42.05], [-70.70, 42.60]],
  attributionControl: false,
});

map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

map.on('load', async () => {
  applyLightMapStyle();

  map.fitBounds(BOSTON_BOUNDS, {
    padding: isMobile()
      ? { top: 200, bottom: 60, left: 20, right: 20 }
      : { top: 60,  bottom: 40, left: 40, right: 360 },
    duration: 0,
  });

  loadProgress();
  await loadBoroughBoundaries();
  await loadSummary();
  setupOverviewInteractions();
  updateScorePanel();

  map.once('idle', () => {
    const cover = document.getElementById('map-cover');
    cover.style.opacity = '0';
    cover.addEventListener('transitionend', () => cover.remove(), { once: true });
  });
});

function applyLightMapStyle() {
  const WHITE  = '#f8f6f2';
  const LAND   = '#f0ede8';
  const WATER  = '#dce8f2';
  const ROAD   = '#e2ddd7';
  const BORDER = '#d0ccc6';

  map.getStyle().layers.forEach(layer => {
    const id  = layer.id;
    const src = layer['source-layer'];

    if (id === 'background') {
      map.setPaintProperty(id, 'background-color', WHITE);
      return;
    }
    if (src === 'place' || src === 'aerodrome_label') {
      map.setLayoutProperty(id, 'visibility', 'none');
      return;
    }
    if (src === 'transportation_name') {
      map.removeLayer(id);
      return;
    }
    if (src === 'water' || src === 'waterway' || src === 'water_name') {
      if (layer.type === 'fill')   map.setPaintProperty(id, 'fill-color', WATER);
      if (layer.type === 'line')   map.setPaintProperty(id, 'line-color', WATER);
      if (layer.type === 'symbol') map.setLayoutProperty(id, 'visibility', 'none');
      return;
    }
    if (layer.type === 'fill') {
      map.setPaintProperty(id, 'fill-color', LAND);
      map.setPaintProperty(id, 'fill-opacity', 1);
      return;
    }
    if (src === 'transportation' && layer.type === 'line') {
      map.setPaintProperty(id, 'line-color', ROAD);
      map.setPaintProperty(id, 'line-opacity', 0.8);
      return;
    }
    if (src === 'boundary' && layer.type === 'line') {
      map.setPaintProperty(id, 'line-color', BORDER);
      map.setPaintProperty(id, 'line-opacity', 0.4);
      return;
    }
    if (layer.type === 'symbol') map.setLayoutProperty(id, 'visibility', 'none');
    if (layer.type === 'line')   map.setPaintProperty(id, 'line-opacity', 0.1);
  });
}

// ── Data loading ──────────────────────────────────────────────────────────────

// Compute signed area of a ring (positive = CCW, negative = CW)
function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  }
  return a;
}

// Build inverted polygon: CCW outer rectangle + CW borough holes.
// Auto-detects and normalises ring winding so it works with any source data.
function buildMaskFeature(features) {
  const outer = [[-180, -90], [-180, 90], [180, 90], [180, -90], [-180, -90]]; // CCW
  const holes = [];
  for (const f of features) {
    const geom = f.geometry;
    const rings = geom.type === 'Polygon'      ? [geom.coordinates[0]]
                : geom.type === 'MultiPolygon' ? geom.coordinates.map(p => p[0])
                : [];
    for (const ring of rings) {
      // Hole must be CW; reverse if ring is CCW (positive signed area)
      holes.push(signedArea(ring) > 0 ? [...ring].reverse() : ring);
    }
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [outer, ...holes] } };
}

async function loadBoroughBoundaries() {
  const res     = await fetch('data/sections.geojson');
  const geojson = await res.json();

  map.addSource('boston-mask', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [buildMaskFeature(geojson.features)] },
  });
  map.addLayer({
    id: 'boston-mask-fill', type: 'fill', source: 'boston-mask',
    paint: { 'fill-color': '#f8f6f2', 'fill-opacity': 1 },
  });

  // Outer harbour mask: Boston's polygon extends far east to include Brewster Islands etc.
  // Cover everything east of the inner harbour with the background colour.
  map.addSource('harbour-mask', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-71.005, 42.10], [-70.60, 42.10],
          [-70.60, 42.55], [-71.005, 42.55],
          [-71.005, 42.10],
        ]],
      },
    },
  });
  map.addLayer({
    id: 'harbour-mask-fill', type: 'fill', source: 'harbour-mask',
    paint: { 'fill-color': '#f8f6f2', 'fill-opacity': 1 },
  });

  map.addSource('boroughs', { type: 'geojson', data: geojson, generateId: true });

  map.addLayer({
    id: 'boroughs-fill', type: 'fill', source: 'boroughs',
    paint: {
      'fill-color': buildColorMatch(),
      'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.55, 0.30],
    },
  });

  map.addLayer({
    id: 'boroughs-outline', type: 'line', source: 'boroughs',
    paint: { 'line-color': buildColorMatch(), 'line-width': 2, 'line-opacity': 0.9 },
  });
}

async function loadSummary() {
  const res     = await fetch('data/summary.json');
  const summary = await res.json();
  for (const [section, stats] of Object.entries(summary)) {
    if (state.progress[section]) state.progress[section].total = stats.street_count;
  }
}

async function loadBoroughStreets(boroughId) {
  if (state.streetNames[boroughId]) return;
  const res = await fetch(`data/${boroughId}_names.json`);
  state.streetNames[boroughId] = await res.json();
}

async function loadBoroughGeoJSON(boroughId) {
  const res = await fetch(`data/${boroughId}.geojson`);
  return res.json();
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function buildColorMatch() {
  const expr = ['match', ['get', 'borough_id']];
  for (const [id, meta] of Object.entries(BOROUGH_META)) expr.push(id, meta.color);
  expr.push('#aaa');
  return expr;
}

// ── Overview interactions ─────────────────────────────────────────────────────

let hoveredId = null;

function setupOverviewInteractions() {
  map.on('mousemove', 'boroughs-fill', (e) => {
    if (!e.features.length) return;
    if (hoveredId !== null) map.setFeatureState({ source: 'boroughs', id: hoveredId }, { hover: false });
    hoveredId = e.features[0].id;
    map.setFeatureState({ source: 'boroughs', id: hoveredId }, { hover: true });
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', 'boroughs-fill', () => {
    if (hoveredId !== null) map.setFeatureState({ source: 'boroughs', id: hoveredId }, { hover: false });
    hoveredId = null;
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'boroughs-fill', (e) => {
    const boroughId = e.features[0]?.properties?.borough_id;
    if (boroughId) enterBorough(boroughId);
  });
}

// ── Section detail view ───────────────────────────────────────────────────────

async function enterBorough(boroughId) {
  const meta = BOROUGH_META[boroughId];
  state.view = 'borough';
  state.activeBorough = boroughId;

  map.fitBounds(meta.bounds, {
    padding: isMobile()
      ? { top: 150, bottom: 90, left: 20, right: 20 }
      : 60,
    duration: 800,
  });

  await Promise.all([loadBoroughStreets(boroughId), addStreetLayers(boroughId)]);

  document.getElementById('score-panel').classList.add('hidden');
  document.getElementById('overview-prompt').classList.add('hidden');
  document.getElementById('detail-panel').classList.remove('hidden');
  document.getElementById('detail-name').textContent = meta.name;

  foundOrder.length = 0;
  foundOrder.push(...[...state.progress[boroughId].guessed].sort());

  map.setPaintProperty('boroughs-fill', 'fill-opacity', [
    'case', ['==', ['get', 'borough_id'], boroughId], 0.0, 0.06,
  ]);
  map.setPaintProperty('boroughs-outline', 'line-opacity', [
    'case', ['==', ['get', 'borough_id'], boroughId], 0.9, 0.2,
  ]);

  updateDetailPanel();
  updateFoundList(boroughId);
  setupGuessInput();

  if (isMobile()) {
    document.getElementById('found-list').classList.add('mobile-hidden');
    document.getElementById('found-header').classList.remove('list-open');
  }
}

async function addStreetLayers(boroughId) {
  const sourceId = `streets-${boroughId}`;
  if (map.getSource(sourceId)) return;

  const geojson = await loadBoroughGeoJSON(boroughId);
  map.addSource(sourceId, { type: 'geojson', data: geojson });

  map.addLayer({
    id: `${sourceId}-dim`, type: 'line', source: sourceId,
    paint: { 'line-color': '#888', 'line-width': 1, 'line-opacity': 0.25 },
  });

  map.addLayer({
    id: `${sourceId}-lit`, type: 'line', source: sourceId,
    filter: buildGuessedFilter(boroughId),
    paint: { 'line-color': '#1a1a1a', 'line-width': 2.5, 'line-opacity': 0.9 },
  });
}

function buildGuessedFilter(boroughId) {
  const guessed = [...state.progress[boroughId].guessed];
  if (guessed.length === 0) return ['==', 'name', '__none__'];
  return ['in', ['get', 'name'], ['literal', guessed]];
}

function refreshStreetLayer(boroughId) {
  const litLayerId = `streets-${boroughId}-lit`;
  if (map.getLayer(litLayerId)) map.setFilter(litLayerId, buildGuessedFilter(boroughId));
}

// ── Guess input ───────────────────────────────────────────────────────────────

function setupGuessInput() {
  const input    = document.getElementById('guess-input');
  const feedback = document.getElementById('guess-feedback');
  const fresh    = input.cloneNode(true);
  input.parentNode.replaceChild(fresh, input);
  fresh.value = '';
  fresh.focus();

  fresh.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const guess = fresh.value.trim();
    fresh.value = '';
    if (!guess) return;
    handleGuess(guess, feedback);
    fresh.focus();
  });
}

window.addEventListener('keydown', (e) => {
  if (state.view !== 'borough') return;
  if (e.target?.id === 'guess-input') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length !== 1 && e.key !== 'Backspace') return;
  const input = document.getElementById('guess-input');
  if (input) input.focus();
});

const ABBREVS = [
  [/\bAve\.?$/i,   'Avenue'],
  [/\bSt\.?$/i,    'Street'],
  [/\bBlvd\.?$/i,  'Boulevard'],
  [/\bDr\.?$/i,    'Drive'],
  [/\bRd\.?$/i,    'Road'],
  [/\bLn\.?$/i,    'Lane'],
  [/\bPl\.?$/i,    'Place'],
  [/\bCt\.?$/i,    'Court'],
  [/\bPkwy\.?$/i,  'Parkway'],
  [/\bTer\.?$/i,   'Terrace'],
  [/\bHwy\.?$/i,   'Highway'],
  [/\bExpy\.?$/i,  'Expressway'],
];

function expandAbbreviations(s) {
  let out = s.trim();
  for (const [re, full] of ABBREVS) {
    if (re.test(out)) { out = out.replace(re, full); break; }
  }
  return out;
}

function handleGuess(raw, feedbackEl) {
  const boroughId = state.activeBorough;
  const names     = state.streetNames[boroughId] || [];
  const progress  = state.progress[boroughId];
  const q         = expandAbbreviations(raw).toLowerCase().trim();

  const exact = names.find(n => n.toLowerCase() === q);
  if (exact) {
    if (progress.guessed.has(exact)) { showFeedback(feedbackEl, `Already got ${exact}`, 'already'); return; }
    progress.guessed.add(exact);
    saveProgress(); refreshStreetLayer(boroughId); updateDetailPanel();
    updateFoundList(boroughId, exact); updateScorePanel();
    showFeedback(feedbackEl, `✓ ${exact}`, 'correct');
    return;
  }

  const matches = names.filter(n => n.toLowerCase().startsWith(q + ' '));
  if (matches.length === 0) { showFeedback(feedbackEl, '', ''); return; }

  const fresh = matches.filter(m => !progress.guessed.has(m));
  if (fresh.length === 0) {
    const label = matches.length === 1 ? matches[0] : `${matches[0]} (+${matches.length - 1})`;
    showFeedback(feedbackEl, `Already got ${label}`, 'already');
    return;
  }

  fresh.forEach(m => progress.guessed.add(m));
  saveProgress(); refreshStreetLayer(boroughId); updateDetailPanel();
  fresh.forEach(m => updateFoundList(boroughId, m));
  updateScorePanel();

  const label = fresh.length === 1 ? `✓ ${fresh[0]}` : `✓ ${fresh[0]} (+${fresh.length - 1} more)`;
  showFeedback(feedbackEl, label, 'correct');
}

let feedbackTimer = null;
function showFeedback(el, msg, cls) {
  el.textContent = msg;
  el.className = cls;
  clearTimeout(feedbackTimer);
  if (msg) feedbackTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, 1800);
}

// ── Back to overview ──────────────────────────────────────────────────────────

document.getElementById('back-btn').addEventListener('click', () => {
  state.view = 'overview';
  state.activeBorough = null;

  map.fitBounds(BOSTON_BOUNDS, {
    padding: isMobile()
      ? { top: 200, bottom: 60, left: 20, right: 20 }
      : { top: 60,  bottom: 40, left: 40, right: 360 },
    duration: 800,
  });

  document.getElementById('detail-panel').classList.add('hidden');
  document.getElementById('score-panel').classList.remove('hidden');
  document.getElementById('overview-prompt').classList.remove('hidden');
  document.getElementById('found-list').classList.remove('mobile-hidden');
  document.getElementById('found-header').classList.remove('list-open');

  map.setPaintProperty('boroughs-fill', 'fill-opacity', [
    'case', ['boolean', ['feature-state', 'hover'], false], 0.35, 0.18
  ]);
  map.setPaintProperty('boroughs-outline', 'line-opacity', 0.7);
});

// ── Score panel ───────────────────────────────────────────────────────────────

function updateScorePanel() {
  let totalGuessed = 0, totalStreets = 0;
  const list = document.getElementById('borough-list');
  list.innerHTML = '';

  for (const [id, meta] of Object.entries(BOROUGH_META)) {
    const { guessed, total } = state.progress[id];
    const count = guessed.size;
    const pct   = total > 0 ? Math.round(100 * count / total) : 0;
    totalGuessed += count;
    totalStreets += total;

    const row = document.createElement('div');
    row.className = 'borough-row';
    row.innerHTML = `
      <div style="width:100%">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="borough-dot" style="background:${meta.color}"></span>
          <span class="borough-label">${meta.name}</span>
          <span class="borough-pct">${pct}%</span>
        </div>
        <div class="borough-mini-bar-wrap">
          <div class="borough-mini-bar" style="width:${pct}%;background:${meta.color}"></div>
        </div>
      </div>`;
    row.addEventListener('click', () => enterBorough(id));
    list.appendChild(row);
  }

  const overallPct = totalStreets > 0 ? Math.round(100 * totalGuessed / totalStreets) : 0;
  document.getElementById('overall-pct').textContent = `${overallPct}%`;
  document.getElementById('overall-bar').style.width = `${overallPct}%`;
}

function formatPct(count, total) {
  if (total === 0) return '0%';
  const pct = 100 * count / total;
  if (pct === 0) return '0%';
  if (pct < 1)   return pct.toFixed(1) + '%';
  return Math.round(pct) + '%';
}

const foundOrder = [];

function updateFoundList(boroughId, newStreet = null) {
  const header = document.getElementById('found-header');
  const list   = document.getElementById('found-list');
  const { guessed } = state.progress[boroughId];

  if (guessed.size === 0) { header.classList.add('hidden'); list.classList.add('hidden'); return; }

  if (newStreet && !foundOrder.includes(newStreet)) foundOrder.unshift(newStreet);

  header.classList.remove('hidden');
  list.classList.remove('hidden');
  document.getElementById('found-count').textContent =
    `${guessed.size} street${guessed.size === 1 ? '' : 's'} found`;

  const total = foundOrder.length;
  list.innerHTML = '';
  foundOrder.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'found-row';
    row.innerHTML = `<span class="found-name">${name}</span><span class="found-num">#${total - i}</span>`;
    list.appendChild(row);
  });

  if (newStreet) list.scrollTop = 0;
}

function updateDetailPanel() {
  const boroughId = state.activeBorough;
  const { guessed, total } = state.progress[boroughId];
  const count = guessed.size;
  const pct   = total > 0 ? 100 * count / total : 0;

  document.getElementById('detail-pct').textContent = formatPct(count, total);
  document.getElementById('detail-bar').style.width = `${pct}%`;
  document.getElementById('detail-bar').style.background = '#1a1a1a';
  document.getElementById('detail-count').textContent = `${count} of ${total} streets`;
}

// ── Mobile: tap found-header to show/hide the list ────────────────────────────
document.getElementById('found-header').addEventListener('click', () => {
  if (!isMobile()) return;
  const list   = document.getElementById('found-list');
  const header = document.getElementById('found-header');
  const isHidden = list.classList.toggle('mobile-hidden');
  header.classList.toggle('list-open', !isHidden);
});
