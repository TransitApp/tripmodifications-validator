// A small tile-free picture of one finding: the new shape, the scheduled shape,
// the nearby stops, and whatever the finding is complaining about. Drawn as
// inline SVG so a findings list can hold hundreds of them without asking the
// network for anything.

import { metersPerDegLon, distanceToPath } from './geo.js';

const W = 190, H = 118;
const M_PER_DEG_LAT = 111320;

// Findings that have something worth drawing. Everything else stays text.
export const MAPPABLE_CODES = new Set([
  'E_RETAINED_STOP_OFF_SHAPE',
  'I_REMOVED_STOP_NEAR_SHAPE',
  'E_SHAPE_START_FAR',
  'E_SHAPE_END_FAR',
  'W_SHAPE_DUPLICATE_POINTS',
  'W_MODIFICATION_COVERS_TERMINUS',
  'E_SELECTOR_STOP_SEQ_MISMATCH',
  'E_SELECTOR_SEQ_NOT_IN_TRIP',
  'E_SHAPE_UNRESOLVED',
  'E_TRIP_RUNS_ON_NO_SERVICE_DATE',
  'E_SELECTOR_AMBIGUOUS_STOP',
  'E_MODIFICATIONS_CONTIGUOUS',
  'E_DUPLICATE_TRIP_DATE',
]);

function stopLatLon(stopId, gtfs, model) {
  if (stopId === undefined || stopId === null) return null;
  const fromStatic = gtfs && gtfs.stopLatLon(stopId);
  if (fromStatic) return fromStatic;
  const rec = model && model.stopsById.get(stopId);
  if (rec && rec.raw.stop_lat !== undefined && rec.raw.stop_lon !== undefined) return [rec.raw.stop_lat, rec.raw.stop_lon];
  return null;
}

function pickPlan(ent, tripId) {
  if (!ent.plans || !ent.plans.length) return null;
  if (tripId !== undefined) {
    const exact = ent.plans.find((p) => p.tripId === tripId);
    if (exact) return exact;
    const shared = ent.plans.find((p) => p.sharedWith && p.sharedWith.includes(tripId));
    if (shared) return shared;
  }
  return ent.plans[0];
}

// What to draw for a finding, or null when it has no geography. Kept separate
// from the drawing so the caller can run it lazily, one row at a time.
export function findingGeo(finding, model, gtfs) {
  const c = finding.context || {};

  // A Shape entity on its own: centre on the offending vertex.
  const ent = c.entity !== undefined ? model.entities.find((e) => e.id === String(c.entity)) : null;
  if (!ent && c.shape !== undefined) {
    const rec = model.shapesById.get(c.shape);
    if (!rec || !rec.points || rec.points.length < 2) return null;
    const i = Math.min(c.firstIndex || 0, rec.points.length - 1);
    return { points: rec.points, original: null, focus: rec.points[i], focusKind: 'point', radiusM: 150, plan: null };
  }
  if (!ent) return null;

  const plan = pickPlan(ent, c.trip);
  if (!plan || plan.missing || plan.noStopTimes) return null;

  let focus = null, focusKind = 'stop', radiusM = 250;
  if (c.stop !== undefined) {
    focus = stopLatLon(c.stop, gtfs, model);
    // Zoom to the size of the problem, but keep enough around it to recognise
    // where you are.
    if (focus && c.meters !== undefined) radiusM = Math.min(Math.max(c.meters * 4, 180), 1200);
  }
  if (!focus && c.modification !== undefined) {
    const r = plan.ranges.find((x) => x.modIndex === c.modification);
    const at = r && r.start.index >= 0 ? plan.stops.stopIds[r.start.index] : null;
    if (at) { focus = stopLatLon(at, gtfs, model); radiusM = 500; }
  }
  if (!focus && plan.points && plan.points.length) {
    focus = plan.points[Math.floor(plan.points.length / 2)];
    focusKind = 'point';
    radiusM = 1200;
  }
  if (!focus && plan.stops.stopIds.length) {
    focus = stopLatLon(plan.stops.stopIds[0], gtfs, model);
    radiusM = 1200;
  }
  if (!focus) return null;

  const originalShapeId = gtfs ? gtfs.tripShapeId(plan.tripId) : null;
  const original = originalShapeId && gtfs.hasShapePoints(originalShapeId) ? gtfs.shapePoints(originalShapeId) : null;
  return { points: plan.points, original, focus, focusKind, radiusM, plan, stopId: c.stop };
}

