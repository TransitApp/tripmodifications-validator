import { Gtfs } from './gtfs.js';
import { decodeFeed, loadProto } from './rt.js';
import { fetchUrl, readFile, getProxy, setProxy, formatBytes, CorsError } from './inputs.js';
import { validate, DEFAULT_SETTINGS } from './validate.js';
import { CODE_TITLES } from './findings.js';
import { toJson, toMarkdown, download } from './report.js';
import { PlanMap } from './map.js';
import { findingGeo, miniMapSvg, MAPPABLE_CODES } from './minimap.js';

const SETTINGS_KEY = 'tmv.settings';
const MINIMAPS_KEY = 'tmv.miniMaps';

const SLOTS = ['static', 'mods', 'tripupdates', 'alerts'];
const state = {
  files: {},            // slot -> { name, source, buffer }
  settings: loadSettings(),
  result: null,
  gtfs: null,
  planMap: null,
  miniMaps: readMiniMapPref(),
  rendered: [],          // the finding behind each lazily drawn mini-map
  mapObserver: null,
};

function readMiniMapPref() {
  try { return localStorage.getItem(MINIMAPS_KEY) !== 'off'; } catch (e) { return true; }
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// --- settings --------------------------------------------------------------

function loadSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { /* ignore */ }
  return Object.assign({}, DEFAULT_SETTINGS, stored);
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
}

function bindSettings() {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const el = $('#set-' + key);
    if (!el) continue;
    el.value = state.settings[key];
    el.addEventListener('change', () => {
      const v = Number(el.value);
      state.settings[key] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS[key];
      el.value = state.settings[key];
      saveSettings();
    });
  }
  const proxy = $('#set-proxy');
  proxy.value = getProxy();
  proxy.addEventListener('change', () => setProxy(proxy.value.trim()));

  const maps = $('#set-minimaps');
  maps.checked = state.miniMaps;
  maps.addEventListener('change', () => {
    state.miniMaps = maps.checked;
    try { localStorage.setItem(MINIMAPS_KEY, maps.checked ? 'on' : 'off'); } catch (e) { /* ignore */ }
    if (state.result) renderFindings();
  });
}

// --- inputs ----------------------------------------------------------------

function slotCard(slot) { return document.querySelector(`.input-card[data-slot="${slot}"]`); }

function setSlotStatus(slot, text, kind) {
  const p = slotCard(slot).querySelector('.slot-status');
  p.textContent = text;
  p.className = 'slot-status' + (kind ? ' ' + kind : '');
}

function acceptBuffer(slot, name, source, buffer) {
  state.files[slot] = { name, source, buffer };
  slotCard(slot).querySelector('.drop').classList.add('filled');
  setSlotStatus(slot, `${name} — ${formatBytes(buffer.byteLength)}`, 'ok');
  refreshValidateButton();
}

function clearSlot(slot) {
  delete state.files[slot];
  const card = slotCard(slot);
  card.querySelector('.drop').classList.remove('filled');
  card.querySelector('input[type="url"]').value = '';
  card.querySelector('input[type="file"]').value = '';
  setSlotStatus(slot, slot === 'static' || slot === 'mods' ? 'Nothing loaded.' : 'Not loaded.');
  refreshValidateButton();
}

function refreshValidateButton() {
  $('#validate').disabled = !(state.files.static && state.files.mods);
}

function bindSlot(slot) {
  const card = slotCard(slot);
  const drop = card.querySelector('.drop');
  const fileInput = card.querySelector('input[type="file"]');
  const urlInput = card.querySelector('input[type="url"]');
  const loadBtn = card.querySelector('.load');

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) takeFile(slot, file);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) takeFile(slot, fileInput.files[0]); });

  loadBtn.addEventListener('click', () => takeUrl(slot, urlInput.value.trim()));
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); takeUrl(slot, urlInput.value.trim()); } });
}

async function takeFile(slot, file) {
  setSlotStatus(slot, `Reading ${file.name}…`);
  try {
    const buf = await readFile(file, (pct) => setSlotStatus(slot, `Reading ${file.name}… ${Math.round((pct || 0) * 100)}%`));
    acceptBuffer(slot, file.name, 'local file', buf);
  } catch (e) {
    setSlotStatus(slot, e.message, 'bad');
  }
}

