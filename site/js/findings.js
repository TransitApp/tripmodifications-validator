// Findings are collected flat and grouped by code for display.

export const ERROR = 'error';
export const WARNING = 'warning';
export const INFO = 'info';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export class Findings {
  constructor() {
    this.items = [];
    this.skipped = [];
  }

  add(severity, code, message, context) {
    this.items.push({ severity, code, message, context: context || {} });
  }

  error(code, message, context) { this.add(ERROR, code, message, context); }
  warn(code, message, context) { this.add(WARNING, code, message, context); }
  info(code, message, context) { this.add(INFO, code, message, context); }

  // Records a check that could not run, so the report says so instead of
  // quietly passing.
  skip(what, why) { this.skipped.push({ what, why }); }

  count(severity) { return this.items.filter((f) => f.severity === severity).length; }

  // One group per code, each holding every occurrence.
  grouped() {
    const map = new Map();
    for (const f of this.items) {
      let g = map.get(f.code);
      if (!g) { g = { code: f.code, severity: f.severity, message: f.message, items: [] }; map.set(f.code, g); }
      // A group takes the harshest severity any of its members carries.
      if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[g.severity]) g.severity = f.severity;
      g.items.push(f);
    }
    return [...map.values()].sort((a, b) => {
      const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      return s !== 0 ? s : b.items.length - a.items.length;
    });
  }
}

// Human-readable titles, used in the findings table and the exports.
export const CODE_TITLES = {
  E_FEED_HEADER_VERSION: 'Feed header is missing gtfs_realtime_version',
  W_FEED_HEADER_INCREMENTALITY: 'Feed header incrementality is unusual',
  E_FEED_HEADER_TIMESTAMP: 'Feed header is missing a timestamp',
  W_FEED_HEADER_TIMESTAMP_SKEW: 'Feed header timestamp is far from the current time',
  E_DUPLICATE_ENTITY_ID: 'Two entities share an id',
  E_NO_SELECTED_TRIPS: 'TripModifications has no selected_trips',
  E_NO_SERVICE_DATES: 'TripModifications has no service_dates',
  E_NO_MODIFICATIONS: 'TripModifications has no modifications',
  E_SELECTED_TRIPS_EMPTY: 'SelectedTrips names no trip_ids',
  E_SERVICE_DATE_FORMAT: 'service_date is not a valid YYYYMMDD date',
  W_SERVICE_DATE_PAST: 'service_date is in the past',
  E_START_TIMES_MULTI_SELECTION: 'start_times used with more than one trip',
  E_STOP_SELECTOR_EMPTY: 'StopSelector sets neither stop_sequence nor stop_id',
  E_MODIFICATION_NOOP: 'Modification changes nothing at all',
  E_SELECTOR_ORDER: 'end_stop_selector comes before start_stop_selector',
  E_MODIFICATIONS_OUT_OF_ORDER: 'Modifications are not in increasing stop_sequence order',
  E_MODIFICATIONS_OVERLAP: 'Two modifications cover the same stops',
  E_REPLACEMENT_STOP_NO_ID: 'ReplacementStop has no stop_id',
  W_REPLACEMENT_STOP_NO_TRAVEL_TIME: 'ReplacementStop has no travel_time_to_stop',
  E_TRAVEL_TIME_NOT_MONOTONIC: 'travel_time_to_stop does not increase along the replacement stops',
  W_NO_PROPAGATED_DELAY: 'Modification sets no propagated_modification_delay',
  E_SHAPE_ID_COLLIDES: 'Shape entity reuses a shape_id from shapes.txt',
  E_SHAPE_NO_ID: 'Shape entity has no shape_id',
  E_SHAPE_POLYLINE_INVALID: 'Shape polyline is missing, undecodable, or has fewer than two points',
  W_SHAPE_DUPLICATE_POINTS: 'Shape polyline repeats a point',
  E_STOP_ID_COLLIDES: 'Stop entity reuses a stop_id from stops.txt',
  E_STOP_MISSING_FIELDS: 'Stop entity is missing stop_id, stop_name, stop_lat, or stop_lon',
  E_TRIP_NOT_IN_STATIC: 'Selected trip_id is not in trips.txt',
  E_TRIP_NOT_RUNNING: 'Selected trip does not run on a service_date',
  E_DUPLICATE_TRIP_DATE: 'Two entities claim the same trip on the same date',
  E_SELECTOR_STOP_NOT_IN_STATIC: 'StopSelector.stop_id is not in stops.txt',
  E_SELECTOR_STOP_IDS_ALL_UNKNOWN: 'No StopSelector.stop_id matches stops.txt at all',
  E_SELECTOR_STOP_SEQ_MISMATCH: 'StopSelector stop_id and stop_sequence disagree',
  E_SELECTOR_SEQ_NOT_IN_TRIP: 'StopSelector.stop_sequence is not in the selected trip',
  E_REPLACEMENT_STOP_UNRESOLVED: 'ReplacementStop.stop_id matches no stop in stops.txt or the feed',
  E_SHAPE_UNRESOLVED: 'selected_trips.shape_id matches no Shape entity or shapes.txt shape',
  W_SHAPE_UNREFERENCED: 'Shape entity is never referenced',
  W_STOP_UNREFERENCED: 'Stop entity is never referenced',
  W_MIXED_ROUTES: 'One entity selects trips from several routes',
  W_MIXED_DIRECTIONS: 'One entity selects trips in both directions',
  W_MODIFICATION_COVERS_TERMINUS: "Modification covers the trip's first or last stop",
  E_SHAPE_START_FAR: "New shape does not start near the trip's first stop",
  E_SHAPE_END_FAR: "New shape does not end near the trip's last stop",
  E_RETAINED_STOP_OFF_SHAPE: 'A retained stop is far from the new shape',
  I_REMOVED_STOP_NEAR_SHAPE: 'A removed stop is still on the new shape',
  E_SERVICE_ALERT_ID_UNKNOWN: 'service_alert_id matches no Alert entity',
  W_ALERT_INFORMED_STOP_UNKNOWN: 'Alert informed_entity.stop_id is not in stops.txt',
  W_ALERT_INFORMED_ROUTE_UNKNOWN: 'Alert informed_entity.route_id is not in routes.txt',
  W_ALERT_TEXT_PLACEHOLDER: 'Alert text looks unfinished',
  W_ALERT_END_FAR_FUTURE: 'Alert active_period.end is very far in the future',
  E_MODIFICATIONS_ID_IS_TRIP_ID: 'modifications_id holds a trip_id instead of a FeedEntity id',
  E_MODIFICATIONS_ID_UNKNOWN: 'modifications_id matches no TripModifications entity',
  E_AFFECTED_TRIP_NOT_IN_STATIC: 'affected_trip_id is not in trips.txt',
  E_AFFECTED_TRIP_NOT_SELECTED: 'affected_trip_id is not selected by the named entity',
  E_TRIP_ID_WITH_MODIFIED_TRIP: 'trip_id is set alongside modified_trip',
  W_TU_TRIP_PLAIN_AND_MODIFIED: 'The same trip appears both plain and modified',
  W_TU_STOP_UNKNOWN: 'stop_time_update.stop_id is not in stops.txt',
};
