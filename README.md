# VesselAPI advanced notifications — live demo

A small, self-contained app that demonstrates the [VesselAPI](https://vesselapi.com)
advanced-notifications feature end-to-end: polygon geofencing with attribute
filters, per-port vessel lists, WebSocket event streaming, and click-through
vessel details. Intended as a reference implementation and a sales demo — not
a production harness.

The event payload itself carries enough vessel context for most uses —
identity (IMO/MMSI/ENI/name), classification (vessel_type, vessel_subtype),
flag (country, country_code), dimensions (length, breadth), and on
position-derived events the current heading, speed, lat/lon, nav status,
and last AIS update. The click-through modal renders all of this directly
from the WebSocket payload with **zero follow-up REST calls** for the
common case. A single `vessels.get` is fetched lazily in the background
only to fill the deeper static record (call sign, tonnage, ownership,
build year, home port) — the modal opens instantly without waiting on it.

Two types of notifications are pre-wired:

- **Europe-wide ENI filter** — `any_vessel` mode over a 50 km-buffered
  European coastline polygon, filtered to vessels that carry an ENI number.
  Every match emits a `position.geofence_enter` event on the WebSocket.
- **Six port POIs** — `vessel_list` mode over hand-drawn polygons around
  Amsterdam, Rotterdam, Antwerp, Hamburg, Piraeus, and Valencia (each with a
  2 km offshore buffer). Each POI's vessel list is seeded at startup from
  live AIS traffic and grows as the Europe blueprint registers more vessels.
  Events: `position.geofence_enter`, `position.geofence_exit`,
  `eta.draught_changed`.

WebSocket-only delivery — no inbound networking, no webhook endpoint to
register. The container just needs outbound HTTPS/WSS.

## Quickstart

Requires a VesselAPI Pro-plan API key. Advanced notifications are Pro-only.

### Docker (recommended for a clean demo)

```bash
docker build -t vesselapi-notifications-demo .
docker run --rm -p 3001:3001 vesselapi-notifications-demo
# open http://localhost:3001 and paste your API key in the modal
```

### Local development

```bash
cp .env.example .env
npm install
npm run dev
# open http://localhost:3001
```

## How it works

```
UI click "Activate Europe"
      │
      ▼
  Node server
    POST /notifications/advanced     (create or PUT)
    poll   /notifications/advanced/<name> until prefillStatus=ready
    WS      /ws/advanced?name=<name>
      │
      ▼
  local WS hub  →  React feed + map
```

On shutdown the server sends `DELETE /notifications/advanced/<name>` for each
active slot, so the account is left clean.

## Advanced notifications API reference

Advanced notifications live at `POST /v1/notifications/advanced` and let you
define a polygon plus optional attribute filters, with delivery via webhook,
WebSocket, or both. They match vessels dynamically as they move through your
geofence (up to 10 000 per notification in `vessel_list` mode, unlimited in
`any_vessel` mode). Pro plan only.

### Request body

| field | type | required | default | notes |
| --- | --- | --- | --- | --- |
| `name` | string | yes | — | 1–64 chars, letters/digits/`_`/`-`/`.`/space. Unique per user. Immutable after create. |
| `mode` | `"any_vessel"` \| `"vessel_list"` | yes | — | Immutable after create. |
| `polygon.coordinates` | `[[lon, lat], …]` | yes | — | 4–5 000 points, closed ring (first and last identical), no holes, must not cross the antimeridian. |
| `filterGroups` | `FilterGroup[]` | no | `[]` | AND within a group, OR across groups. Up to 20 groups × 20 predicates. Empty list matches all. |
| `hysteresisMeters` | int | no | `50` | 0–10 000. Vessel must be this many metres past the boundary to count as exited. Prevents flapping. |
| `etaShiftThresholdMinutes` | int | no | `120` | 1–1 440. Delta required before `eta.eta_changed` fires. |
| `vessels` | `{imo?, mmsi}[]` | required in `vessel_list` | — | Up to 10 000. MMSI is mandatory — IMO alone is insufficient because the server's state table is keyed on MMSI. |
| `eventTypes` | string[] | no | all | Any subset of the event types listed below. Empty list = all of them. |
| `webhookUrl` | string | no | — | HTTPS endpoint to receive events. Must be public (private/loopback IPs rejected at create and dial time). |
| `webhookSecret` | string | required if `webhookUrl` set | — | HMAC-SHA256 key; signature in `X-Signature-256` header. |
| `websocket` | bool | no | `false` | Enables `/v1/ws/advanced?name=<name>` delivery. |
| `skipPrefill` | bool | no | `false` | Opt-in. See the prefill section below. |

At least one delivery channel must be set (`webhookUrl` or `websocket: true`).

### Polygon

A single closed ring of `[longitude, latitude]` pairs in WGS84. Longitude
comes first (GeoJSON convention). The first and last points must be
identical. Winding direction does not matter.

**Example — a 1° × 1° rectangle over the southern North Sea**

```json
{
  "polygon": {
    "coordinates": [
      [4.0, 52.0],
      [5.0, 52.0],
      [5.0, 53.0],
      [4.0, 53.0],
      [4.0, 52.0]
    ]
  }
}
```

For larger areas, trace the coastline in a GIS tool (QGIS / geojson.io /
Mapbox Studio) at roughly 1 km precision and export the outer ring. The
server simplifies the ring (PostGIS `ST_SimplifyPreserveTopology` at
~1 km tolerance) and repairs self-intersections (`ST_MakeValid`) before
storing it, so over-precise input is wasted but not rejected.

Constraints: 4–5 000 points, closed ring, no holes, must not cross the
antimeridian (180° longitude seam). Polygons that span the seam have to be
split into east-side and west-side halves and registered as two
notifications.

### Filter predicates

Filters are structured in two nested levels. Each `FilterGroup` is an
**AND** of predicates (all must match). Multiple `FilterGroup`s are **OR**ed
together (any group may match). This is how you combine "all of" and
"any of" semantics without needing dedicated `any` / `all` operators.

| field | operators |
| --- | --- |
| `eni` | `present`, `eq` |
| `vesselType` | `eq`, `in`, `present` |
| `length` | `eq`, `gte`, `lte` |

**Predicate shape**

```json
{ "field": "<eni|vesselType|length>",
  "op":    "<eq|in|gte|lte|present>",
  "value":  <string or number>,     // for eq/gte/lte
  "values": ["a", "b"]               // for in (string list only)
}
```

`present` takes no value / values. `in` is strings only. `gte` / `lte` are
numbers only. Mixing is rejected at validate time.

**Example 1 — all conditions must match** (single group)

> *"Cargo-class vessels over 100 m that have an ENI number"*

```json
{
  "filterGroups": [
    {
      "predicates": [
        { "field": "vesselType", "op": "eq",  "value": "Cargo" },
        { "field": "length",     "op": "gte", "value": 100 },
        { "field": "eni",        "op": "present" }
      ]
    }
  ]
}
```

**Example 2 — any condition may match** (multiple groups, one predicate each)

> *"Either a tanker, or a vessel with an ENI number, or a very large ship"*

```json
{
  "filterGroups": [
    { "predicates": [ { "field": "vesselType", "op": "eq",  "value": "Tanker" } ] },
    { "predicates": [ { "field": "eni",        "op": "present" } ] },
    { "predicates": [ { "field": "length",     "op": "gte", "value": 300 } ] }
  ]
}
```

**Example 3 — mix of both** (AND inside each group, OR across groups)

> *"(Cargo ≥ 100 m with ENI) OR (Tanker ≥ 150 m)"*

```json
{
  "filterGroups": [
    {
      "predicates": [
        { "field": "vesselType", "op": "eq",  "value": "Cargo" },
        { "field": "length",     "op": "gte", "value": 100 },
        { "field": "eni",        "op": "present" }
      ]
    },
    {
      "predicates": [
        { "field": "vesselType", "op": "eq",  "value": "Tanker" },
        { "field": "length",     "op": "gte", "value": 150 }
      ]
    }
  ]
}
```

Caps: up to 20 groups, 20 predicates per group, 200 values per `in` list,
256 chars per string value. Empty `filterGroups` matches every vessel in
the polygon.

### Event types

| type | source | delta object | fires when |
| --- | --- | --- | --- |
| `position.geofence_enter` | `vessel_positions` | `geofenceChange` | vessel's latest position is inside the polygon and prior state was outside / untracked |
| `position.geofence_exit` | `vessel_positions` | `geofenceChange` | vessel was inside and is now `hysteresisMeters` past the boundary |
| `eta.draught_changed` | `vessel_eta` | `draughtChange` | reported draught changes by more than 0.1 m |
| `eta.destination_changed` | `vessel_eta` | `destinationChange` | reported destination string changes to a new non-empty value |
| `eta.eta_changed` | `vessel_eta` | `etaChange` | absolute ETA shift ≥ `etaShiftThresholdMinutes` |

Every event payload includes a full contract object (`data.position`,
`data.vesselEta`, etc. — same shape as the REST API responses) plus the
typed delta, so you usually don't need a follow-up call to render the event.

**Naming caveat** — the `eta.*` prefix is a source-table grouping (all three
events come from the same AIS message type that carries destination, ETA and
draught together), not a semantic one. A draught change is really cargo
activity, not an ETA update. The prefix is known-confusing; a cleaner
namespace (likely `cargo.draught_changed` and similar) will be introduced with
a deprecation window for existing consumers.

### Prefill lifecycle

When you create or polygon-update a notification, the backend seeds
per-vessel state rows for every vessel currently matching the polygon +
filters. Without this seed, the very first poll tick would see every match
as "never tracked before" and emit an `enter` event for all of them at once —
a one-time storm that's noise, not signal.

The lifecycle field is `prefillStatus` on the notification response:

- `pending` — created, waiting for the background runner to pick it up.
- `running` — the seed query is executing.
- `ready` — events are flowing on the next poll tick.
- `failed` — the seed hit a hard timeout or match-size cap; `prefillError`
  carries the reason, `active` is flipped to `false`.

Usually the transition to `ready` takes a few seconds; longer for very
large polygons. **No events flow until `ready`.** Connecting a WebSocket
earlier returns `409 Conflict` with the current status in the body; poll
`GET /v1/notifications/advanced/<name>` until `prefillStatus === "ready"`.

### `skipPrefill: true`

Opt-in only, create-time only. If you actually want the initial snapshot
delivered as events — e.g. bootstrapping a view of "what's in this zone
right now" — set `skipPrefill: true`. The notification goes straight to
`ready`, state is left empty, and the first poll tick fires `enter` for
every currently-matching vessel.

The flag is ignored on `PUT` updates: polygon or filter changes always
run a normal prefill because the stale state would otherwise misrepresent
reality and produce phantom enters / exits.

### WebSocket delivery

```
GET wss://api.vesselapi.com/v1/ws/advanced?name=<name>
Authorization: Bearer <api-key>
```

Server-side pings every 30 s; respond with pong within 10 s. Only one
connection per notification; opening a new one replaces the previous.

### Webhook delivery

`POST <webhookUrl>` with body = event envelope (JSON). Headers:

- `X-Signature-256: sha256=<hex>` — HMAC-SHA256 of the raw body with
  `webhookSecret`. Verify this before processing.
- `X-Event-Type: <event.type>`
- `X-Delivery-ID: <event.id>`

Retry policy: 3 attempts with exponential backoff on 5xx / network error;
2xx is treated as success; 4xx is NOT retried (receiver bug).

### Rate limits

Exceeded requests return HTTP 429 with `Retry-After: 60`:

- 500 req / 5 min per source IP (any endpoint)
- 3 000 req / 5 min per API key (any endpoint)
- 300 req / 5 min per API key on `/v1/location/vessels/bounding-box` and
  `/v1/location/vessels/radius`

Location searches also enforce a density cap, HTTP 400 with
`code: "bounding_box_too_dense"`: bounding-box and radius queries whose
`area × time window` would match more than 5 000 vessel positions are
rejected before executing. Narrow the search area, or pass explicit
`time.from` / `time.to` (RFC3339) to shrink the default 2-hour window.

## Demo configuration

`.env` (optional — defaults target production):

| var | default | purpose |
| --- | ------- | ------- |
| `VESSELAPI_BASE` | `https://api.vesselapi.com/v1` | REST base URL |
| `VESSELAPI_WS_BASE` | `wss://api.vesselapi.com/v1` | WebSocket base URL |
| `PORT` | `3001` | local HTTP port |

The API key is entered through the UI and held only in memory. It is never
written to disk, never logged, and deliberately not an env var.

## Layout

```
scripts/build-geo.js              # builds the polygons at build time
server/                           # Node + Express
  index.js                        # HTTP routes, slot orchestration, vessel seeding
  slot.js                         # one notification's lifecycle
  api.js                          # REST wrappers for /notifications/advanced
  upstreamWs.js                   # WebSocket client with auto-reconnect
  localWs.js                      # hub broadcasting to the browser
  vite.js                         # Vite middleware (dev-mode SPA)
client/src/                       # React UI (Leaflet map, blueprint cards, details modal)
```

## License

MIT — see [LICENSE](./LICENSE). Provided for demonstration purposes;
copy, adapt, and ship the patterns in your own VesselAPI integration without
attribution.
