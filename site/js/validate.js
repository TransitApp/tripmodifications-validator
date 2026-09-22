import { Findings, ERROR, WARNING } from './findings.js';
import { decodePolyline, distanceToPath, duplicateConsecutive, haversineish } from './geo.js';
import { toDate, todayYmd } from './gtfs.js';

export const DEFAULT_SETTINGS = {
  shapeEndpointM: 200,   // how far a new shape may start/end from the trip's terminus
  retainedStopM: 80,     // how far a kept stop may sit from the new shape
  removedStopM: 40,      // below this, a removed stop still looks served
  clockSkewMinutes: 10,  // header timestamp tolerance
  pastDateGraceDays: 1,  // service_dates older than this are flagged
};

// --- the model ------------------------------------------------------------

// Turns the raw feed into the shape the checks want to ask questions of.
export function buildModel(feed, gtfs) {
  const entities = [];
  const shapesById = new Map();   // Shape.shape_id -> { entityId, raw, points, error }
  const shapeEntities = [];       // every Shape entity, including duplicate shape_ids
  const stopsById = new Map();    // Stop.stop_id -> { entityId, raw }
  const alertsById = new Map();
  const entityIdCounts = new Map();

  for (const e of feed.entity || []) {
    const id = e.id === undefined ? '' : String(e.id);
    entityIdCounts.set(id, (entityIdCounts.get(id) || 0) + 1);
    if (e.trip_modifications) entities.push({ id, mods: e.trip_modifications });
    if (e.shape) {
      const sid = e.shape.shape_id;
      const rec = { entityId: id, raw: e.shape, points: null, error: null };
      if (e.shape.encoded_polyline) {
        try { rec.points = decodePolyline(e.shape.encoded_polyline); }
        catch (err) { rec.error = err.message; }
      }
      rec.shapeId = sid;
      if (sid !== undefined && !shapesById.has(sid)) shapesById.set(sid, rec);
      shapeEntities.push(rec);
    }
    if (e.stop) {
      const sid = e.stop.stop_id;
      if (sid !== undefined && !stopsById.has(sid)) stopsById.set(sid, { entityId: id, raw: e.stop });
    }
    if (e.alert) alertsById.set(id, e.alert);
  }

  // Resolve every entity down to per-trip stop plans, which both the checks
  // and the inspector read.
  for (const ent of entities) ent.plans = resolveEntity(ent, gtfs, shapesById);

  return { entities, shapesById, stopsById, alertsById, entityIdCounts, shapeEntities };
}

function selectedTripIds(mods) {
  const out = [];
  for (const st of mods.selected_trips || []) for (const t of st.trip_ids || []) out.push(t);
  return out;
}

// Where in a trip's stop list a StopSelector points. Returns -1 when it does
// not resolve, along with the reason.
function resolveSelector(sel, stops) {
  if (!sel) return { index: -1, reason: 'missing' };
  const hasSeq = sel.stop_sequence !== undefined;
  const hasId = sel.stop_id !== undefined;
  if (!hasSeq && !hasId) return { index: -1, reason: 'empty' };
  if (hasSeq) {
    const i = stops.sequences.indexOf(sel.stop_sequence);
    if (i < 0) return { index: -1, reason: 'sequence-not-in-trip' };
    if (hasId && stops.stopIds[i] !== sel.stop_id) {
      return { index: i, reason: 'id-sequence-mismatch', actualStopId: stops.stopIds[i] };
    }
    return { index: i, reason: null };
  }
  const i = stops.stopIds.indexOf(sel.stop_id);
  if (i < 0) return { index: -1, reason: 'stop-not-in-trip' };
  return { index: i, reason: null };
}

// For each selected trip, the stop-by-stop outcome of applying the
// modifications. Trips whose stop pattern is identical share one plan.
function resolveEntity(ent, gtfs, shapesById) {
  const plans = [];
  if (!gtfs) return plans;
  const byPattern = new Map();
  for (const st of ent.mods.selected_trips || []) {
    for (const tripId of st.trip_ids || []) {
      const stops = gtfs.tripStops(tripId);
      if (!stops) { plans.push({ tripId, shapeId: st.shape_id, missing: true, sharedWith: [] }); continue; }
      const key = st.shape_id + '\u0000' + stops.stopIds.join('\u0001');
      const existing = byPattern.get(key);
      if (existing) { existing.sharedWith.push(tripId); continue; }
      const plan = buildPlan(ent, tripId, st.shape_id, stops, gtfs, shapesById);
      plan.sharedWith = [];
      byPattern.set(key, plan);
      plans.push(plan);
    }
  }
  return plans;
}