async function takeUrl(slot, url) {
  if (!url) { setSlotStatus(slot, 'Type a URL first, or drop a file.', 'bad'); return; }
  setSlotStatus(slot, 'Fetching…');
  try {
    const buf = await fetchUrl(url, (pct, bytes) => {
      setSlotStatus(slot, pct === null ? `Fetching… ${formatBytes(bytes)}` : `Fetching… ${Math.round(pct * 100)}%`);
    });
    acceptBuffer(slot, url.split('/').pop() || url, url, buf);
  } catch (e) {
    setSlotStatus(slot, e.message, 'bad');
    if (e instanceof CorsError) $('#cors-note').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// --- progress and banners --------------------------------------------------

function showProgress(label, pct) {
  $('#progress').hidden = false;
  $('#progress-label').textContent = label;
  $('#progress-fill').style.width = Math.round((pct || 0) * 100) + '%';
}

function hideProgress() { $('#progress').hidden = true; }

function banner(text, kind) {
  const el = $('#banner');
  el.hidden = false;
  el.textContent = text;
  el.className = 'banner ' + (kind || '');
}

function clearBanner() { $('#banner').hidden = true; }

// --- the run ---------------------------------------------------------------

function parseStatic(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./gtfs-worker.js', import.meta.url));
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') showProgress(m.phase, m.pct);
      else if (m.type === 'done') { worker.terminate(); resolve(m.data); }
      else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error('The parsing worker failed: ' + e.message)); };
    worker.postMessage({ type: 'parse', buffer }, [buffer]);
  });
}

async function run() {
  clearBanner();
  $('#validate').disabled = true;
  $('#results').hidden = true;
  const t0 = performance.now();

  try {
    showProgress('Loading gtfs-realtime.proto', 0.02);
    await loadProto();

    // The buffer is transferred to the worker, so keep a note of what it was.
    const staticEntry = state.files.static;
    showProgress('Unzipping the static GTFS', 0.05);
    const raw = await parseStatic(staticEntry.buffer);
    staticEntry.buffer = null;
    const gtfs = new Gtfs(raw);
    state.gtfs = gtfs;

    showProgress('Decoding the TripModifications feed', 0.85);
    const modsFeed = await decodeFeed(state.files.mods.buffer, 'The TripModifications feed');
    const alertsFeed = state.files.alerts ? await decodeFeed(state.files.alerts.buffer, 'The Alerts feed') : null;
    const tuFeed = state.files.tripupdates ? await decodeFeed(state.files.tripupdates.buffer, 'The TripUpdates feed') : null;

    showProgress('Running the checks', 0.92);
    await new Promise((r) => setTimeout(r, 0));
    const out = validate({ modsFeed, gtfs, alertsFeed, tuFeed, settings: state.settings });

    state.result = {
      findings: out.findings,
      model: out.model,
      summary: out.summary,
      settings: Object.assign({}, state.settings),
      sources: Object.fromEntries(SLOTS.map((s) => [s, state.files[s] ? state.files[s].source : null])),
    };

    hideProgress();
    const seconds = ((performance.now() - t0) / 1000).toFixed(1);
    const parts = [`Validated in ${seconds}s.`];
    if (raw.warnings.length) parts.push(...raw.warnings);
    banner(parts.join('\n'), raw.warnings.length ? 'warn' : 'good');
    render();
  } catch (e) {
    hideProgress();
    banner(e.message, 'bad');
  } finally {
    refreshValidateButton();
  }
}

// --- rendering -------------------------------------------------------------

function render() {
  const { summary, findings } = state.result;
  $('#results').hidden = false;

  const stats = [
    ['Entities', summary.totalEntities],
    ['TripModifications', summary.entityCounts.trip_modifications || 0],
    ['Shape entities', summary.entityCounts.shape || 0],
    ['Stop entities', summary.entityCounts.stop || 0],
    ['Modifications', summary.modifications],
    ['Distinct trips', summary.distinctTrips],
    ['Service dates', summary.serviceDates.length],
  ];
  if (summary.alertEntities !== null) stats.push(['Alerts', summary.alertEntities]);
  if (summary.tripUpdateEntities !== null) stats.push(['TripUpdates', summary.tripUpdateEntities]);
  stats.push(['Errors', summary.errors, 'error'], ['Warnings', summary.warnings, 'warning'], ['Information', summary.infos]);

  $('#summary').innerHTML = stats.map(([k, n, cls]) =>
    `<div class="stat ${cls || ''}"><div class="n">${n}</div><div class="k">${esc(k)}</div></div>`).join('');

  const skipped = $('#skipped');
  if (findings.skipped.length) {
    skipped.innerHTML = '<strong>Checks that did not run:</strong><ul>' +
      findings.skipped.map((s) => `<li>${esc(s.what)} — ${esc(s.why)}.</li>`).join('') + '</ul>';
  } else {
    skipped.innerHTML = '';
  }
  if (summary.serviceDates.length) {
    skipped.innerHTML += `<p>Service dates covered: <span class="mono">${summary.serviceDates.join(' ')}</span></p>`;
  }

  renderFindings();
  renderEntityPicker();
}

