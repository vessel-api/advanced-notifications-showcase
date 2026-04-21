import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { geoDisplay } from './blueprints.js'

// Dark basemap + every blueprint polygon (Europe + each POI) + per-batch
// event markers. Each tick of the upstream poller delivers a burst of events;
// markers stay on the map until the next burst (detected by a BATCH_GAP quiet
// window), at which point the old batch for that slot is cleared. Each marker
// pulses for PULSE_MS then settles into a steady low-intensity dot so you can
// see where earlier events landed without strobing animation all over the map.

const PULSE_MS = 15_000          // how long the slow pulse animates
const BATCH_GAP_MS = 45_000      // quiet window → next event starts a new batch
const BASEMAP = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const BASEMAP_ATTR = '&copy; OpenStreetMap &copy; CARTO'

export default function MapView({ events, focus }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef(new Map())    // event._id → { dot, ring, interval, slot }
  const lastEventAtRef = useRef(new Map()) // slot → timestamp of last arrival

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = L.map(containerRef.current, {
      center: [50, 10],
      zoom: 4,
      worldCopyJump: true,
      preferCanvas: true,
      zoomControl: true
    })
    L.tileLayer(BASEMAP, { subdomains: 'abcd', maxZoom: 19, attribution: BASEMAP_ATTR }).addTo(map)

    // Draw Europe + every POI. smoothFactor=0 / noClip keep the boundaries
    // faithful at low zoom (Leaflet's default renderer drops sub-pixel
    // vertices, which would visually "shrink" a 50 km buffer at zoom 4).
    const drawPoly = (ring, color, fillOpacity, label) => {
      const latlngs = ring.map(([lon, lat]) => [lat, lon])
      L.polygon(latlngs, {
        color, weight: 2, opacity: 0.9,
        fillColor: color, fillOpacity,
        smoothFactor: 0, noClip: true
      }).bindTooltip(label, { sticky: false }).addTo(map)
    }
    drawPoly(geoDisplay.europe.ring, geoDisplay.europe.color, geoDisplay.europe.fillOpacity, 'europe')
    for (const p of geoDisplay.pois) {
      drawPoly(p.ring, p.color, p.fillOpacity, p.displayName)
    }

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || events.length === 0) return

    // `events` is newest-first; iterate in chronological order so batch-gap
    // detection sees arrivals in the order the server produced them.
    const chronological = [...events].reverse()
    for (const evt of chronological) {
      if (markersRef.current.has(evt._id)) continue

      const now = Date.now()
      const lastAt = lastEventAtRef.current.get(evt.slot) || 0
      if (lastAt && now - lastAt > BATCH_GAP_MS) {
        clearSlotMarkers(markersRef.current, evt.slot)
      }
      lastEventAtRef.current.set(evt.slot, now)

      const placed = placeMarker(map, evt)
      if (!placed) { markersRef.current.set(evt._id, null); continue }
      placed.slot = evt.slot
      markersRef.current.set(evt._id, placed)
    }
  }, [events])

  // Fly to the clicked event's location. Geofence events have real coords;
  // ETA events fall back to the POI centre via extractLatLon. Zoom 11 is
  // "whole port visible" — close enough to see the vessel relative to the
  // polygon without going so tight the polygon leaves the frame.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !focus) return
    const ll = extractLatLon(focus)
    if (!ll) return
    map.flyTo(ll, 11, { duration: 0.7 })
  }, [focus?._id])

  return <div ref={containerRef} className="map" />
}

function extractLatLon(evt) {
  const ev = evt?.payload?.event
  const p = ev?.data?.position
  if (p && typeof p.latitude === 'number' && typeof p.longitude === 'number') {
    return [p.latitude, p.longitude]
  }
  // ETA events carry vesselEta, not a position. The event is polygon-scoped
  // though, so the vessel is definitionally inside the POI — fall back to
  // the POI's centre so the event still renders on the map.
  if ((ev?.type || '').startsWith('eta.')) {
    const poi = geoDisplay.pois.find(p => p.key === evt.slot)
    if (poi) return [poi.center[1], poi.center[0]] // [lat, lon]
  }
  return null
}

// Per event-type color pair — Europe = purple (enters only). POIs share one
// cyan/teal family so the map reads "this is a POI hit" regardless of which
// port fired. Enter/exit use adjacent shades to stay tied to the same slot
// while being distinguishable.
const COLORS = {
  europe_enter: { core: '#a855f7', halo: '#d8b4fe' }, // purple
  poi_enter:    { core: '#22d3ee', halo: '#7dd3fc' }, // cyan
  poi_exit:     { core: '#2dd4bf', halo: '#99f6e4' }, // teal
  poi_eta:      { core: '#f59e0b', halo: '#fcd34d' }  // amber — cargo activity
}

const PULSE_FREQ_HZ = 0.4          // ~2.5s per cycle
const BASE_R = 5
const PEAK_R = 18
const ANIM_STEP_MS = 50

function paletteFor(evt) {
  if (evt.slot === 'europe') return COLORS.europe_enter
  const type = evt?.payload?.event?.type || ''
  if (type.startsWith('eta.')) return COLORS.poi_eta
  return type.endsWith('geofence_exit') ? COLORS.poi_exit : COLORS.poi_enter
}

function clearSlotMarkers(markers, slot) {
  for (const [id, m] of markers) {
    if (!m || m.slot !== slot) continue
    try { clearInterval(m.interval) } catch {}
    try { m.ring?.remove() } catch {}
    try { m.dot?.remove() } catch {}
    markers.delete(id)
  }
}

function placeMarker(map, evt) {
  const ll = extractLatLon(evt)
  if (!ll) return null
  const pal = paletteFor(evt)

  const core = L.circleMarker(ll, {
    radius: 3,
    color: pal.core, weight: 1,
    fillColor: pal.core, fillOpacity: 0.95
  }).addTo(map)

  const halo = L.circleMarker(ll, {
    radius: BASE_R,
    color: pal.halo, weight: 2,
    fillColor: pal.halo, fillOpacity: 0.25, opacity: 0.75
  }).addTo(map)

  const ev = evt.payload?.event || {}
  const vessel = ev.vessel || {}
  const label = `${vessel.vesselName || `IMO ${vessel.imo || '?'}`}\n${ev.type || ''}`
  core.bindTooltip(label, { direction: 'top' })

  // Animate the halo for PULSE_MS, then settle: remove halo, leave core as a
  // calm low-intensity dot that persists until the next batch clears it.
  const startedAt = Date.now()
  const interval = setInterval(() => {
    const elapsed = Date.now() - startedAt
    const t = Math.min(1, elapsed / PULSE_MS)
    const envelope = 1 - t                              // 1 → 0 over pulse window
    const phase = 0.5 + 0.5 * Math.sin((elapsed / 1000) * 2 * Math.PI * PULSE_FREQ_HZ)
    const r = BASE_R + (PEAK_R - BASE_R) * phase * envelope
    halo.setRadius(r)
    halo.setStyle({
      fillOpacity: 0.35 * envelope * (0.5 + 0.5 * phase),
      opacity: 0.75 * envelope
    })
    if (t >= 1) {
      clearInterval(interval)
      try { halo.remove() } catch {}
      core.setStyle({ fillOpacity: 0.7, opacity: 0.9, radius: 3 })
    }
  }, ANIM_STEP_MS)

  return { dot: core, ring: halo, interval }
}
