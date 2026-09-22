// Decoding GTFS-Realtime with the .proto vendored next to this file.

let rootPromise = null;

export function loadProto() {
  if (!rootPromise) {
    rootPromise = fetch(new URL('../gtfs-realtime.proto', import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error('could not read the vendored gtfs-realtime.proto (HTTP ' + r.status + ')');
        return r.text();
      })
      // keepCase leaves field names as the spec writes them, so messages and
      // the JSON export use snake_case throughout.
      .then((text) => protobuf.parse(text, { keepCase: true }).root);
  }
  return rootPromise;
}

export async function decodeFeed(bytes, label) {
  const root = await loadProto();
  const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
  let msg;
  try {
    msg = FeedMessage.decode(new Uint8Array(bytes));
  } catch (e) {
    throw new Error(`${label} is not a readable GTFS-Realtime FeedMessage — ${e.message}. ` +
      'A truncated download or an HTML error page saved as .pb both look like this.');
  }
  // defaults:false keeps unset optional fields absent, which several checks
  // depend on (propagated_modification_delay and stop_sequence both default to 0).
  return FeedMessage.toObject(msg, { defaults: false, longs: Number, enums: String, bytes: String });
}

export function entitiesOfKind(feed, key) {
  return (feed.entity || []).filter((e) => e[key] !== undefined && e[key] !== null);
}
