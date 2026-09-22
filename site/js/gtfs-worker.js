// Classic worker: unzips the static GTFS and parses the handful of columns the
// checks need into typed arrays, then transfers them back to the page.
importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

const DEC = new TextDecoder('utf-8');

function post(type, payload, transfer) { self.postMessage(Object.assign({ type }, payload), transfer || []); }
function progress(phase, pct) { post('progress', { phase, pct }); }

// --- growable typed arrays -------------------------------------------------

function Grow(Type, initial) {
  let a = new Type(initial || 1 << 14);
  let n = 0;
  return {
    push(v) {
      if (n === a.length) { const b = new Type(a.length * 2); b.set(a); a = b; }
      a[n++] = v;
    },
    get length() { return n; },
    take() { return a.slice(0, n); },
  };
}

// --- CSV ------------------------------------------------------------------

// Scans raw bytes and hands each row a `field(index)` accessor, so only the
// columns we actually want ever become JS strings.
function scanCsv(bytes, onHeader, onRow, onProgress) {
  const n = bytes.length;
  let i = 0;
  if (n >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) i = 3;

  const starts = [], ends = [], quoted = [];
  let ncol = 0;
  let header = null;
  let nextTick = 1 << 21;

  function field(k) {
    if (k < 0 || k >= ncol) return '';
    const s = starts[k], e = ends[k];
    if (e <= s) return '';
    const str = DEC.decode(bytes.subarray(s, e));
    return quoted[k] ? str.replace(/""/g, '"') : str;
  }
  // Integer straight from the bytes, no string allocation. -1 when not a number.
  function int(k) {
    if (k < 0 || k >= ncol) return -1;
    let s = starts[k], e = ends[k], v = 0, any = false;
    while (s < e) {
      const c = bytes[s++];
      if (c < 48 || c > 57) { if (c === 32) continue; return -1; }
      v = v * 10 + (c - 48); any = true;
    }
    return any ? v : -1;
  }

  while (i < n) {
    ncol = 0;
    let eol = false;
    while (!eol) {
      let s, e, q = false;
      if (bytes[i] === 34) {
        q = true; i++; s = i;
        while (i < n) {
          if (bytes[i] === 34) {
            if (bytes[i + 1] === 34) { i += 2; continue; }
            break;
          }
          i++;
        }
        e = i;
        if (i < n) i++;
        while (i < n && bytes[i] !== 44 && bytes[i] !== 10 && bytes[i] !== 13) i++;
      } else {
        s = i;
        while (i < n && bytes[i] !== 44 && bytes[i] !== 10 && bytes[i] !== 13) i++;
        e = i;
      }
      starts[ncol] = s; ends[ncol] = e; quoted[ncol] = q; ncol++;
      if (i >= n) eol = true;
      else if (bytes[i] === 44) i++;
      else {
        if (bytes[i] === 13) i++;
        if (i < n && bytes[i] === 10) i++;
        eol = true;
      }
    }
    if (header === null) {
      header = [];
      for (let k = 0; k < ncol; k++) header.push(field(k).trim());
      if (onHeader(header) === false) return;
    } else if (!(ncol === 1 && ends[0] === starts[0])) {
      onRow(field, int, ncol);
    }
    if (onProgress && i > nextTick) { nextTick = i + (1 << 21); onProgress(i / n); }
  }
}

// Resolves header names to column indices, tolerating unexpected column order.
function cols(header, names) {
  const out = {};
  for (const name of names) out[name] = header.indexOf(name);
  return out;
}

// --- interning -------------------------------------------------------------

function Interner() {
  const map = new Map();
  const ids = [];
  return {
    map, ids,
    intern(id) {
      let v = map.get(id);
      if (v === undefined) { v = ids.length; ids.push(id); map.set(id, v); }
      return v;
    },
    lookup(id) { const v = map.get(id); return v === undefined ? -1 : v; },
  };
}