function renderFindings() {
  const wanted = new Set($$('.sev:checked').map((c) => c.value));
  const q = $('#finding-search').value.trim().toLowerCase();
  const groups = state.result.findings.grouped().filter((g) => wanted.has(g.severity));

  const matches = (g) => {
    if (!q) return true;
    if (g.code.toLowerCase().includes(q)) return true;
    if ((CODE_TITLES[g.code] || '').toLowerCase().includes(q)) return true;
    return g.items.some((i) => i.message.toLowerCase().includes(q) ||
      Object.values(i.context).some((v) => String(v).toLowerCase().includes(q)));
  };

  const shown = groups.filter(matches);
  const el = $('#findings-list');
  if (!shown.length) {
    el.innerHTML = `<p class="empty">${groups.length ? 'Nothing matches that search.' : 'No findings at this severity.'}</p>`;
    return;
  }

  state.rendered = [];
  el.innerHTML = shown.map((g) => {
    const items = q
      ? g.items.filter((i) => i.message.toLowerCase().includes(q) || Object.values(i.context).some((v) => String(v).toLowerCase().includes(q)))
      : g.items;
    const all = items.length ? items : g.items;
    const list = all.slice(0, 300);
    const extra = all.length - list.length;
    const drawable = state.miniMaps && MAPPABLE_CODES.has(g.code);
    return `<details class="group ${g.severity}">
      <summary>
        <span class="title">${esc(CODE_TITLES[g.code] || g.code)}</span>
        <span class="code">${esc(g.code)}</span>
        <span class="count">${g.items.length}</span>
      </summary>
      <ol class="${drawable ? 'with-maps' : ''}">${list.map((i) => findingRow(i, drawable)).join('')}
      ${extra > 0 ? `<li class="more">…and ${extra} more; the full list is in the JSON export.</li>` : ''}</ol>
    </details>`;
  }).join('');

  watchMiniMaps();
}

// The picture is only built once the row is actually on screen: a group can
// hold hundreds of findings and each one needs its shape cropped and projected.
function findingRow(finding, drawable) {
  if (!drawable) return `<li>${esc(finding.message)}</li>`;
  const idx = state.rendered.push(finding) - 1;
  return `<li class="has-map"><div class="mm-slot" data-finding="${idx}"></div><div class="mm-text">${esc(finding.message)}</div></li>`;
}

function watchMiniMaps() {
  if (state.mapObserver) state.mapObserver.disconnect();
  const slots = $$('#findings-list .mm-slot');
  if (!slots.length) return;
  state.mapObserver = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      obs.unobserve(e.target);
      drawSlot(e.target);
    }
  }, { rootMargin: '200px' });
  for (const slot of slots) state.mapObserver.observe(slot);
}

function drawSlot(slot) {
  const finding = state.rendered[Number(slot.dataset.finding)];
  if (!finding) return;
  let geo = null;
  try { geo = findingGeo(finding, state.result.model, state.gtfs); } catch (e) { geo = null; }
  if (!geo) { slot.classList.add('mm-none'); slot.textContent = 'no geometry'; return; }
  const c = finding.context || {};
  slot.innerHTML = miniMapSvg(geo, state.gtfs, state.result.model) +
    `<button type="button" class="mm-open" data-entity="${esc(c.entity === undefined ? '' : c.entity)}" ` +
    `data-trip="${esc(c.trip === undefined ? (geo.plan ? geo.plan.tripId : '') : c.trip)}" ` +
    `data-stop="${esc(c.stop === undefined ? '' : c.stop)}">Open in map</button>`;
}

// Jumps the big Leaflet map to whatever a finding is about.
function openInMap(entityId, tripId, stopId) {
  const entities = state.result.model.entities;
  const ei = entities.findIndex((e) => e.id === entityId);
  if (ei < 0) return;
  $('#entity-select').value = String(ei);
  renderTripPicker();
  const plans = entities[ei].plans;
  let pi = plans.findIndex((p) => p.tripId === tripId);
  if (pi < 0) pi = plans.findIndex((p) => p.sharedWith && p.sharedWith.includes(tripId));
  if (pi >= 0) { $('#trip-select').value = String(pi); renderInspector(); }
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'map'));
  for (const name of ['findings', 'inspector', 'map']) $('#panel-' + name).hidden = name !== 'map';
  renderMap(stopId || null);
}

