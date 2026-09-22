# TripModifications validator

A single page that checks a GTFS-Realtime **TripModifications** feed against the static GTFS it modifies.

**<https://transitapp.github.io/tripmodifications-validator/>**

Everything runs in the browser. There is no backend, no upload, and no telemetry — the feeds you load
never leave your machine.

## Read this first: fetching by URL usually fails

Most transit servers do not send an `Access-Control-Allow-Origin` header, so a browser refuses to read
their response from another origin. A page with no backend cannot work around that, and this one does
not pretend to: it tries the fetch, and when the browser blocks it you get a plain message saying so.

**Download the file yourself and drop it on the page.** That always works, for any feed, from any server.

If you run your own CORS proxy, put its prefix in Settings and the page will put your URL after it. The
box is empty by default and the value stays in your browser's local storage. Nothing is ever routed
through a third-party proxy.

## Prefilling the URL boxes from a link

Any of the four inputs can be filled in from the query string, so you can bookmark the feeds you check
often:

```
https://transitapp.github.io/tripmodifications-validator/?static=…&mods=…&tripupdates=…&alerts=…
```

The link only fills the boxes in. Nothing is requested until you press Fetch, so opening a link someone
sent you cannot make the page go and get anything.

## What it checks

Findings are grouped into **errors** (the feed violates the spec or will break a consumer) and
**warnings** (legal but suspect), each with a stable code, and repeats collapse into one expandable row.

### Structure and spec conformance
- The header carries `gtfs_realtime_version`, `incrementality` and a `timestamp`, and that timestamp is
  close to your clock — publishing local time as if it were UTC is a common producer bug.
- Entity ids are unique.
- Each `TripModifications` has at least one `selected_trips`, one `service_dates` and one `modifications`.
- `service_dates` parse as `YYYYMMDD` and are not in the past.
- `start_times` is only used with a single trip in a single `SelectedTrips`.
- Every `StopSelector` sets `stop_sequence`, `stop_id`, or both.
- `end_stop_selector` may only be omitted for a pure insertion, so a modification with neither an
  `end_stop_selector` nor any `replacement_stops` does nothing and is reported.
- `end_stop_selector` does not come before `start_stop_selector`, and modifications within an entity are
  in increasing order and do not overlap.
- Every `ReplacementStop` has a `stop_id`; `travel_time_to_stop` is present and increases along the list.
- `propagated_modification_delay` is set on a modification that replaces stop times — without it every
  downstream time stays at schedule.
- `Shape.shape_id` does not collide with `shapes.txt`, and the polyline decodes to at least two points
  with no repeated points.
- `Stop.stop_id` does not collide with `stops.txt`, and `stop_name`, `stop_lat`, `stop_lon` are present.

### Against the static feed
- Selected `trip_id`s exist in `trips.txt` and actually run on each `service_date`, from `calendar.txt`
  plus the `calendar_dates.txt` exceptions.
- No `(trip_id, service_date)` pair is claimed twice.
- `StopSelector.stop_id` exists in `stops.txt`; when **none** of them do, that gets its own prominent
  finding, because producers commonly emit internal scheduling codes here.
- A selector that sets both `stop_sequence` and `stop_id` has them agree, and the `stop_sequence` exists
  in each selected trip — the finding shows the trip's actual range, which is usually enough to see that
  the wrong trip was selected.
- `ReplacementStop.stop_id` and `selected_trips.shape_id` resolve, either in the static feed or against a
  `Stop` / `Shape` entity in the same realtime feed.
- `Shape` and `Stop` entities that nothing in the feed references are flagged.
- An entity that mixes routes or directions, or a modification that covers a terminus, is flagged.

### Geometry
Distances are planar with a `cos(lat)` correction on longitude, and every threshold is adjustable in Settings.
- A new shape starts and ends within **200 m** of the trip's first and last stop. The spec wants the full
  trip path, not just the detour segment.
- Every **retained** stop is within **80 m** of the new shape. A retained stop off the path means the trip
  claims a stop it never reaches.
- **Removed** stops still within **40 m** of the new shape are reported as information, not as an error: a
  real stop closure looks like this, and so does a detour applied to the wrong range.

### With an Alerts feed loaded
- Every `service_alert_id` matches an `Alert` entity id, with the placeholder `"0"` called out by name.
- `informed_entity.stop_id` / `route_id` resolve against `stops.txt` / `routes.txt`.
- Unfinished text: an empty reason, a `---` placeholder, or the word "test" in the body.
- An `active_period.end` more than two years out, which is always a sentinel.

### With a TripUpdates feed loaded
- `modified_trip.modifications_id` is the **`FeedEntity.id` of a `TripModifications` entity**, not a trip
  id. Producers get this wrong constantly, so when the value turns out to be a trip id the finding says
  exactly that.
- `modified_trip.affected_trip_id` is in `trips.txt` and is selected by the entity `modifications_id` names.
- `trip_id` is not set alongside `modified_trip`.
- Entity ids are unique, and a trip does not appear both plain and modified.

## Output

A summary bar, a findings table you can filter by severity and search by entity, trip or stop id, and an
entity inspector showing each selected trip stop by stop — kept, removed or inserted, with each stop's
distance to the new shape. The optional Leaflet map draws the scheduled shape in grey, the new shape in
blue, and the stops as filled, hollow and highlighted dots. Findings export as JSON and as Markdown.

## Performance

`stop_times.txt` is the only file big enough to matter — 26 MB and roughly 700,000 rows for a mid-size
US agency, far more for a large one. The unzip and CSV parsing run in a Web Worker, the CSV scanner works
over the raw bytes so only the four columns the checks need ever become JS strings, ids are interned to
integer indices, and each trip's stop list is stored as typed arrays.

A feed that size — a 3.8 MB zip expanding to 31 MB — parses and validates in well under a second and
holds about 14 MB of heap.

## Running it locally

There is no build step. Serve the `site/` directory with anything:

```
cd site && python3 -m http.server 8000
```

Then open <http://localhost:8000/>. Opening `index.html` straight from the filesystem does not work,
because ES modules and Web Workers both need a real origin.

## The vendored .proto

`site/gtfs-realtime.proto` is a verbatim copy of `gtfs-realtime/proto/gtfs-realtime.proto` from
[google/transit](https://github.com/google/transit), taken at commit
[`474750a`](https://github.com/google/transit/commit/474750a163088673df718838d4a1bb093391f9af)
(2026-08-17). It is vendored rather than fetched so the schema this page validates against is pinned
and visible in the diff. It includes the `TripModifications`, `SelectedTrips`, `Modification`,
`StopSelector`, `ReplacementStop`, `Shape` and `Stop` messages, and `TripDescriptor.modified_trip`.

To move to a newer spec, replace that one file and check the findings that change.

## Libraries

Loaded from a CDN at runtime, no build step and no lockfile:
[protobufjs](https://github.com/protobufjs/protobuf.js) parses the `.proto` and decodes the feeds,
[fflate](https://github.com/101arrowz/fflate) unzips the static GTFS, and
[Leaflet](https://leafletjs.com/) draws the map — loaded only when you open the map tab, so a blocked
CDN costs you the map and nothing else.

## Deploying

`.github/workflows/pages.yml` publishes `site/` to GitHub Pages on every push to `main`. Nothing is
compiled; the workflow uploads the directory as it stands. All paths in the page are relative, so it also
works from a project subpath or any other static host.

## License

MIT. See [LICENSE](LICENSE).