// Points far outside the frame collapse to one, so a 5,000-point shape still
// produces a short path.
function pathOf(pts, project) {
  if (!pts || pts.length < 2) return '';
  const limX = W * 4, limY = H * 4;
  const d = [];
  let lastFar = false;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = project(pts[i]);
    const far = x < -limX || x > limX || y < -limY || y > limY;
    if (far && lastFar && i !== pts.length - 1) continue;
    d.push((d.length ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1));
    lastFar = far;
  }
  return d.length > 1 ? d.join('') : '';
}

function niceRound(target) {
  const steps = [10, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i] <= target) return steps[i];
  return steps[0];
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function miniMapSvg(geo, gtfs, model) {
  const { focus, radiusM } = geo;
  const mpp = radiusM / (W / 2);                 // metres per pixel
  const kx = metersPerDegLon(focus[0]);
  const project = (ll) => [
    W / 2 + ((ll[1] - focus[1]) * kx) / mpp,
    H / 2 - ((ll[0] - focus[0]) * M_PER_DEG_LAT) / mpp,
  ];

  const svg = [`<svg class="minimap" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`];
  svg.push(`<rect class="mm-bg" width="${W}" height="${H}"/>`);

  const orig = pathOf(geo.original, project);
  if (orig) svg.push(`<path class="mm-orig" d="${orig}"/>`);
  const neu = pathOf(geo.points, project);
  if (neu) svg.push(`<path class="mm-new" d="${neu}"/>`);

  // Every stop of this trip that lands in frame, so the corridor is readable.
  if (geo.plan) {
    for (const row of geo.plan.rows) {
      if (row.stopId === geo.stopId) continue;
      const ll = stopLatLon(row.stopId, gtfs, model);
      if (!ll) continue;
      const [x, y] = project(ll);
      if (x < -6 || x > W + 6 || y < -6 || y > H + 6) continue;
      svg.push(`<circle class="mm-stop mm-${row.kind}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6"/>`);
    }
  }

  // The thing the finding is about, and how far it sits off the new shape.
  const [fx, fy] = project(focus);
  let label = '';
  if (geo.focusKind === 'stop' && geo.points && geo.points.length > 1) {
    const near = distanceToPath(focus, geo.points);
    if (near.point) {
      const [nx, ny] = project(near.point);
      svg.push(`<line class="mm-gap" x1="${fx.toFixed(1)}" y1="${fy.toFixed(1)}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/>`);
      label = Math.round(near.meters) + ' m';
    }
  }
  const kind = geo.plan && geo.stopId !== undefined
    ? (geo.plan.rows.find((r) => r.stopId === geo.stopId) || {}).kind
    : null;
  svg.push(`<circle class="mm-focus mm-focus-${kind || geo.focusKind}" cx="${fx.toFixed(1)}" cy="${fy.toFixed(1)}" r="5"/>`);
  if (label) svg.push(`<text class="mm-label" x="${fx.toFixed(1)}" y="${(fy - 9).toFixed(1)}" text-anchor="middle">${esc(label)}</text>`);

  // Scale bar.
  const barM = niceRound(radiusM * 0.7);
  const barPx = barM / mpp;
  svg.push(`<line class="mm-scale" x1="8" y1="${H - 9}" x2="${(8 + barPx).toFixed(1)}" y2="${H - 9}"/>`);
  svg.push(`<text class="mm-scale-label" x="8" y="${H - 13}">${barM < 1000 ? barM + ' m' : (barM / 1000) + ' km'}</text>`);

  svg.push('</svg>');
  return svg.join('');
}