function renderEntityPicker() {
  const sel = $('#entity-select');
  const entities = state.result.model.entities;
  sel.innerHTML = entities.map((e, i) => `<option value="${i}">${esc(e.id)} — ${e.plans.length} trip pattern(s)</option>`).join('');
  if (!entities.length) {
    $('#inspector-body').innerHTML = '<p class="empty">This feed has no TripModifications entities.</p>';
    $('#trip-select').innerHTML = '';
    return;
  }
  sel.value = '0';
  renderTripPicker();
}

function renderTripPicker() {
  const ent = state.result.model.entities[Number($('#entity-select').value)];
  const sel = $('#trip-select');
  sel.innerHTML = ent.plans.map((p, i) => {
    const extra = p.missing ? ' (not in trips.txt)' : (p.sharedWith.length ? ` (+${p.sharedWith.length} alike)` : '');
    return `<option value="${i}">${esc(p.tripId)}${extra}</option>`;
  }).join('');
  sel.value = '0';
  renderInspector();
}

function currentPlan() {
  const entities = state.result.model.entities;
  const ent = entities[Number($('#entity-select').value)];
  if (!ent) return null;
  const plan = ent.plans[Number($('#trip-select').value)];
  return plan ? { ent, plan } : null;
}

function renderInspector() {
  const body = $('#inspector-body');
  const cur = currentPlan();
  if (!cur) { body.innerHTML = '<p class="empty">Nothing to show.</p>'; return; }
  const { ent, plan } = cur;
  const gtfs = state.gtfs;

  if (plan.missing) {
    body.innerHTML = `<p class="empty">Trip <span class="mono">${esc(plan.tripId)}</span> is not in trips.txt, so there is nothing to lay out.</p>`;
    return;
  }

  const meta = [
    ['Entity id', ent.id],
    ['Service dates', (ent.mods.service_dates || []).join(' ') || '—'],
    ['Trip', plan.tripId],
    ['Route', gtfs ? (gtfs.tripRouteId(plan.tripId) || '—') : '—'],
    ['Direction', gtfs && gtfs.tripDirection(plan.tripId) !== null ? String(gtfs.tripDirection(plan.tripId)) : '—'],
    ['New shape_id', plan.shapeId === undefined ? '— (none set)' : plan.shapeId],
    ['Shape source', plan.shapeSource === 'feed' ? 'Shape entity in this feed' : plan.shapeSource === 'static' ? 'shapes.txt' : 'unresolved'],
    ['Shape points', plan.points ? plan.points.length : 0],
    ['Trips with this pattern', 1 + plan.sharedWith.length],
  ];

  const ranges = plan.ranges.map((r) => {
    const startTxt = describeSelector(r.mod.start_stop_selector, r.start, plan);
    const endTxt = r.mod.end_stop_selector ? describeSelector(r.mod.end_stop_selector, r.end, plan) : 'not set (pure insertion)';
    const delay = r.mod.propagated_modification_delay === undefined ? 'not set' : r.mod.propagated_modification_delay + ' s';
    return `<tr>
      <td class="num">${r.modIndex}</td>
      <td>${esc(startTxt)}</td>
      <td>${esc(endTxt)}</td>
      <td class="num">${(r.mod.replacement_stops || []).length}</td>
      <td>${esc(delay)}</td>
      <td class="mono">${esc(r.mod.service_alert_id === undefined ? '—' : String(r.mod.service_alert_id))}</td>
    </tr>`;
  }).join('');

  const far = state.settings.retainedStopM;
  const rows = plan.rows.map((row) => {
    const name = (gtfs && gtfs.stopName(row.stopId)) || '';
    const d = row.distanceM === undefined ? '—' : row.distanceM + ' m';
    const isFar = row.kind === 'kept' && row.distanceM !== undefined && row.distanceM > far;
    return `<tr class="${row.kind}">
      <td class="mono">${esc(row.stopId)}</td>
      <td>${esc(name)}</td>
      <td>${row.kind}</td>
      <td class="num">${row.sequence === undefined ? '—' : row.sequence}</td>
      <td class="num">${row.travelTime === undefined ? '' : row.travelTime + ' s'}</td>
      <td class="num ${isFar ? 'far' : ''}">${d}</td>
    </tr>`;
  }).join('');

  body.innerHTML = `
    <div class="inspector-meta">${meta.map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="mono">${esc(String(v))}</span></div>`).join('')}</div>
    <h3>Modifications</h3>
    <table><thead><tr><th>#</th><th>Start</th><th>End</th><th>Replacements</th><th>Propagated delay</th><th>Alert id</th></tr></thead>
    <tbody>${ranges || '<tr><td colspan="6">None.</td></tr>'}</tbody></table>
    <h3>Stops after the modifications</h3>
    <table><thead><tr><th>stop_id</th><th>Name</th><th>Outcome</th><th>stop_sequence</th><th>travel_time</th><th>Distance to new shape</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function describeSelector(sel, res, plan) {
  if (!sel) return 'not set';
  const bits = [];
  if (sel.stop_sequence !== undefined) bits.push('stop_sequence ' + sel.stop_sequence);
  if (sel.stop_id !== undefined) bits.push('stop_id ' + sel.stop_id);
  let txt = bits.join(', ') || 'empty selector';
  if (res && res.index >= 0 && !res.reason) txt += ` → stop ${plan.stops.stopIds[res.index]} (position ${res.index + 1} of ${plan.stops.stopIds.length})`;
  else if (res && res.reason) txt += ` → unresolved (${res.reason})`;
  return txt;
}