// Rearranges flat (owner, value) rows into compressed per-owner slices.
function toCsr(ownerIdx, count, payloads) {
  const n = ownerIdx.length;
  const offset = new Uint32Array(count + 1);
  for (let i = 0; i < n; i++) offset[ownerIdx[i] + 1]++;
  for (let i = 0; i < count; i++) offset[i + 1] += offset[i];
  const cursor = offset.slice(0, count);
  const out = payloads.map((p) => new p.constructor(n));
  for (let i = 0; i < n; i++) {
    const at = cursor[ownerIdx[i]]++;
    for (let k = 0; k < payloads.length; k++) out[k][at] = payloads[k][i];
  }
  return { offset, arrays: out };
}

// Per-owner sort by `key`, only touching slices that are not already ordered.
function sortWithin(offset, key, others) {
  const count = offset.length - 1;
  const idx = [];
  for (let t = 0; t < count; t++) {
    const s = offset[t], e = offset[t + 1];
    let ordered = true;
    for (let i = s + 1; i < e; i++) if (key[i] < key[i - 1]) { ordered = false; break; }
    if (ordered) continue;
    idx.length = 0;
    for (let i = s; i < e; i++) idx.push(i);
    idx.sort((a, b) => key[a] - key[b]);
    const k2 = idx.map((i) => key[i]);
    const o2 = others.map((arr) => idx.map((i) => arr[i]));
    for (let j = 0; j < idx.length; j++) {
      key[s + j] = k2[j];
      for (let m = 0; m < others.length; m++) others[m][s + j] = o2[m][j];
    }
  }
}

// --- the parse -------------------------------------------------------------

