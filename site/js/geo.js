// Encoded polylines and planar distances. Everything here is local-scale, so a
// flat projection with a cos(lat) correction on longitude is accurate enough.

const M_PER_DEG_LAT = 111320;

export function metersPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

// Google's encoded polyline algorithm, precision 5.
// Throws on malformed input so the caller can report it as a bad shape.
export function decodePolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lon = 0;
  const n = str.length;
  while (i < n) {
    let result = 0, shift = 0, b;
    do {
      if (i >= n) throw new Error('polyline ends mid-value');
      b = str.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) throw new Error('character outside the polyline alphabet at ' + (i - 1));
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (shift > 35) throw new Error('polyline value is too long');
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0; shift = 0;
    do {
      if (i >= n) throw new Error('polyline ends mid-value');
      b = str.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) throw new Error('character outside the polyline alphabet at ' + (i - 1));
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (shift > 35) throw new Error('polyline value is too long');
    } while (b >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);

    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

export function haversineish(a, b) {
  const kx = metersPerDegLon((a[0] + b[0]) / 2);
  const dx = (a[1] - b[1]) * kx;
  const dy = (a[0] - b[0]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

// Shortest distance in metres from a point to a polyline, and where along it.
export function distanceToPath(point, pts) {
  if (!pts || pts.length === 0) return { meters: Infinity, index: -1 };
  const kx = metersPerDegLon(point[0]);
  const px = point[1] * kx, py = point[0] * M_PER_DEG_LAT;
  let best = Infinity, bestIdx = 0;
  if (pts.length === 1) {
    const d = Math.hypot(pts[0][1] * kx - px, pts[0][0] * M_PER_DEG_LAT - py);
    return { meters: d, index: 0 };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][1] * kx, ay = pts[i][0] * M_PER_DEG_LAT;
    const bx = pts[i + 1][1] * kx, by = pts[i + 1][0] * M_PER_DEG_LAT;
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const d = Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
    if (d < best) { best = d; bestIdx = i; }
  }
  return { meters: best, index: bestIdx };
}

// Indices of points equal to the one before them.
export function duplicateConsecutive(pts) {
  const dupes = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] === pts[i - 1][0] && pts[i][1] === pts[i - 1][1]) dupes.push(i);
  }
  return dupes;
}