function buildPlan(ent, tripId, shapeId, stops, gtfs, shapesById) {
  const ranges = [];
  for (let m = 0; m < (ent.mods.modifications || []).length; m++) {
    const mod = ent.mods.modifications[m];
    const start = resolveSelector(mod.start_stop_selector, stops);
    const end = mod.end_stop_selector ? resolveSelector(mod.end_stop_selector, stops) : { index: null, reason: null };
    ranges.push({ modIndex: m, mod, start, end });
  }

  const rows = [];
  const ordered = ranges.filter((r) => r.start.index >= 0).sort((a, b) => a.start.index - b.start.index);
  let cursor = 0;
  for (const r of ordered) {
    for (let i = cursor; i < r.start.index && i < stops.stopIds.length; i++) {
      rows.push({ kind: 'kept', stopId: stops.stopIds[i], sequence: stops.sequences[i] });
    }
    cursor = Math.max(cursor, r.start.index);
    const endIdx = r.end.index === null ? null : (r.end.index >= 0 ? r.end.index : r.start.index);
    if (endIdx !== null) {
      for (let i = r.start.index; i <= endIdx && i < stops.stopIds.length; i++) {
        rows.push({ kind: 'removed', stopId: stops.stopIds[i], sequence: stops.sequences[i], modIndex: r.modIndex });
      }
      cursor = endIdx + 1;
    }
    for (const rs of r.mod.replacement_stops || []) {
      rows.push({ kind: 'inserted', stopId: rs.stop_id, travelTime: rs.travel_time_to_stop, modIndex: r.modIndex });
    }
  }
  for (let i = cursor; i < stops.stopIds.length; i++) {
    rows.push({ kind: 'kept', stopId: stops.stopIds[i], sequence: stops.sequences[i] });
  }

  const shapeRec = shapeId !== undefined ? shapesById.get(shapeId) : undefined;
  let points = shapeRec && shapeRec.points ? shapeRec.points : null;
  let shapeSource = points ? 'feed' : null;
  if (!points && shapeId !== undefined && gtfs.hasShapePoints(shapeId)) {
    points = gtfs.shapePoints(shapeId);
    shapeSource = 'static';
  }
  // A trip with no stop_times cannot resolve any selector, so the checks that
  // depend on the stop list skip it rather than failing every one.
  return { tripId, shapeId, stops, ranges, rows, points, shapeSource, missing: false, noStopTimes: stops.stopIds.length === 0 };
}

// --- checks ---------------------------------------------------------------

export function validate({ modsFeed, gtfs, alertsFeed, tuFeed, settings }) {
  const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const f = new Findings();
  const model = buildModel(modsFeed, gtfs);

  checkHeader(modsFeed, f, s, 'TripModifications feed');
  checkEntityIds(model, f);
  checkStructure(model, f, s, gtfs);
  if (gtfs) checkCrossRefs(model, f, s, gtfs);
  else f.skip('Cross-reference and geometry checks', 'no static GTFS was loaded');
  if (gtfs) checkGeometry(model, f, s, gtfs);

  if (alertsFeed) checkAlerts(model, alertsFeed, f, s, gtfs);
  else f.skip('service_alert_id and Alert checks', 'no Alerts feed was loaded');

  if (tuFeed) checkTripUpdates(model, tuFeed, f, s, gtfs);
  else f.skip('modified_trip / TripUpdates checks', 'no TripUpdates feed was loaded');

  return { findings: f, model, summary: summarize(model, modsFeed, alertsFeed, tuFeed, f) };
}

function checkHeader(feed, f, s, label) {
  const h = feed.header || {};
  if (!h.gtfs_realtime_version) {
    f.error('E_FEED_HEADER_VERSION', `${label}: header has no gtfs_realtime_version.`, { feed: label });
  }
  if (h.incrementality && h.incrementality !== 'FULL_DATASET') {
    f.warn('W_FEED_HEADER_INCREMENTALITY', `${label}: incrementality is ${h.incrementality}. TripModifications feeds are normally FULL_DATASET.`, { feed: label });
  }
  if (h.timestamp === undefined || h.timestamp === null) {
    f.error('E_FEED_HEADER_TIMESTAMP', `${label}: header has no timestamp.`, { feed: label });
  } else {
    const ts = Number(h.timestamp) * 1000;
    const skewMin = Math.round((Date.now() - ts) / 60000);
    if (Math.abs(skewMin) > s.clockSkewMinutes) {
      const when = new Date(ts).toISOString();
      f.warn('W_FEED_HEADER_TIMESTAMP_SKEW',
        `${label}: header timestamp is ${when}, ${Math.abs(skewMin)} minutes ${skewMin > 0 ? 'behind' : 'ahead of'} this browser's clock. ` +
        'Publishing local time as if it were UTC looks exactly like this.',
        { feed: label, timestamp: h.timestamp, iso: when, skewMinutes: skewMin });
    }
  }
}

function checkEntityIds(model, f) {
  for (const [id, n] of model.entityIdCounts) {
    if (n > 1) f.error('E_DUPLICATE_ENTITY_ID', `Entity id "${id}" is used by ${n} entities. Ids must be unique within a feed.`, { entity: id, count: n });
  }
}

