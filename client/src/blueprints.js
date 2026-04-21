import europePolygon from './geo/europe.json'
import poiList from './geo/pois.json'

// Pre-filled request bodies for each blueprint. Anything the user edits in
// the card textarea replaces this before the server POSTs/PUTs to the API.

export const europeBlueprint = {
  name: 'showcase_europe_watch',
  mode: 'any_vessel',
  polygon: { coordinates: europePolygon.coordinates[0] },
  filterGroups: [
    { predicates: [{ field: 'eni', op: 'present' }] }
  ],
  hysteresisMeters: 500,
  websocket: true,
  // Entries only — each new ENI-carrying vessel that crosses into the zone
  // is added to every POI blueprint's allowlist so POI notifications can
  // fire on the same fleet. Exits would not contribute to that pipeline
  // and just add noise at continental scale.
  eventTypes: ['position.geofence_enter']
}

export const poiBlueprints = poiList.map(p => ({
  key: p.key,
  displayName: p.displayName,
  blueprint: {
    name: p.name,
    mode: 'vessel_list',
    polygon: { coordinates: p.polygon.coordinates[0] },
    hysteresisMeters: 100,
    // Per-notification ETA-shift threshold: a 30-minute shift counts as
    // an ETA change for port notifications (vessels slipping their slot by
    // half an hour is operationally meaningful). The advanced poller gates
    // eta.eta_changed emission on this; draught / destination events are
    // not threshold-gated.
    etaShiftThresholdMinutes: 30,
    vessels: [],
    websocket: true,
    eventTypes: [
      'position.geofence_enter',
      'position.geofence_exit',
      'eta.draught_changed'
    ]
  }
}))

// What the map renders. Europe in purple, all POIs share a cyan tone and
// tell themselves apart via the hover tooltip.
export const geoDisplay = {
  europe: {
    ring: europePolygon.coordinates[0],
    color: '#a855f7',
    fillOpacity: 0.08
  },
  pois: poiList.map(p => ({
    key: p.key,
    displayName: p.displayName,
    ring: p.polygon.coordinates[0],
    center: p.center, // [lon, lat] — used as a fallback marker location for
                      // ETA events that carry no position payload
    color: '#22d3ee',
    fillOpacity: 0.15
  }))
}