function parse(buffer) {
  const warnings = [];
  progress('Unzipping', 0);
  let files;
  try {
    files = fflate.unzipSync(new Uint8Array(buffer));
  } catch (e) {
    throw new Error('Could not read the zip: ' + e.message);
  }

  // Agencies sometimes nest the feed one folder deep.
  const byName = new Map();
  for (const path of Object.keys(files)) {
    const base = path.split('/').pop();
    if (base && base.endsWith('.txt')) byName.set(base, files[path]);
  }
  const present = [...byName.keys()].sort();
  if (!byName.has('stops.txt') || !byName.has('trips.txt')) {
    throw new Error('This zip has no stops.txt or no trips.txt, so it is not a GTFS feed. Files found: ' + (present.join(', ') || 'none'));
  }

  // stops.txt
  progress('Reading stops.txt', 0);
  const stopI = Interner();
  const stopName = [];
  const stopLat = Grow(Float64Array), stopLon = Grow(Float64Array), stopLocType = Grow(Uint8Array);
  {
    let c = null;
    scanCsv(byName.get('stops.txt'),
      (h) => { c = cols(h, ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type']); },
      (f, int) => {
        stopI.intern(f(c.stop_id));
        stopName.push(f(c.stop_name));
        const la = parseFloat(f(c.stop_lat)), lo = parseFloat(f(c.stop_lon));
        stopLat.push(Number.isFinite(la) ? la : NaN);
        stopLon.push(Number.isFinite(lo) ? lo : NaN);
        const lt = int(c.location_type);
        stopLocType.push(lt < 0 ? 0 : lt);
      });
  }

  // routes.txt
  const routeI = Interner();
  const routeName = [];
  if (byName.has('routes.txt')) {
    let c = null;
    scanCsv(byName.get('routes.txt'),
      (h) => { c = cols(h, ['route_id', 'route_short_name', 'route_long_name']); },
      (f) => {
        routeI.intern(f(c.route_id));
        routeName.push(f(c.route_short_name) || f(c.route_long_name));
      });
  } else {
    warnings.push('No routes.txt: route names and the mixed-route check are unavailable.');
  }

  // trips.txt
  progress('Reading trips.txt', 0);
  const tripI = Interner();
  const serviceI = Interner();
  const shapeI = Interner();
  const tripRoute = Grow(Int32Array), tripService = Grow(Int32Array), tripShape = Grow(Int32Array), tripDir = Grow(Int8Array);
  {
    let c = null;
    scanCsv(byName.get('trips.txt'),
      (h) => { c = cols(h, ['trip_id', 'route_id', 'service_id', 'shape_id', 'direction_id']); },
      (f, int) => {
        tripI.intern(f(c.trip_id));
        const r = c.route_id >= 0 ? routeI.lookup(f(c.route_id)) : -1;
        tripRoute.push(r);
        tripService.push(c.service_id >= 0 ? serviceI.intern(f(c.service_id)) : -1);
        const sh = c.shape_id >= 0 ? f(c.shape_id) : '';
        tripShape.push(sh ? shapeI.intern(sh) : -1);
        const d = int(c.direction_id);
        tripDir.push(d < 0 ? -1 : d);
      });
  }
  const tripCount = tripI.ids.length;

  // stop_times.txt — the big one.
  let stOffset = new Uint32Array(tripCount + 1);
  let stStop = new Uint32Array(0), stSeq = new Uint32Array(0);
  if (byName.has('stop_times.txt')) {
    progress('Reading stop_times.txt', 0);
    const rowTrip = Grow(Uint32Array, 1 << 18);
    const rowStop = Grow(Uint32Array, 1 << 18);
    const rowSeq = Grow(Uint32Array, 1 << 18);
    let c = null;
    let lastTripStr = null, lastTripIdx = -1;
    let unknownTrips = 0, unknownStops = 0;
    scanCsv(byName.get('stop_times.txt'),
      (h) => { c = cols(h, ['trip_id', 'stop_id', 'stop_sequence']); },
      (f, int) => {
        // Rows come grouped by trip, so the id string is usually a repeat.
        const t = f(c.trip_id);
        let ti;
        if (t === lastTripStr) ti = lastTripIdx;
        else { ti = tripI.lookup(t); lastTripStr = t; lastTripIdx = ti; }
        if (ti < 0) { unknownTrips++; return; }
        const si = stopI.lookup(f(c.stop_id));
        if (si < 0) { unknownStops++; return; }
        rowTrip.push(ti); rowStop.push(si);
        const q = int(c.stop_sequence);
        rowSeq.push(q < 0 ? 0 : q);
      },
      (pct) => progress('Reading stop_times.txt', pct));
    if (unknownTrips) warnings.push(unknownTrips + ' stop_times rows name a trip_id that is not in trips.txt; they were dropped.');
    if (unknownStops) warnings.push(unknownStops + ' stop_times rows name a stop_id that is not in stops.txt; they were dropped.');
    progress('Indexing stop_times', 0.9);
    const csr = toCsr(rowTrip.take(), tripCount, [rowStop.take(), rowSeq.take()]);
    stOffset = csr.offset; stStop = csr.arrays[0]; stSeq = csr.arrays[1];
    sortWithin(stOffset, stSeq, [stStop]);
  } else {
    warnings.push('No stop_times.txt: the stop_sequence and retained-stop checks are unavailable.');
  }

  // calendar.txt / calendar_dates.txt
  progress('Reading calendar', 0);
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  let svcMask = new Uint8Array(0), svcStart = new Int32Array(0), svcEnd = new Int32Array(0);
  const hasCalendar = byName.has('calendar.txt');
  if (hasCalendar) {
    const mask = new Map(), start = new Map(), end = new Map();
    let c = null;
    scanCsv(byName.get('calendar.txt'),
      (h) => { c = cols(h, ['service_id'].concat(DAYS, ['start_date', 'end_date'])); },
      (f, int) => {
        const s = serviceI.intern(f(c.service_id));
        let m = 0;
        for (let d = 0; d < 7; d++) if (int(c[DAYS[d]]) === 1) m |= (1 << d);
        mask.set(s, m);
        start.set(s, int(c.start_date));
        end.set(s, int(c.end_date));
      });
    const n = serviceI.ids.length;
    svcMask = new Uint8Array(n); svcStart = new Int32Array(n); svcEnd = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      svcMask[i] = mask.get(i) || 0;
      svcStart[i] = start.has(i) ? start.get(i) : 0;
      svcEnd[i] = end.has(i) ? end.get(i) : 0;
    }
  } else if (byName.has('calendar_dates.txt')) {
    warnings.push('No calendar.txt: service days come from calendar_dates.txt alone.');
  }

  const exceptions = new Map(); // serviceIdx -> Map(YYYYMMDD -> 1 added | 2 removed)
  const hasCalendarDates = byName.has('calendar_dates.txt');
  if (hasCalendarDates) {
    let c = null;
    scanCsv(byName.get('calendar_dates.txt'),
      (h) => { c = cols(h, ['service_id', 'date', 'exception_type']); },
      (f, int) => {
        const s = serviceI.intern(f(c.service_id));
        let m = exceptions.get(s);
        if (!m) { m = new Map(); exceptions.set(s, m); }
        m.set(int(c.date), int(c.exception_type));
      });
  } else if (!hasCalendar) {
    warnings.push('Neither calendar.txt nor calendar_dates.txt is present: the service-date check will be skipped.');
  }
  // Services interned late (only in calendar_dates) still need mask slots.
  if (svcMask.length < serviceI.ids.length) {
    const n = serviceI.ids.length;
    const m2 = new Uint8Array(n); m2.set(svcMask); svcMask = m2;
    const s2 = new Int32Array(n); s2.set(svcStart); svcStart = s2;
    const e2 = new Int32Array(n); e2.set(svcEnd); svcEnd = e2;
  }

  // shapes.txt
  progress('Reading shapes.txt', 0);
  let shOffset = new Uint32Array(1), shLat = new Float32Array(0), shLon = new Float32Array(0);
  if (byName.has('shapes.txt')) {
    const rowShape = Grow(Uint32Array, 1 << 16);
    const rowLat = Grow(Float32Array, 1 << 16), rowLon = Grow(Float32Array, 1 << 16), rowSeq = Grow(Uint32Array, 1 << 16);
    let c = null, lastStr = null, lastIdx = -1;
    scanCsv(byName.get('shapes.txt'),
      (h) => { c = cols(h, ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence']); },
      (f, int) => {
        const s = f(c.shape_id);
        let si;
        if (s === lastStr) si = lastIdx;
        else { si = shapeI.intern(s); lastStr = s; lastIdx = si; }
        rowShape.push(si);
        rowLat.push(parseFloat(f(c.shape_pt_lat)));
        rowLon.push(parseFloat(f(c.shape_pt_lon)));
        const q = int(c.shape_pt_sequence);
        rowSeq.push(q < 0 ? 0 : q);
      },
      (pct) => progress('Reading shapes.txt', pct));
    const csr = toCsr(rowShape.take(), shapeI.ids.length, [rowLat.take(), rowLon.take(), rowSeq.take()]);
    shOffset = csr.offset;
    shLat = csr.arrays[0]; shLon = csr.arrays[1];
    sortWithin(shOffset, csr.arrays[2], [shLat, shLon]);
  } else {
    warnings.push('No shapes.txt: shape_id collisions cannot be detected and the original path will not be drawn.');
    shOffset = new Uint32Array(shapeI.ids.length + 1);
  }

  progress('Done', 1);
  const data = {
    files: present,
    warnings,
    stops: { ids: stopI.ids, names: stopName, lat: stopLat.take(), lon: stopLon.take(), locationType: stopLocType.take() },
    routes: { ids: routeI.ids, names: routeName },
    trips: {
      ids: tripI.ids,
      routeIdx: tripRoute.take(), serviceIdx: tripService.take(),
      shapeIdx: tripShape.take(), directionId: tripDir.take(),
      stOffset, stStopIdx: stStop, stSeq,
    },
    services: { ids: serviceI.ids, mask: svcMask, start: svcStart, end: svcEnd, exceptions, hasCalendar, hasCalendarDates },
    shapes: { ids: shapeI.ids, offset: shOffset, lat: shLat, lon: shLon },
  };
  const transfer = [
    data.stops.lat.buffer, data.stops.lon.buffer, data.stops.locationType.buffer,
    data.trips.routeIdx.buffer, data.trips.serviceIdx.buffer, data.trips.shapeIdx.buffer, data.trips.directionId.buffer,
    data.trips.stOffset.buffer, data.trips.stStopIdx.buffer, data.trips.stSeq.buffer,
    data.services.mask.buffer, data.services.start.buffer, data.services.end.buffer,
    data.shapes.offset.buffer, data.shapes.lat.buffer, data.shapes.lon.buffer,
  ];
  post('done', { data }, transfer);
}

self.onmessage = (ev) => {
  if (ev.data && ev.data.type === 'parse') {
    try { parse(ev.data.buffer); }
    catch (e) { post('error', { message: e && e.message ? e.message : String(e) }); }
  }
};