function checkStructure(model, f, s, gtfs) {
  const today = todayYmd();
  const graceDate = shiftYmd(today, -s.pastDateGraceDays);

  for (const rec of model.shapeEntities) {
    const where = { entity: rec.entityId, shape: rec.shapeId };
    if (rec.shapeId === undefined || rec.shapeId === '') {
      f.error('E_SHAPE_NO_ID', `Shape entity "${rec.entityId}" has no shape_id.`, where);
    } else if (gtfs && gtfs.hasShapePoints(rec.shapeId)) {
      f.error('E_SHAPE_ID_COLLIDES', `Shape "${rec.shapeId}" also exists in shapes.txt. A Shape entity must use a shape_id that the static feed does not.`, where);
    }
    if (!rec.raw.encoded_polyline) {
      f.error('E_SHAPE_POLYLINE_INVALID', `Shape "${rec.shapeId}" has no encoded_polyline.`, where);
    } else if (rec.error) {
      f.error('E_SHAPE_POLYLINE_INVALID', `Shape "${rec.shapeId}" has an undecodable encoded_polyline: ${rec.error}.`, where);
    } else if (rec.points.length < 2) {
      f.error('E_SHAPE_POLYLINE_INVALID', `Shape "${rec.shapeId}" decodes to ${rec.points.length} point(s); a shape needs at least two.`, where);
    } else {
      const dupes = duplicateConsecutive(rec.points);
      if (dupes.length) {
        f.warn('W_SHAPE_DUPLICATE_POINTS', `Shape "${rec.shapeId}" repeats the previous point ${dupes.length} time(s), first at index ${dupes[0]}.`,
          Object.assign({ count: dupes.length, firstIndex: dupes[0] }, where));
      }
    }
  }

  for (const [stopId, rec] of model.stopsById) {
    const where = { entity: rec.entityId, stop: stopId };
    if (gtfs && gtfs.hasStop(stopId)) {
      f.error('E_STOP_ID_COLLIDES', `Stop "${stopId}" also exists in stops.txt. A Stop entity must use a stop_id that the static feed does not.`, where);
    }
    const missing = [];
    if (!stopId) missing.push('stop_id');
    if (!translated(rec.raw.stop_name)) missing.push('stop_name');
    if (rec.raw.stop_lat === undefined) missing.push('stop_lat');
    if (rec.raw.stop_lon === undefined) missing.push('stop_lon');
    if (missing.length) {
      f.error('E_STOP_MISSING_FIELDS', `Stop "${stopId || '(no id)'}" is missing ${missing.join(', ')}.`, Object.assign({ missing }, where));
    }
  }

  for (const ent of model.entities) {
    const m = ent.mods;
    const where = { entity: ent.id };
    const trips = selectedTripIds(m);

    if (!m.selected_trips || m.selected_trips.length === 0) {
      f.error('E_NO_SELECTED_TRIPS', `Entity "${ent.id}" has no selected_trips, so it affects nothing.`, where);
    } else {
      for (let i = 0; i < m.selected_trips.length; i++) {
        if (!(m.selected_trips[i].trip_ids || []).length) {
          f.error('E_SELECTED_TRIPS_EMPTY', `Entity "${ent.id}" selected_trips[${i}] lists no trip_ids.`, Object.assign({ index: i }, where));
        }
      }
    }
    if (!m.service_dates || m.service_dates.length === 0) {
      f.error('E_NO_SERVICE_DATES', `Entity "${ent.id}" has no service_dates, so it never applies.`, where);
    }
    if (!m.modifications || m.modifications.length === 0) {
      f.error('E_NO_MODIFICATIONS', `Entity "${ent.id}" has no modifications.`, where);
    }

    for (const d of m.service_dates || []) {
      if (!toDate(d)) {
        f.error('E_SERVICE_DATE_FORMAT', `Entity "${ent.id}" has service_date "${d}", which is not a valid YYYYMMDD date.`, Object.assign({ date: d }, where));
      } else if (d < graceDate) {
        f.warn('W_SERVICE_DATE_PAST', `Entity "${ent.id}" still publishes service_date ${d}, which is in the past.`, Object.assign({ date: d }, where));
      }
    }

    // start_times may only narrow a single trip of a single SelectedTrips.
    if ((m.start_times || []).length) {
      if ((m.selected_trips || []).length > 1 || trips.length > 1) {
        f.error('E_START_TIMES_MULTI_SELECTION',
          `Entity "${ent.id}" sets start_times but selects ${trips.length} trip_ids across ${(m.selected_trips || []).length} selected_trips. ` +
          'start_times may only be used with a single trip_id in a single SelectedTrips.',
          Object.assign({ tripCount: trips.length, selectionCount: (m.selected_trips || []).length }, where));
      }
    }

    checkModifications(ent, f, s);
  }
}

