// node test/spec-rules.test.mjs
//
// One case per rule that reference.md or trip-modifications.md states, kept
// because several of these checks were wrong the first time: the spec allows
// more than it looks like it does, and a check that over-reads it turns
// correct feeds into walls of red.

import { validate } from '../site/js/validate.js';
import { Gtfs } from '../site/js/gtfs.js';
import { todayYmd } from '../site/js/gtfs.js';

let failures = 0;

// Trip t1 visits A, B, A, C: stop A twice (so stop_id alone is ambiguous) and
// C has location_type 1 (so it is not a routable replacement stop).
const gtfs = new Gtfs({
  files: [], warnings: [],
  stops: {
    ids: ['A', 'B', 'C'], names: ['A', 'B', 'C'],
    lat: new Float64Array([45.50, 45.51, 45.52]),
    lon: new Float64Array([-73.55, -73.56, -73.57]),
    locationType: new Uint8Array([0, 0, 1]),
  },
  routes: { ids: ['R'], names: ['R'] },
  trips: {
    ids: ['t1'], routeIdx: new Int32Array([0]), serviceIdx: new Int32Array([0]),
    shapeIdx: new Int32Array([-1]), directionId: new Int8Array([0]),
    stOffset: new Uint32Array([0, 4]),
    stStopIdx: new Uint32Array([0, 1, 0, 2]),
    stSeq: new Uint32Array([1, 2, 3, 4]),
  },
  services: {
    ids: ['s1'], mask: new Uint8Array([0x7f]),
    start: new Int32Array([20200101]), end: new Int32Array([20991231]),
    exceptions: new Map(), hasCalendar: true, hasCalendarDates: false,
  },
  shapes: { ids: [], offset: new Uint32Array([0]), lat: new Float32Array(0), lon: new Float32Array(0) },
});

const HEADER = { gtfs_realtime_version: '2.0', timestamp: Math.floor(Date.now() / 1000) };
const TODAY = todayYmd();

function mods(overrides) {
  return {
    selected_trips: [{ trip_ids: ['t1'], shape_id: 'newshape' }],
    service_dates: [TODAY],
    modifications: [{ start_stop_selector: { stop_sequence: 2 }, end_stop_selector: { stop_sequence: 2 } }],
    ...overrides,
  };
}

function run(name, { feed, alerts, tu, expect, reject }) {
  const out = validate({ modsFeed: feed, gtfs, alertsFeed: alerts || null, tuFeed: tu || null, settings: {} });
  const codes = new Set(out.findings.items.map((f) => f.code));
  const problems = [];
  for (const c of expect || []) if (!codes.has(c)) problems.push('missing ' + c);
  for (const c of reject || []) if (codes.has(c)) problems.push('unexpected ' + c);
  if (problems.length) {
    failures++;
    console.log('FAIL  ' + name + '\n        ' + problems.join('\n        ') +
                '\n        got: ' + [...codes].join(', '));
  } else {
    console.log('ok    ' + name);
  }
}

const feedOf = (m, extra) => ({ header: HEADER, entity: [{ id: 'E1', trip_modifications: m }, ...(extra || [])] });

console.log('TripModifications / Modification');
run('shape-only modification is legal when a shape_id is supplied',
  { feed: feedOf(mods({ modifications: [{ start_stop_selector: { stop_sequence: 2 } }] })), reject: ['E_MODIFICATION_NOOP'] });
run('a modification with nothing at all is reported',
  { feed: feedOf({ ...mods(), selected_trips: [{ trip_ids: ['t1'] }], modifications: [{ start_stop_selector: { stop_sequence: 2 } }] }),
    expect: ['E_MODIFICATION_NOOP'] });
run('a pure delay injection is not a no-op',
  { feed: feedOf({ ...mods(), selected_trips: [{ trip_ids: ['t1'] }], modifications: [{ start_stop_selector: { stop_sequence: 2 }, propagated_modification_delay: 90 }] }),
    reject: ['E_MODIFICATION_NOOP'] });
