// Main-thread view over what the worker produced: rebuilds the lookup maps and
// answers the questions the checks ask.

export class Gtfs {
  constructor(data) {
    Object.assign(this, data);
    this.stopIdx = new Map();
    this.stops.ids.forEach((id, i) => this.stopIdx.set(id, i));
    this.tripIdx = new Map();
    this.trips.ids.forEach((id, i) => this.tripIdx.set(id, i));
    this.routeIdx = new Map();
    this.routes.ids.forEach((id, i) => this.routeIdx.set(id, i));
    this.shapeIdx = new Map();
    this.shapes.ids.forEach((id, i) => this.shapeIdx.set(id, i));
  }

  hasStop(id) { return this.stopIdx.has(id); }
  hasTrip(id) { return this.tripIdx.has(id); }
  hasRoute(id) { return this.routeIdx.has(id); }

  // A shape_id only counts as being in shapes.txt when it has points; trips.txt
  // can name a shape the shapes file never defines.
  hasShapePoints(id) {
    const i = this.shapeIdx.get(id);
    if (i === undefined) return false;
    return this.shapes.offset[i + 1] > this.shapes.offset[i];
  }

  stopName(id) {
    const i = this.stopIdx.get(id);
    return i === undefined ? null : this.stops.names[i];
  }

  // location_type from stops.txt; a replacement stop must be 0 (routable).
  stopLocationType(id) {
    const i = this.stopIdx.get(id);
    return i === undefined ? null : this.stops.locationType[i];
  }

  stopLatLon(id) {
    const i = this.stopIdx.get(id);
    if (i === undefined) return null;
    const la = this.stops.lat[i], lo = this.stops.lon[i];
    return Number.isFinite(la) && Number.isFinite(lo) ? [la, lo] : null;
  }

  // The trip's stops in order: { stopIds, sequences }.
  tripStops(tripId) {
    const t = this.tripIdx.get(tripId);
    if (t === undefined) return null;
    const s = this.trips.stOffset[t], e = this.trips.stOffset[t + 1];
    const stopIds = new Array(e - s), sequences = new Array(e - s);
    for (let i = s; i < e; i++) {
      stopIds[i - s] = this.stops.ids[this.trips.stStopIdx[i]];
      sequences[i - s] = this.trips.stSeq[i];
    }
    return { stopIds, sequences };
  }

  tripRouteId(tripId) {
    const t = this.tripIdx.get(tripId);
    if (t === undefined) return null;
    const r = this.trips.routeIdx[t];
    return r < 0 ? null : this.routes.ids[r];
  }

  tripDirection(tripId) {
    const t = this.tripIdx.get(tripId);
    if (t === undefined) return null;
    const d = this.trips.directionId[t];
    return d < 0 ? null : d;
  }

  tripShapeId(tripId) {
    const t = this.tripIdx.get(tripId);
    if (t === undefined) return null;
    const s = this.trips.shapeIdx[t];
    return s < 0 ? null : this.shapes.ids[s];
  }

  // Flat [lat, lon] pairs for a shapes.txt shape, or null.
  shapePoints(shapeId) {
    const i = this.shapeIdx.get(shapeId);
    if (i === undefined) return null;
    const s = this.shapes.offset[i], e = this.shapes.offset[i + 1];
    if (e <= s) return null;
    const pts = new Array(e - s);
    for (let k = s; k < e; k++) pts[k - s] = [this.shapes.lat[k], this.shapes.lon[k]];
    return pts;
  }

  get canCheckServiceDates() {
    return this.services.hasCalendar || this.services.hasCalendarDates;
  }

  // Does the trip run on YYYYMMDD? calendar_dates exceptions win over calendar.
  runsOn(tripId, dateStr) {
    const t = this.tripIdx.get(tripId);
    if (t === undefined) return false;
    const svc = this.trips.serviceIdx[t];
    if (svc < 0) return false;
    const date = parseInt(dateStr, 10);
    if (!Number.isFinite(date)) return false;

    const ex = this.services.exceptions.get(svc);
    if (ex) {
      const type = ex.get(date);
      if (type === 1) return true;
      if (type === 2) return false;
    }
    if (!this.services.hasCalendar) return false;
    const start = this.services.start[svc], end = this.services.end[svc];
    if (start && date < start) return false;
    if (end && date > end) return false;
    const dow = dayOfWeek(dateStr);
    if (dow < 0) return false;
    return (this.services.mask[svc] & (1 << dow)) !== 0;
  }
}

// 0 = Monday, matching the calendar.txt column order.
export function dayOfWeek(dateStr) {
  const d = toDate(dateStr);
  if (!d) return -1;
  return (d.getUTCDay() + 6) % 7;
}

export function toDate(dateStr) {
  if (!/^\d{8}$/.test(dateStr)) return null;
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(4, 6), day = +dateStr.slice(6, 8);
  if (m < 1 || m > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(y, m - 1, day));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== day) return null;
  return d;
}

export function todayYmd() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