function checkModifications(ent, f, s) {
  const mods = ent.mods.modifications || [];
  const keys = [];
  for (let i = 0; i < mods.length; i++) {
    const mod = mods[i];
    const where = { entity: ent.id, modification: i };

    for (const [name, sel] of [['start_stop_selector', mod.start_stop_selector], ['end_stop_selector', mod.end_stop_selector]]) {
      if (sel && sel.stop_sequence === undefined && sel.stop_id === undefined) {
        f.error('E_STOP_SELECTOR_EMPTY', `Entity "${ent.id}" modification ${i}: ${name} sets neither stop_sequence nor stop_id; at least one is required.`,
          Object.assign({ selector: name }, where));
      }
    }
    if (!mod.start_stop_selector) {
      f.error('E_STOP_SELECTOR_EMPTY', `Entity "${ent.id}" modification ${i} has no start_stop_selector, which is required.`,
        Object.assign({ selector: 'start_stop_selector' }, where));
    }

    const replacements = mod.replacement_stops || [];
    if (!mod.end_stop_selector && replacements.length === 0) {
      f.error('E_MODIFICATION_NOOP',
        `Entity "${ent.id}" modification ${i} has no end_stop_selector and no replacement_stops, so it removes nothing and adds nothing. ` +
        'end_stop_selector may only be omitted for a pure insertion, and an insertion needs replacement_stops.',
        where);
    }

    const a = mod.start_stop_selector && mod.start_stop_selector.stop_sequence;
    const b = mod.end_stop_selector && mod.end_stop_selector.stop_sequence;
    if (a !== undefined && b !== undefined && b < a) {
      f.error('E_SELECTOR_ORDER', `Entity "${ent.id}" modification ${i}: end_stop_selector.stop_sequence ${b} is before start_stop_selector.stop_sequence ${a}.`,
        Object.assign({ start: a, end: b }, where));
    }
    keys.push({ i, start: a, end: b === undefined ? a : b });

    let lastTravel = null;
    for (let k = 0; k < replacements.length; k++) {
      const rs = replacements[k];
      if (rs.stop_id === undefined || rs.stop_id === '') {
        f.error('E_REPLACEMENT_STOP_NO_ID', `Entity "${ent.id}" modification ${i} replacement_stops[${k}] has no stop_id.`,
          Object.assign({ replacement: k }, where));
      }
      if (rs.travel_time_to_stop === undefined) {
        f.warn('W_REPLACEMENT_STOP_NO_TRAVEL_TIME',
          `Entity "${ent.id}" modification ${i} replacement_stops[${k}] ("${rs.stop_id}") has no travel_time_to_stop, so a consumer cannot time the inserted stop.`,
          Object.assign({ replacement: k, stop: rs.stop_id }, where));
      } else {
        if (lastTravel !== null && rs.travel_time_to_stop < lastTravel) {
          f.error('E_TRAVEL_TIME_NOT_MONOTONIC',
            `Entity "${ent.id}" modification ${i}: travel_time_to_stop drops from ${lastTravel}s to ${rs.travel_time_to_stop}s at replacement_stops[${k}]. It must increase along the list.`,
            Object.assign({ replacement: k, previous: lastTravel, value: rs.travel_time_to_stop }, where));
        }
        lastTravel = rs.travel_time_to_stop;
      }
    }

    if (mod.end_stop_selector && mod.propagated_modification_delay === undefined) {
      f.warn('W_NO_PROPAGATED_DELAY',
        `Entity "${ent.id}" modification ${i} replaces stop times but sets no propagated_modification_delay, so every later arrival and departure stays at its scheduled time.`,
        where);
    }
  }

  // Ordering and overlap, using the raw stop_sequence values when they are all present.
  const usable = keys.every((k) => k.start !== undefined && k.end !== undefined);
  if (usable) {
    for (let i = 1; i < keys.length; i++) {
      if (keys[i].start < keys[i - 1].start) {
        f.error('E_MODIFICATIONS_OUT_OF_ORDER',
          `Entity "${ent.id}": modification ${i} starts at stop_sequence ${keys[i].start}, before modification ${i - 1} at ${keys[i - 1].start}. Modifications must be in increasing order.`,
          { entity: ent.id, modification: i });
      } else if (keys[i].start <= keys[i - 1].end) {
        f.error('E_MODIFICATIONS_OVERLAP',
          `Entity "${ent.id}": modification ${i} starts at stop_sequence ${keys[i].start}, inside modification ${i - 1} which runs to ${keys[i - 1].end}.`,
          { entity: ent.id, modification: i });
      }
    }
  }
}