run('SelectedTrips must set shape_id',
  { feed: feedOf({ ...mods(), selected_trips: [{ trip_ids: ['t1'] }] }), expect: ['E_SELECTED_TRIPS_NO_SHAPE'] });
run('contiguous spans must be merged',
  { feed: feedOf(mods({ modifications: [
      { start_stop_selector: { stop_sequence: 1 }, end_stop_selector: { stop_sequence: 1 }, replacement_stops: [{ stop_id: 'B' }] },
      { start_stop_selector: { stop_sequence: 2 }, end_stop_selector: { stop_sequence: 2 }, replacement_stops: [{ stop_id: 'B' }] }] })),
    expect: ['E_MODIFICATIONS_CONTIGUOUS'] });
run('a gap between spans is fine',
  { feed: feedOf(mods({ modifications: [
      { start_stop_selector: { stop_sequence: 1 }, end_stop_selector: { stop_sequence: 1 }, replacement_stops: [{ stop_id: 'B' }] },
      { start_stop_selector: { stop_sequence: 3 }, end_stop_selector: { stop_sequence: 3 }, replacement_stops: [{ stop_id: 'B' }] }] })),
    reject: ['E_MODIFICATIONS_CONTIGUOUS', 'E_MODIFICATIONS_OVERLAP'] });

console.log('\nStopSelector');
run('stop_id alone is ambiguous when the trip visits the stop twice',
  { feed: feedOf(mods({ modifications: [{ start_stop_selector: { stop_id: 'A' }, end_stop_selector: { stop_sequence: 4 } }] })),
    expect: ['E_SELECTOR_AMBIGUOUS_STOP'] });
run('stop_sequence disambiguates it',
  { feed: feedOf(mods({ modifications: [{ start_stop_selector: { stop_sequence: 3 }, end_stop_selector: { stop_sequence: 4 } }] })),
    reject: ['E_SELECTOR_AMBIGUOUS_STOP'] });
run('a selector with neither field is reported',
  { feed: feedOf(mods({ modifications: [{ start_stop_selector: {}, end_stop_selector: { stop_sequence: 2 } }] })),
    expect: ['E_STOP_SELECTOR_EMPTY'] });

console.log('\nReplacementStop');
run('a replacement stop must have location_type 0',
  { feed: feedOf(mods({ modifications: [{ start_stop_selector: { stop_sequence: 2 }, end_stop_selector: { stop_sequence: 2 }, replacement_stops: [{ stop_id: 'C', travel_time_to_stop: 60 }] }] })),
    expect: ['E_REPLACEMENT_STOP_NOT_ROUTABLE'] });
run('negative travel_time_to_stop needs the first stop as reference',
  { feed: feedOf(mods({ modifications: [{ start_stop_selector: { stop_sequence: 2 }, end_stop_selector: { stop_sequence: 2 }, replacement_stops: [{ stop_id: 'B', travel_time_to_stop: -30 }] }] })),
    expect: ['E_TRAVEL_TIME_NEGATIVE'] });
run('negative is allowed when the modification starts at the first stop',
  { feed: feedOf(mods({ modifications: [{ start_stop_selector: { stop_sequence: 1 }, end_stop_selector: { stop_sequence: 1 }, replacement_stops: [{ stop_id: 'B', travel_time_to_stop: -30 }] }] })),
    reject: ['E_TRAVEL_TIME_NEGATIVE'] });
run('travel_time_to_stop must not decrease',
  { feed: feedOf(mods({ modifications: [{ start_stop_selector: { stop_sequence: 2 }, end_stop_selector: { stop_sequence: 2 }, replacement_stops: [{ stop_id: 'B', travel_time_to_stop: 120 }, { stop_id: 'B', travel_time_to_stop: 60 }] }] })),
    expect: ['E_TRAVEL_TIME_NOT_MONOTONIC'] });

