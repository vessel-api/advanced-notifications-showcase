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

// Animation tuning. PULSE_FREQ_HZ keeps the halo's "breathing" rate slow
// enough that simultaneously animating dozens of markers reads as calm rather
// than strobing (~2.5 s per full cycle). BASE_R / PEAK_R bound the halo radius
// in CSS pixels — the dot at the centre is radius 3, so a peak of 18 leaves a
// clear ring without swamping the underlying polygon.
const PULSE_FREQ_HZ = 0.4         // ~2.5 s per breathing cycle
const BASE_R = 5                  // halo radius at rest (px)
const PEAK_R = 18                 // halo radius at envelope peak (px)

export default function MapView({ events, focus }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  // event._id → { dot, ring, startedAt, slot } OR null for events that
  // couldn't be placed (no lat/lon). The latter still occupies the key so we
  // don't reprocess them on every events change.
  const markersRef = useRef(new Map())
  const lastEventAtRef = useRef(new Map()) // slot → timestamp of last arrival
  // requestAnimationFrame handle for the single shared pulse loop. One loop
  // ticks all active markers — the alternative of one setInterval per marker
  // multiplies into thousands of callbacks/second on a busy demo.
  const rafRef = useRef(null)

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

    // One shared rAF loop. Each frame walks markersRef once and updates any
    // still-pulsing halo; finished pulses settle their core and detach their
    // halo. This replaces the old per-marker setInterval (which at 20 fps ×
    // N markers was a thousands-of-callbacks/sec hotspot).
    const tick = () => {
      const now = Date.now()
      for (const [id, m] of markersRef.current) {
        if (!m) {
          // null entries are placeholders for unplaceable events; drop them so
          // the map doesn't accumulate per-event keys for the page's lifetime.
          markersRef.current.delete(id)
          continue
        }
        if (!m.ring) continue
        const elapsed = now - m.startedAt
        const t = Math.min(1, elapsed / PULSE_MS)
        const envelope = 1 - t                          // 1 → 0 over pulse window
        const phase = 0.5 + 0.5 * Math.sin((elapsed / 1000) * 2 * Math.PI * PULSE_FREQ_HZ)
        const r = BASE_R + (PEAK_R - BASE_R) * phase * envelope
        m.ring.setRadius(r)
        m.ring.setStyle({
          fillOpacity: 0.35 * envelope * (0.5 + 0.5 * phase),
          opacity: 0.75 * envelope
        })
        if (t >= 1) {
          try { m.ring.remove() } catch {}
          m.ring = null
          m.dot.setStyle({ fillOpacity: 0.7, opacity: 0.9, radius: 3 })
          // Drop the tracking entry once the halo is detached so the per-frame
          // walk stays O(active pulses) instead of O(total events seen). The
          // settled dot stays on the Leaflet map (the intended "trail" effect)
          // and is cleaned up when the map unmounts. A consequence is that
          // batch-gap clearing (clearSlotMarkers) can no longer reach these
          // settled dots — acceptable for a demo and trumped by avoiding the
          // unbounded per-frame growth.
          markersRef.current.delete(id)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      // Map removal cascades to layers, but in an SPA route change the refs
      // would otherwise hold onto stale Leaflet objects — clear them so the
      // next mount starts from a clean slate.
      markersRef.current.clear()
      lastEventAtRef.current.clear()
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || events.length === 0) return

    // `events` is newest-first; iterate in chronological order so batch-gap
    // detection sees arrivals in the order the server produced them. We use
    // event.receivedAt (server-attached ISO timestamp) rather than Date.now()
    // so paused-tab resumes don't fire a spurious "new batch" — the gap is
    // measured between server arrivals, not between client renders.
    const chronological = [...events].reverse()
    for (const evt of chronological) {
      if (markersRef.current.has(evt._id)) continue

      const arrivedAt = evt.receivedAt ? Date.parse(evt.receivedAt) : Date.now()
      const lastAt = lastEventAtRef.current.get(evt.slot) || 0
      if (lastAt && arrivedAt - lastAt > BATCH_GAP_MS) {
        clearSlotMarkers(markersRef.current, evt.slot)
      }
      lastEventAtRef.current.set(evt.slot, arrivedAt)

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

function paletteFor(evt) {
  if (evt.slot === 'europe') return COLORS.europe_enter
  const type = evt?.payload?.event?.type || ''
  if (type.startsWith('eta.')) return COLORS.poi_eta
  return type.endsWith('geofence_exit') ? COLORS.poi_exit : COLORS.poi_enter
}

function clearSlotMarkers(markers, slot) {
  for (const [id, m] of markers) {
    if (!m || m.slot !== slot) continue
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

  // The shared rAF loop (set up in the map-init effect) animates `ring` from
  // BASE_R / PEAK_R for PULSE_MS, then detaches it and settles the core.
  return { dot: core, ring: halo, startedAt: Date.now() }
}