function checkCrossRefs(model, f, s, gtfs) {
  const claimed = new Map();     // "trip|date" -> entity id
  const selectorStopIds = new Set();
  const unresolvedSelectorStopIds = new Set();
  const referencedShapes = new Set();
  const referencedStops = new Set();
  const seenUnknownTrips = new Set();
  const tripsWithoutStopTimes = new Set();
  if (!gtfs.canCheckServiceDates) f.skip('Service-date check', 'the static feed has no calendar.txt or calendar_dates.txt');

  for (const ent of model.entities) {
    const dates = ent.mods.service_dates || [];
    const routesSeen = new Set(), dirsSeen = new Set();

    for (const st of ent.mods.selected_trips || []) {
      if (st.shape_id !== undefined) {
        referencedShapes.add(st.shape_id);
        const inFeed = model.shapesById.has(st.shape_id);
        const inStatic = gtfs.hasShapePoints(st.shape_id);
        if (!inFeed && !inStatic) {
          f.error('E_SHAPE_UNRESOLVED',
            `Entity "${ent.id}" selects shape_id "${st.shape_id}", which is neither a Shape entity in this feed nor a shape in shapes.txt.`,
            { entity: ent.id, shape: st.shape_id });
        }
      }
      for (const tripId of st.trip_ids || []) {
        if (!gtfs.hasTrip(tripId)) {
          const key = ent.id + '|' + tripId;
          if (!seenUnknownTrips.has(key)) {
            seenUnknownTrips.add(key);
            f.error('E_TRIP_NOT_IN_STATIC', `Entity "${ent.id}" selects trip_id "${tripId}", which is not in trips.txt.`, { entity: ent.id, trip: tripId });
          }
          continue;
        }
        const r = gtfs.tripRouteId(tripId);
        if (r !== null) routesSeen.add(r);
        const d = gtfs.tripDirection(tripId);
        if (d !== null) dirsSeen.add(d);

        for (const date of dates) {
          if (!toDate(date)) continue;
          const key = tripId + '|' + date;
          const prior = claimed.get(key);
          if (prior !== undefined && prior !== ent.id) {
            f.error('E_DUPLICATE_TRIP_DATE',
              `Trip "${tripId}" on ${date} is claimed by both entity "${prior}" and entity "${ent.id}". A trip may only be modified once per date.`,
              { entity: ent.id, otherEntity: prior, trip: tripId, date });
          } else {
            claimed.set(key, ent.id);
          }
          if (gtfs.canCheckServiceDates && !gtfs.runsOn(tripId, date)) {
            f.error('E_TRIP_NOT_RUNNING', `Trip "${tripId}" does not run on ${date} according to calendar.txt and calendar_dates.txt, but entity "${ent.id}" modifies it that day.`,
              { entity: ent.id, trip: tripId, date });
          }
        }
      }
    }
    if (routesSeen.size > 1) {
      f.warn('W_MIXED_ROUTES', `Entity "${ent.id}" selects trips from ${routesSeen.size} routes (${[...routesSeen].slice(0, 5).join(', ')}). One entity normally covers one route.`,
        { entity: ent.id, routes: [...routesSeen] });
    }
    if (dirsSeen.size > 1) {
      f.warn('W_MIXED_DIRECTIONS', `Entity "${ent.id}" selects trips in both directions. A detour is normally direction-specific.`, { entity: ent.id });
    }

    // Selectors and replacement stops.
    for (let i = 0; i < (ent.mods.modifications || []).length; i++) {
      const mod = ent.mods.modifications[i];
      for (const [name, sel] of [['start_stop_selector', mod.start_stop_selector], ['end_stop_selector', mod.end_stop_selector]]) {
        if (!sel || sel.stop_id === undefined) continue;
        selectorStopIds.add(sel.stop_id);
        if (!gtfs.hasStop(sel.stop_id)) unresolvedSelectorStopIds.add(sel.stop_id);
      }
      for (const rs of mod.replacement_stops || []) {
        if (rs.stop_id === undefined || rs.stop_id === '') continue;
        referencedStops.add(rs.stop_id);
        if (!gtfs.hasStop(rs.stop_id) && !model.stopsById.has(rs.stop_id)) {
          f.error('E_REPLACEMENT_STOP_UNRESOLVED',
            `Entity "${ent.id}" modification ${i}: replacement stop "${rs.stop_id}" is neither in stops.txt nor a Stop entity in this feed.`,
            { entity: ent.id, modification: i, stop: rs.stop_id });
        }
      }
    }

    // Per-trip selector resolution.
    for (const plan of ent.plans) {
      if (plan.missing) continue;
      if (plan.noStopTimes) { tripsWithoutStopTimes.add(plan.tripId); continue; }
      const seqs = plan.stops.sequences;
      const range = seqs.length ? `${seqs[0]}–${seqs[seqs.length - 1]}` : 'empty';
      const alsoOn = plan.sharedWith.length ? ` (and ${plan.sharedWith.length} trip(s) with the same stop pattern)` : '';
      for (const r of plan.ranges) {
        for (const [name, res, sel] of [
          ['start_stop_selector', r.start, r.mod.start_stop_selector],
          ['end_stop_selector', r.end, r.mod.end_stop_selector],
        ]) {
          if (!sel) continue;
          if (res.reason === 'sequence-not-in-trip') {
            f.error('E_SELECTOR_SEQ_NOT_IN_TRIP',
              `Entity "${ent.id}" modification ${r.modIndex}: ${name}.stop_sequence ${sel.stop_sequence} is not in trip "${plan.tripId}"${alsoOn}, whose stop_sequence values run ${range} over ${seqs.length} stops.`,
              { entity: ent.id, modification: r.modIndex, trip: plan.tripId, selector: name, stopSequence: sel.stop_sequence, tripRange: range });
          } else if (res.reason === 'id-sequence-mismatch') {
            if (!gtfs.hasStop(sel.stop_id)) continue;
            f.error('E_SELECTOR_STOP_SEQ_MISMATCH',
              `Entity "${ent.id}" modification ${r.modIndex}: ${name} names stop "${sel.stop_id}" at stop_sequence ${sel.stop_sequence}, but trip "${plan.tripId}" has "${res.actualStopId}" at that sequence.`,
              { entity: ent.id, modification: r.modIndex, trip: plan.tripId, selector: name, stop: sel.stop_id, actualStop: res.actualStopId });
          } else if (res.reason === 'stop-not-in-trip' && gtfs.hasStop(sel.stop_id)) {
            f.error('E_SELECTOR_SEQ_NOT_IN_TRIP',
              `Entity "${ent.id}" modification ${r.modIndex}: ${name} names stop "${sel.stop_id}", which trip "${plan.tripId}"${alsoOn} does not serve.`,
              { entity: ent.id, modification: r.modIndex, trip: plan.tripId, selector: name, stop: sel.stop_id });
          }
        }
      }
    }
  }

  // Selector stop_ids that match nothing. Producers often put internal
  // scheduling codes here, which shows up as every single id failing.
  if (selectorStopIds.size > 0 && unresolvedSelectorStopIds.size === selectorStopIds.size) {
    const examples = [...unresolvedSelectorStopIds].slice(0, 5);
    f.error('E_SELECTOR_STOP_IDS_ALL_UNKNOWN',
      `None of the ${selectorStopIds.size} distinct StopSelector.stop_id values matches stops.txt. Examples: ${examples.map((x) => '"' + x + '"').join(', ')}. ` +
      'This normally means the producer is emitting internal scheduling codes rather than GTFS stop_ids.',
      { distinctIds: selectorStopIds.size, examples });
  } else {
    for (const id of unresolvedSelectorStopIds) {
      f.error('E_SELECTOR_STOP_NOT_IN_STATIC', `StopSelector.stop_id "${id}" is not in stops.txt.`, { stop: id });
    }
  }

  if (tripsWithoutStopTimes.size) {
    f.skip('Selector and geometry checks on ' + tripsWithoutStopTimes.size + ' trip(s)', 'those trips have no rows in stop_times.txt');
  }

  for (const rec of model.shapeEntities) {
    if (rec.shapeId !== undefined && !referencedShapes.has(rec.shapeId)) {
      f.warn('W_SHAPE_UNREFERENCED', `Shape "${rec.shapeId}" (entity "${rec.entityId}") is not referenced by any selected_trips.shape_id.`,
        { entity: rec.entityId, shape: rec.shapeId });
    }
  }
  for (const [stopId, rec] of model.stopsById) {
    if (!referencedStops.has(stopId)) {
      f.warn('W_STOP_UNREFERENCED', `Stop "${stopId}" (entity "${rec.entityId}") is not referenced by any replacement_stops.`, { entity: rec.entityId, stop: stopId });
    }
  }
}