console.log('\nservice_dates');
run('a trip need not run on every service_date',
  { feed: feedOf(mods({ service_dates: [TODAY, '20200101'] })), reject: ['E_TRIP_RUNS_ON_NO_SERVICE_DATE'] });
run('running on none of them is reported',
  { feed: feedOf(mods({ service_dates: ['20100101', '20100102'] })), expect: ['E_TRIP_RUNS_ON_NO_SERVICE_DATE'] });

console.log('\nAlert');
const alertFeed = (alert) => ({ header: HEADER, entity: [{ id: 'AL1', alert }] });
const okText = { translation: [{ text: 'Detour', language: 'en' }] };
run('header_text and description_text are required',
  { feed: feedOf(mods()), alerts: alertFeed({ informed_entity: [{ stop_id: 'A' }] }), expect: ['E_ALERT_MISSING_TEXT'] });
run('informed_entity is required',
  { feed: feedOf(mods()), alerts: alertFeed({ header_text: okText, description_text: okText }), expect: ['E_ALERT_NO_INFORMED_ENTITY'] });
run('a TimeRange must set start or end',
  { feed: feedOf(mods()), alerts: alertFeed({ header_text: okText, description_text: okText, informed_entity: [{ stop_id: 'A' }], active_period: [{}] }),
    expect: ['E_ALERT_EMPTY_TIMERANGE'] });
run('cause is only required when cause_detail is set',
  { feed: feedOf(mods()), alerts: alertFeed({ header_text: okText, description_text: okText, informed_entity: [{ stop_id: 'A' }] }),
    reject: ['W_ALERT_TEXT_PLACEHOLDER'] });
run('cause_detail without cause is reported',
  { feed: feedOf(mods()), alerts: alertFeed({ header_text: okText, description_text: okText, informed_entity: [{ stop_id: 'A' }], cause_detail: okText }),
    expect: ['W_ALERT_TEXT_PLACEHOLDER'] });

console.log('\nTripUpdates linkage');
const tuFeed = (entities) => ({ header: HEADER, entity: entities });
run('modified_trip must not carry route_id either',
  { feed: feedOf(mods()), tu: tuFeed([{ id: 'U1', trip_update: { trip: { route_id: 'R', modified_trip: { modifications_id: 'E1', affected_trip_id: 't1' } } } }]),
    expect: ['E_TRIP_ID_WITH_MODIFIED_TRIP'] });
run('modifications_id and affected_trip_id are both required',
  { feed: feedOf(mods()), tu: tuFeed([{ id: 'U1', trip_update: { trip: { modified_trip: { modifications_id: 'E1' } } } }]),
    expect: ['E_MODIFIED_TRIP_MISSING_FIELD'] });
run('a REPLACEMENT TripUpdate must not exist for a selected trip',
  { feed: feedOf(mods()), tu: tuFeed([{ id: 'U1', trip_update: { trip: { trip_id: 't1', schedule_relationship: 'REPLACEMENT' } } }]),
    expect: ['E_REPLACEMENT_TRIPUPDATE_EXISTS'] });
run('both a modified and a plain TripUpdate is what the spec asks for',
  { feed: feedOf(mods()), tu: tuFeed([
      { id: 'U1', trip_update: { trip: { modified_trip: { modifications_id: 'E1', affected_trip_id: 't1' } } } },
      { id: 'U2', trip_update: { trip: { trip_id: 't1' } } }]),
    reject: ['W_TU_NO_UNMODIFIED_COUNTERPART', 'W_NO_TRIPUPDATE_FOR_MODIFICATION'] });
run('a modified trip with no plain counterpart is reported',
  { feed: feedOf(mods()), tu: tuFeed([{ id: 'U1', trip_update: { trip: { modified_trip: { modifications_id: 'E1', affected_trip_id: 't1' } } } }]),
    expect: ['W_TU_NO_UNMODIFIED_COUNTERPART'] });

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
