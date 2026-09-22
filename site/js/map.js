// Leaflet is loaded from a CDN and only when the map tab is first opened, so a
// blocked CDN costs the map and nothing else.

let loading = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error('Leaflet could not be loaded from the CDN, so the map is unavailable. Everything else still works.'));
    document.head.appendChild(js);
  });
  return loading;
}

export class PlanMap {
  constructor(container) {
    this.container = container;
    this.map = null;
    this.layer = null;
  }

  async show(plan, gtfs, model, focusStopId) {
    const L = await loadLeaflet();
    if (!this.map) {
      this.map = L.map(this.container, { zoomControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(this.map);
    }
    if (this.layer) this.layer.remove();
    this.layer = L.layerGroup().addTo(this.map);

    const bounds = [];

    // The scheduled path, for comparison.
    const originalShapeId = gtfs ? gtfs.tripShapeId(plan.tripId) : null;
    if (originalShapeId && gtfs.hasShapePoints(originalShapeId)) {
      const pts = gtfs.shapePoints(originalShapeId);
      L.polyline(pts, { color: '#9aa4b2', weight: 5, opacity: 0.8 }).addTo(this.layer);
      for (const p of pts) bounds.push(p);
    }
    if (plan.points && plan.points.length > 1) {
      L.polyline(plan.points, { color: '#1f6feb', weight: 4, opacity: 0.95 }).addTo(this.layer);
      for (const p of plan.points) bounds.push(p);
    }

    const styles = {
      kept: { radius: 5, color: '#1f6feb', weight: 2, fillColor: '#1f6feb', fillOpacity: 1 },
      removed: { radius: 5, color: '#b42318', weight: 2, fillColor: '#ffffff', fillOpacity: 1 },
      inserted: { radius: 7, color: '#8250df', weight: 3, fillColor: '#d8b9ff', fillOpacity: 1 },
    };
    for (const row of plan.rows) {
      const ll = (gtfs && gtfs.stopLatLon(row.stopId)) || feedStopLatLon(model, row.stopId);
      if (!ll) continue;
      const name = (gtfs && gtfs.stopName(row.stopId)) || feedStopName(model, row.stopId) || '';
      const dist = row.distanceM === undefined ? '' : `<br>${row.distanceM} m from the new shape`;
      L.circleMarker(ll, styles[row.kind])
        .bindPopup(`<b>${escapeHtml(row.stopId)}</b> — ${row.kind}<br>${escapeHtml(name)}${dist}`)
        .addTo(this.layer);
      bounds.push(ll);
    }

    if (bounds.length) this.map.fitBounds(bounds, { padding: [24, 24] });
    else this.map.setView([0, 0], 2);

    // Arriving from a finding: go straight to the stop it is about.
    if (focusStopId) {
      const ll = (gtfs && gtfs.stopLatLon(focusStopId)) || feedStopLatLon(model, focusStopId);
      if (ll) {
        this.map.setView(ll, 17);
        L.circleMarker(ll, { radius: 14, color: '#d29922', weight: 3, fill: false }).addTo(this.layer);
      }
    }
    setTimeout(() => this.map.invalidateSize(), 0);
  }

  resize() { if (this.map) this.map.invalidateSize(); }
}

function feedStopLatLon(model, stopId) {
  const rec = model && model.stopsById.get(stopId);
  if (!rec || rec.raw.stop_lat === undefined || rec.raw.stop_lon === undefined) return null;
  return [rec.raw.stop_lat, rec.raw.stop_lon];
}

function feedStopName(model, stopId) {
  const rec = model && model.stopsById.get(stopId);
  if (!rec || !rec.raw.stop_name || !rec.raw.stop_name.translation) return null;
  return (rec.raw.stop_name.translation[0] || {}).text || null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