function checkGeometry(model, f, s, gtfs) {
  for (const ent of model.entities) {
    for (const plan of ent.plans) {
      if (plan.missing || plan.noStopTimes) continue;
      const alsoOn = plan.sharedWith.length ? ` (and ${plan.sharedWith.length} trip(s) with the same stop pattern)` : '';

      // Does the modification reach a terminus?
      const last = plan.stops.stopIds.length - 1;
      for (const r of plan.ranges) {
        if (r.start.index === 0 || (r.end.index !== null && r.end.index === last) || r.start.index === last) {
          f.warn('W_MODIFICATION_COVERS_TERMINUS',
            `Entity "${ent.id}" modification ${r.modIndex} covers the ${r.start.index === 0 ? 'first' : 'last'} stop of trip "${plan.tripId}"${alsoOn}. Check whether the trip should instead start or end elsewhere.`,
            { entity: ent.id, modification: r.modIndex, trip: plan.tripId });
        }
      }

      const pts = plan.points;
      if (!pts || pts.length < 2) continue;

      const firstLL = gtfs.stopLatLon(plan.stops.stopIds[0]);
      const lastLL = gtfs.stopLatLon(plan.stops.stopIds[last]);
      if (firstLL) {
        const d = haversineish(firstLL, pts[0]);
        if (d > s.shapeEndpointM) {
          f.error('E_SHAPE_START_FAR',
            `Shape "${plan.shapeId}" starts ${Math.round(d)} m from the first stop of trip "${plan.tripId}"${alsoOn} ("${plan.stops.stopIds[0]}"). A new shape must cover the whole trip, not just the detour.`,
            { entity: ent.id, trip: plan.tripId, shape: plan.shapeId, meters: Math.round(d), stop: plan.stops.stopIds[0] });
        }
      }
      if (lastLL) {
        const d = haversineish(lastLL, pts[pts.length - 1]);
        if (d > s.shapeEndpointM) {
          f.error('E_SHAPE_END_FAR',
            `Shape "${plan.shapeId}" ends ${Math.round(d)} m from the last stop of trip "${plan.tripId}"${alsoOn} ("${plan.stops.stopIds[last]}"). A new shape must cover the whole trip, not just the detour.`,
            { entity: ent.id, trip: plan.tripId, shape: plan.shapeId, meters: Math.round(d), stop: plan.stops.stopIds[last] });
        }
      }

      for (const row of plan.rows) {
        const ll = gtfs.stopLatLon(row.stopId) || latLonOfFeedStop(model, row.stopId);
        if (!ll) continue;
        const d = distanceToPath(ll, pts).meters;
        row.distanceM = Math.round(d);
        if (row.kind === 'kept' && d > s.retainedStopM) {
          f.error('E_RETAINED_STOP_OFF_SHAPE',
            `Trip "${plan.tripId}"${alsoOn} still serves stop "${row.stopId}", but it is ${Math.round(d)} m from shape "${plan.shapeId}". The trip claims a stop the new path never reaches.`,
            { entity: ent.id, trip: plan.tripId, stop: row.stopId, shape: plan.shapeId, meters: Math.round(d) });
        } else if (row.kind === 'removed' && d < s.removedStopM) {
          f.info('I_REMOVED_STOP_NEAR_SHAPE',
            `Trip "${plan.tripId}"${alsoOn} removes stop "${row.stopId}", which is still only ${Math.round(d)} m from shape "${plan.shapeId}". That is what a stop closure looks like, and also what a detour applied to the wrong range looks like.`,
            { entity: ent.id, trip: plan.tripId, stop: row.stopId, shape: plan.shapeId, meters: Math.round(d) });
        }
      }
    }
  }
}

