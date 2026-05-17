#!/usr/bin/env node
// Precompute the Europe polygon + all POI polygons at build time. Output goes
// to client/src/geo/ as JSON the runtime consumes directly.
//
// Europe: union of European country polygons, 50 km outward buffer, simplified,
//         largest outer ring extracted (API requires a single closed ring
//         without holes).
// POIs:   hand-drawn rings around six of the busiest European container ports,
//         each with a 2 km outward buffer. Real-world polygons that the
//         notifications API matches against the live AIS stream at runtime.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import geoMaps from '@geo-maps/countries-land-10km'
import * as turf from '@turf/turf'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'client', 'src', 'geo')
mkdirSync(OUT_DIR, { recursive: true })

// Geographic Europe (excl. Russia/Turkey to keep the map focused, plus a few
// microstates that aren't in the 10km dataset).
const EUROPE_A3 = [
  'AND','AUT','ALB','BIH','BEL','BGR','CHE','CZE','DEU','DNK','ESP','EST',
  'FIN','FRA','GRC','HRV','HUN','IRL','ITA','LIE','LTU','LUX','LVA','MDA',
  'MKD','MNE','NLD','NOR','POL','PRT','ROU','SRB','SVK','SVN','SWE','UKR',
  'XKX','GBR','ISL','CYP','MLT'
]

// Rough hand-drawn rings around each port (approximately enclosing the port
// basins + seaward approaches). The 2km buffer applied below smooths them and
// pushes the boundary a few km into the sea, which gives the geofence some
// stand-off so vessel_list notifications don't flap as ships hug the quay.
const POI_SPECS = [
  {
    key: 'amsterdam', name: 'showcase_amsterdam_port', displayName: 'Amsterdam',
    center: [4.90, 52.40],
    ring: [
      [4.52, 52.48], [4.52, 52.44], [4.64, 52.43], [4.80, 52.40],
      [4.92, 52.39], [5.02, 52.38], [5.02, 52.44], [4.92, 52.45],
      [4.80, 52.46], [4.64, 52.47], [4.52, 52.48]
    ]
  },
  {
    key: 'rotterdam', name: 'showcase_rotterdam_port', displayName: 'Rotterdam',
    center: [4.20, 51.92],
    ring: [
      [3.94, 51.99], [3.94, 51.92], [4.06, 51.87], [4.30, 51.85],
      [4.50, 51.86], [4.60, 51.92], [4.50, 51.97], [4.30, 51.99],
      [4.10, 51.99], [3.94, 51.99]
    ]
  },
  {
    key: 'antwerp', name: 'showcase_antwerp_port', displayName: 'Antwerp',
    center: [4.35, 51.30],
    ring: [
      [4.20, 51.41], [4.20, 51.20], [4.30, 51.18], [4.45, 51.20],
      [4.48, 51.30], [4.45, 51.39], [4.35, 51.42], [4.20, 51.41]
    ]
  },
  {
    key: 'hamburg', name: 'showcase_hamburg_port', displayName: 'Hamburg',
    center: [9.95, 53.54],
    ring: [
      [9.70, 53.58], [9.70, 53.50], [9.90, 53.48], [10.10, 53.50],
      [10.12, 53.55], [10.05, 53.60], [9.85, 53.60], [9.70, 53.58]
    ]
  },
  {
    key: 'piraeus', name: 'showcase_piraeus_port', displayName: 'Piraeus',
    center: [23.62, 37.94],
    ring: [
      [23.55, 37.98], [23.55, 37.91], [23.60, 37.89], [23.68, 37.90],
      [23.70, 37.94], [23.68, 37.98], [23.60, 37.99], [23.55, 37.98]
    ]
  },
  {
    key: 'valencia', name: 'showcase_valencia_port', displayName: 'Valencia',
    center: [-0.29, 39.44],
    ring: [
      [-0.38, 39.48], [-0.38, 39.42], [-0.30, 39.40], [-0.22, 39.42],
      [-0.20, 39.46], [-0.25, 39.49], [-0.32, 39.49], [-0.38, 39.48]
    ]
  }
]

function buildEurope() {
  const world = geoMaps()
  const feats = world.features.filter(f => EUROPE_A3.includes(f.properties.A3))
  console.log(`[europe] loaded ${feats.length} country features`)

  const buffered = feats.map((f) => turf.buffer(f, 50, { units: 'kilometers' }))
  let merged = buffered[0]
  for (let i = 1; i < buffered.length; i++) {
    merged = turf.union(turf.featureCollection([merged, buffered[i]]))
    if (!merged) throw new Error(`union failed at index ${i}`)
  }

  const polys = merged.geometry.type === 'MultiPolygon'
    ? merged.geometry.coordinates
    : [merged.geometry.coordinates]
  let best = polys[0]
  let bestArea = turf.area(turf.polygon(best))
  for (let i = 1; i < polys.length; i++) {
    const a = turf.area(turf.polygon(polys[i]))
    if (a > bestArea) { best = polys[i]; bestArea = a }
  }
  const outer = turf.polygon([best[0]])
  const simplified = turf.simplify(outer, { tolerance: 0.05, highQuality: false })
  const ring = simplified.geometry.coordinates[0]
  console.log(`[europe] mainland area=${(bestArea / 1e6).toFixed(0)} km², ring ${best[0].length} → ${ring.length} pts`)
  return { type: 'Polygon', coordinates: [ring] }
}

// A GeoJSON linear ring must repeat its first vertex as the last. Hand-drawn
// POI rings sometimes do, sometimes don't — normalize so turf is happy.
function ringIsClosed(ring) {
  if (ring.length < 2) return false
  const first = ring[0]
  const last = ring[ring.length - 1]
  return first[0] === last[0] && first[1] === last[1]
}

function buildPOI(spec) {
  // Ensure the input ring closes (turf requires it) then buffer 2km.
  const ring = ringIsClosed(spec.ring) ? spec.ring : [...spec.ring, spec.ring[0]]
  const poly = turf.polygon([ring])
  const buffered = turf.buffer(poly, 2, { units: 'kilometers' })

  // Buffer on a small concave polygon near the coast can split into multiple
  // polygons; take the largest and drop any holes (API requires a single
  // closed ring).
  const polys = buffered.geometry.type === 'MultiPolygon'
    ? buffered.geometry.coordinates
    : [buffered.geometry.coordinates]
  let best = polys[0]
  let bestArea = turf.area(turf.polygon(best))
  for (let i = 1; i < polys.length; i++) {
    const a = turf.area(turf.polygon(polys[i]))
    if (a > bestArea) { best = polys[i]; bestArea = a }
  }
  const simplified = turf.simplify(turf.polygon([best[0]]), { tolerance: 0.001, highQuality: true })
  const finalRing = simplified.geometry.coordinates[0]
  const bbox = ringBbox(finalRing)
  console.log(`[poi ${spec.key}] ${finalRing.length} pts, area=${(bestArea / 1e6).toFixed(1)} km²`)
  return {
    key: spec.key,
    name: spec.name,
    displayName: spec.displayName,
    center: spec.center,
    bbox,
    polygon: { type: 'Polygon', coordinates: [finalRing] }
  }
}

function ringBbox(ring) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return { minLon, maxLon, minLat, maxLat }
}

const europe = buildEurope()
const pois = POI_SPECS.map(buildPOI)

writeFileSync(resolve(OUT_DIR, 'europe.json'), JSON.stringify(europe))
writeFileSync(resolve(OUT_DIR, 'pois.json'), JSON.stringify(pois))
console.log(`[done] wrote europe.json + pois.json (${pois.length} POIs)`)