async function renderMap(focusStopId) {
  const cur = currentPlan();
  const holder = $('#map');
  if (!cur || cur.plan.missing) { holder.innerHTML = '<p class="empty" style="padding:16px">Nothing to draw for this trip.</p>'; return; }
  if (!state.planMap) state.planMap = new PlanMap(holder);
  try {
    await state.planMap.show(cur.plan, state.gtfs, state.result.model, focusStopId);
  } catch (e) {
    holder.innerHTML = `<p class="empty" style="padding:16px">${esc(e.message)}</p>`;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --- wiring ----------------------------------------------------------------

SLOTS.forEach(bindSlot);
bindSettings();
refreshValidateButton();

$('#validate').addEventListener('click', run);
$('#clear').addEventListener('click', () => {
  SLOTS.forEach(clearSlot);
  state.result = null;
  state.gtfs = null;
  $('#results').hidden = true;
  clearBanner();
});

// A link may fill the URL boxes in: ?static=…&mods=…&tripupdates=…&alerts=…
// Nothing is requested until you press Fetch, so a link cannot make this page
// go and get something on its own.
function prefillFromQuery() {
  const params = new URLSearchParams(location.search);
  const filled = [];
  for (const slot of SLOTS) {
    const value = params.get(slot);
    if (!value) continue;
    let parsed;
    try { parsed = new URL(value, location.href); } catch (e) { continue; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    slotCard(slot).querySelector('input[type="url"]').value = parsed.href;
    filled.push(slot);
  }
  if (filled.length) {
    banner(`${filled.length} URL(s) came from the link. Press Fetch on each one — nothing has been requested yet. ` +
      'When a fetch fails because the server sends no CORS headers, download the file and drop it in.', 'warn');
  }
}
prefillFromQuery();

$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  for (const name of ['findings', 'inspector', 'map']) $('#panel-' + name).hidden = name !== tab.dataset.tab;
  if (tab.dataset.tab === 'map') renderMap();
}));

$('#findings-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.mm-open');
  if (!btn) return;
  openInMap(btn.dataset.entity, btn.dataset.trip, btn.dataset.stop);
});

// A group that opens has rows the observer has not seen yet.
$('#findings-list').addEventListener('toggle', (e) => {
  if (e.target.tagName === 'DETAILS' && e.target.open) watchMiniMaps();
}, true);

$$('.sev').forEach((c) => c.addEventListener('change', () => { if (state.result) renderFindings(); }));
$('#finding-search').addEventListener('input', () => { if (state.result) renderFindings(); });
$('#entity-select').addEventListener('change', () => { renderTripPicker(); if (!$('#panel-map').hidden) renderMap(); });
$('#trip-select').addEventListener('change', () => { renderInspector(); if (!$('#panel-map').hidden) renderMap(); });

$('#export-json').addEventListener('click', () => {
  if (state.result) download('tripmodifications-report.json', toJson(state.result), 'application/json');
});
$('#export-md').addEventListener('click', () => {
  if (state.result) download('tripmodifications-report.md', toMarkdown(state.result), 'text/markdown');
});

// A file dropped anywhere else lands in the first slot that fits it.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (e.target.closest('.drop')) return;
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  if (/\.zip$/i.test(file.name)) takeFile('static', file);
  else if (/\.pb$/i.test(file.name) || /\.bin$/i.test(file.name)) {
    const slot = /alert/i.test(file.name) ? 'alerts' : /update/i.test(file.name) ? 'tripupdates' : 'mods';
    takeFile(slot, file);
  }
});