function latLonOfFeedStop(model, stopId) {
  const rec = model.stopsById.get(stopId);
  if (!rec || rec.raw.stop_lat === undefined || rec.raw.stop_lon === undefined) return null;
  return [rec.raw.stop_lat, rec.raw.stop_lon];
}

function checkAlerts(model, alertsFeed, f, s, gtfs) {
  checkHeader(alertsFeed, f, s, 'Alerts feed');
  const alerts = new Map();
  for (const e of alertsFeed.entity || []) if (e.alert) alerts.set(String(e.id), e.alert);

  for (const ent of model.entities) {
    for (let i = 0; i < (ent.mods.modifications || []).length; i++) {
      const id = ent.mods.modifications[i].service_alert_id;
      if (id === undefined || id === '') continue;
      if (alerts.has(String(id))) continue;
      const extra = String(id) === '0'
        ? ' "0" is the placeholder a producer leaves behind when the alert link was never filled in.'
        : ' service_alert_id must be the FeedEntity id of an Alert in the Alerts feed.';
      f.error('E_SERVICE_ALERT_ID_UNKNOWN',
        `Entity "${ent.id}" modification ${i} points at service_alert_id "${id}", which is not an Alert entity id in the Alerts feed.` + extra,
        { entity: ent.id, modification: i, alert: String(id) });
    }
  }

  const farFuture = Date.now() / 1000 + 2 * 365 * 24 * 3600;
  for (const [id, alert] of alerts) {
    for (const ie of alert.informed_entity || []) {
      if (gtfs && ie.stop_id && !gtfs.hasStop(ie.stop_id)) {
        f.warn('W_ALERT_INFORMED_STOP_UNKNOWN', `Alert "${id}" informs stop_id "${ie.stop_id}", which is not in stops.txt.`, { entity: id, stop: ie.stop_id });
      }
      if (gtfs && ie.route_id && !gtfs.hasRoute(ie.route_id)) {
        f.warn('W_ALERT_INFORMED_ROUTE_UNKNOWN', `Alert "${id}" informs route_id "${ie.route_id}", which is not in routes.txt.`, { entity: id, route: ie.route_id });
      }
    }
    const header = translated(alert.header_text);
    const body = translated(alert.description_text);
    const problems = [];
    if (!header) problems.push('no header_text');
    if (!body) problems.push('no description_text');
    for (const [name, text] of [['header_text', header], ['description_text', body]]) {
      if (!text) continue;
      if (/^[-–—\s.]+$/.test(text)) problems.push(`${name} is just "${text.trim()}"`);
      else if (/\btest(ing|s)?\b/i.test(text)) problems.push(`${name} contains the word "test"`);
    }
    if (!alert.cause || alert.cause === 'UNKNOWN_CAUSE') problems.push('no cause');
    if (problems.length) {
      f.warn('W_ALERT_TEXT_PLACEHOLDER', `Alert "${id}" looks unfinished: ${problems.join('; ')}.`, { entity: id, problems });
    }
    for (const p of alert.active_period || []) {
      if (p.end !== undefined && Number(p.end) > farFuture) {
        const year = new Date(Number(p.end) * 1000).getUTCFullYear();
        f.warn('W_ALERT_END_FAR_FUTURE', `Alert "${id}" has an active_period ending in ${year}. That is a sentinel value, not a real end time.`,
          { entity: id, end: Number(p.end), year });
      }
    }
  }
}

