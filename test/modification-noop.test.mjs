// node test/modification-noop.test.mjs
//
// Omitting end_stop_selector is legal for a pure insertion AND for the spec's
// shape-only modification, so the no-op check has to be narrow. These are the
// cases that kept it honest.
import { validate } from '../site/js/validate.js';

const feed = (mod, selected) => ({
  header: { gtfs_realtime_version: '2.0', timestamp: Math.floor(Date.now() / 1000) },
  entity: [{ id: 'E1', trip_modifications: {
    selected_trips: [selected], service_dates: ['20991231'], modifications: [mod],
  } }],
});
const start = { start_stop_selector: { stop_sequence: 5 } };
const run = (name, mod, selected) => {
  const out = validate({ modsFeed: feed(mod, selected), gtfs: null, settings: {} });
  const hit = out.findings.items.filter((f) => f.code === 'E_MODIFICATION_NOOP');
  console.log((hit.length ? 'REPORTED ' : 'silent   ') + ' | ' + name);
};

console.log('should stay silent (all legal per the spec):');
run('shape-only: entity supplies a new shape_id', start, { trip_ids: ['t'], shape_id: 'new1' });
run('pure insertion: replacement_stops, no end selector',
    { ...start, replacement_stops: [{ stop_id: 'a', travel_time_to_stop: 60 }] }, { trip_ids: ['t'] });
run('replaces stop times: end selector present',
    { ...start, end_stop_selector: { stop_sequence: 8 } }, { trip_ids: ['t'] });
run('pure delay injection: propagated_modification_delay set',
    { ...start, propagated_modification_delay: 120 }, { trip_ids: ['t'] });

console.log('\nshould be reported (genuinely changes nothing):');
run('nothing but a start selector', start, { trip_ids: ['t'] });
run('start selector + an alert link only', { ...start, service_alert_id: '7' }, { trip_ids: ['t'] });
run('empty shape_id string is not a new shape', start, { trip_ids: ['t'], shape_id: '' });