function checkTripUpdates(model, tuFeed, f, s, gtfs) {
  checkHeader(tuFeed, f, s, 'TripUpdates feed');
  const byEntityId = new Map();
  for (const ent of model.entities) byEntityId.set(ent.id, ent);
  const selectedTripToEntity = new Map();
  for (const ent of model.entities) for (const t of selectedTripIds(ent.mods)) selectedTripToEntity.set(t, ent.id);

  const idCounts = new Map();
  const plainTrips = new Set(), modifiedTrips = new Set();
  const unknownTuStops = new Map();

  for (const e of tuFeed.entity || []) {
    const eid = String(e.id === undefined ? '' : e.id);
    idCounts.set(eid, (idCounts.get(eid) || 0) + 1);
    const tu = e.trip_update;
    if (!tu) continue;
    const trip = tu.trip || {};
    const mt = trip.modified_trip;

    if (mt) {
      if (trip.trip_id !== undefined) {
        f.error('E_TRIP_ID_WITH_MODIFIED_TRIP',
          `TripUpdate "${eid}" sets both trip_id "${trip.trip_id}" and modified_trip. When modified_trip is present, trip_id, route_id, direction_id, start_time and start_date must all be left empty.`,
          { entity: eid, trip: trip.trip_id });
      }
      const modsId = mt.modifications_id;
      if (modsId !== undefined) {
        if (!byEntityId.has(String(modsId))) {
          if (selectedTripToEntity.has(String(modsId)) || (gtfs && gtfs.hasTrip(String(modsId)))) {
            f.error('E_MODIFICATIONS_ID_IS_TRIP_ID',
              `TripUpdate "${eid}" sets modifications_id "${modsId}", which is a trip_id, not a FeedEntity id. ` +
              'modifications_id must be the `id` of the FeedEntity wrapping the TripModifications message — the envelope id, not the id of anything inside it.',
              { entity: eid, modificationsId: String(modsId) });
          } else {
            f.error('E_MODIFICATIONS_ID_UNKNOWN',
              `TripUpdate "${eid}" sets modifications_id "${modsId}", which matches no TripModifications FeedEntity id in the TripModifications feed.`,
              { entity: eid, modificationsId: String(modsId) });
          }
        } else if (mt.affected_trip_id !== undefined) {
          const ent = byEntityId.get(String(modsId));
          if (!selectedTripIds(ent.mods).includes(mt.affected_trip_id)) {
            f.error('E_AFFECTED_TRIP_NOT_SELECTED',
              `TripUpdate "${eid}" names affected_trip_id "${mt.affected_trip_id}" under modifications_id "${modsId}", but that entity does not select that trip.`,
              { entity: eid, trip: mt.affected_trip_id, modificationsId: String(modsId) });
          }
        }
      }
      if (mt.affected_trip_id !== undefined) {
        modifiedTrips.add(mt.affected_trip_id);
        if (gtfs && !gtfs.hasTrip(mt.affected_trip_id)) {
          f.error('E_AFFECTED_TRIP_NOT_IN_STATIC', `TripUpdate "${eid}" names affected_trip_id "${mt.affected_trip_id}", which is not in trips.txt.`,
            { entity: eid, trip: mt.affected_trip_id });
        }
      }
    } else if (trip.trip_id !== undefined) {
      plainTrips.add(trip.trip_id);
    }

    if (gtfs) {
      for (const stu of tu.stop_time_update || []) {
        if (stu.stop_id !== undefined && !gtfs.hasStop(stu.stop_id)) {
          let rec = unknownTuStops.get(stu.stop_id);
          if (!rec) { rec = { count: 0, entities: new Set() }; unknownTuStops.set(stu.stop_id, rec); }
          rec.count++;
          rec.entities.add(eid);
        }
      }
    }
  }

  for (const [stopId, rec] of unknownTuStops) {
    f.warn('W_TU_STOP_UNKNOWN',
      `TripUpdates name stop_id "${stopId}" ${rec.count} time(s) across ${rec.entities.size} trip update(s); it is not in stops.txt.`,
      { stop: stopId, count: rec.count, entities: rec.entities.size });
  }
  for (const [id, n] of idCounts) {
    if (n > 1) f.error('E_DUPLICATE_ENTITY_ID', `TripUpdates feed: entity id "${id}" is used by ${n} entities.`, { entity: id, count: n, feed: 'TripUpdates' });
  }
  for (const t of modifiedTrips) {
    if (plainTrips.has(t)) {
      f.warn('W_TU_TRIP_PLAIN_AND_MODIFIED', `Trip "${t}" appears in the TripUpdates feed both as a plain trip_id and as a modified_trip.affected_trip_id. Consumers will see it twice.`, { trip: t });
    }
  }
}

// --- helpers --------------------------------------------------------------

function translated(ts) {
  if (!ts || !ts.translation || !ts.translation.length) return '';
  const en = ts.translation.find((t) => (t.language || '').toLowerCase().startsWith('en'));
  return ((en || ts.translation[0]).text || '').trim();
}

function shiftYmd(ymd, days) {
  const d = toDate(ymd);
  if (!d) return ymd;
  d.setUTCDate(d.getUTCDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

function summarize(model, modsFeed, alertsFeed, tuFeed, f) {
  const counts = {};
  for (const e of modsFeed.entity || []) {
    for (const k of ['trip_modifications', 'shape', 'stop', 'alert', 'trip_update', 'vehicle']) {
      if (e[k]) counts[k] = (counts[k] || 0) + 1;
    }
  }
  const trips = new Set(), dates = new Set();
  let modCount = 0;
  for (const ent of model.entities) {
    for (const t of selectedTripIds(ent.mods)) trips.add(t);
    for (const d of ent.mods.service_dates || []) dates.add(d);
    modCount += (ent.mods.modifications || []).length;
  }
  return {
    entityCounts: counts,
    totalEntities: (modsFeed.entity || []).length,
    modifications: modCount,
    distinctTrips: trips.size,
    serviceDates: [...dates].sort(),
    alertEntities: alertsFeed ? (alertsFeed.entity || []).length : null,
    tripUpdateEntities: tuFeed ? (tuFeed.entity || []).length : null,
    errors: f.count(ERROR),
    warnings: f.count(WARNING),
    infos: f.items.length - f.count(ERROR) - f.count(WARNING),
    headerTimestamp: modsFeed.header && modsFeed.header.timestamp !== undefined ? Number(modsFeed.header.timestamp) : null,
  };
}

export { selectedTripIds };
