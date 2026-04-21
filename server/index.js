import 'dotenv/config'
import express from 'express'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { VesselClient } from 'vesselapi'

import { createSlot } from './slot.js'
import { createLocalWsHub } from './localWs.js'
import { createViteMiddleware } from './vite.js'
import { testAdvanced } from './api.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const EUROPE_SLOT_KEY = 'europe'

async function main() {
  const PORT = Number(process.env.PORT || 3001)
  const BASE = (process.env.VESSELAPI_BASE || 'https://api.vesselapi.com/v1').replace(/\/$/, '')
  const WS_BASE = (process.env.VESSELAPI_WS_BASE || BASE.replace(/^http/, 'ws'))

  // POIs are built at build time (scripts/build-geo.js) and shipped as JSON.
  const poisPath = resolve(__dirname, '..', 'client', 'src', 'geo', 'pois.json')
  const POIS = JSON.parse(readFileSync(poisPath, 'utf8'))
  console.log(`[startup] ${POIS.length} POIs loaded: ${POIS.map(p => p.displayName).join(', ')}`)

  const app = express()
  const httpServer = createServer(app)
  const hub = createLocalWsHub(httpServer)

  // Session is single-user, single-key. New /api/session replaces it. A
  // monotonically increasing seedId lets a late background seed from the
  // previous session drop its writes when a newer session has superseded it.
  const session = { apiKey: null, sdk: null, seedId: 0 }
  function requireKey(res) {
    if (!session.apiKey) { res.status(401).json({ error: 'api key not set' }); return false }
    return true
  }

  // Shared registry of known vessels. Seeded at /api/session time by querying
  // the SDK around each POI, and extended on every Europe geofence_enter event.
  const seenVessels = new Map() // "imo-mmsi" → { imo, mmsi, vesselName }
  const vesselKey = (v) => `${v.imo || 0}-${v.mmsi || 0}`

  // Europe = any_vessel. Every other slot is a POI in vessel_list mode and
  // pulls its initial list from seenVessels on activate.
  const europe = createSlot({
    key: EUROPE_SLOT_KEY,
    hub,
    onEvent: async (payload) => {
      const ev = payload?.event
      if (!ev || ev.type !== 'position.geofence_enter') return
      const v = ev.vessel || {}
      if (!v.mmsi) return
      const k = vesselKey(v)
      if (seenVessels.has(k)) return
      seenVessels.set(k, { imo: v.imo || 0, mmsi: v.mmsi, vesselName: v.vesselName || '' })
      hub.broadcast({ kind: 'registry-update', count: seenVessels.size, vessel: v })
      for (const poi of POIS) {
        const slot = poiSlots.get(poi.key)
        if (!slot?.notification) continue
        try { await slot.addVessels([{ imo: v.imo || 0, mmsi: v.mmsi }]) }
        catch (e) { console.error(`[poi ${poi.key}] addVessels failed:`, e.message) }
      }
    }
  })

  const poiSlots = new Map()
  for (const poi of POIS) {
    poiSlots.set(poi.key, createSlot({ key: poi.key, hub }))
  }

  app.use(express.json({ limit: '2mb' }))

  app.get('/api/config', (_req, res) => {
    res.json({
      base: BASE,
      wsBase: WS_BASE,
      hasKey: Boolean(session.apiKey),
      registrySize: seenVessels.size,
      pois: POIS.map(p => ({
        key: p.key, name: p.name, displayName: p.displayName,
        center: p.center, bbox: p.bbox,
        polygon: p.polygon
      })),
      slots: {
        [EUROPE_SLOT_KEY]: statusSnapshot(europe),
        ...Object.fromEntries(POIS.map(p => [p.key, statusSnapshot(poiSlots.get(p.key))]))
      }
    })
  })

  app.post('/api/session', async (req, res) => {
    const { apiKey } = req.body || {}
    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey required' })
    }
    session.apiKey = apiKey.trim()
    session.sdk = new VesselClient(session.apiKey, { baseUrl: BASE })
    session.seedId += 1
    const mySeedId = session.seedId
    hub.broadcast({ kind: 'session', hasKey: true })
    res.json({ ok: true })
    seedRegistryFromPOIs(mySeedId).catch((e) => console.error('[seed] failed:', e.message))
  })

  app.post('/api/session/clear', async (_req, res) => {
    session.apiKey = null
    session.sdk = null
    seenVessels.clear()
    await Promise.allSettled([
      europe.cleanup(),
      ...POIS.map(p => poiSlots.get(p.key).cleanup())
    ])
    hub.broadcast({ kind: 'session', hasKey: false })
    hub.broadcast({ kind: 'registry-update', count: 0 })
    res.json({ ok: true })
  })

  app.post('/api/activate/:slot', async (req, res) => {
    if (!requireKey(res)) return
    const slot = resolveSlot(req.params.slot)
    if (!slot) return res.status(404).json({ error: 'unknown slot' })
    try {
      let body = req.body?.body
      if (!body) return res.status(400).json({ error: 'body required' })
      // Any POI slot folds the current registry into its vessel list so it can
      // start watching ships the demo already knows about.
      if (slot.key !== EUROPE_SLOT_KEY) {
        const seeds = [...seenVessels.values()]
          .filter(v => v.mmsi && v.mmsi > 0)
          .map(v => ({ imo: v.imo || 0, mmsi: v.mmsi }))
        const existing = (body.vessels || []).filter(v => v.mmsi && v.mmsi > 0)
        const k = (r) => `${r.imo || 0}-${r.mmsi || 0}`
        const dedup = new Map()
        for (const r of [...existing, ...seeds]) dedup.set(k(r), r)
        body = { ...body, vessels: [...dedup.values()] }
      }
      const n = await slot.activate({
        base: BASE, wsBase: WS_BASE,
        apiKey: session.apiKey, body
      })
      res.json({ notification: n })
    } catch (e) {
      console.error(`[activate ${slot.key}] failed:`, e.message)
      res.status(e.status || 500).json({ error: e.message, body: e.body })
    }
  })

  app.post('/api/deactivate/:slot', async (req, res) => {
    if (!requireKey(res)) return
    const slot = resolveSlot(req.params.slot)
    if (!slot) return res.status(404).json({ error: 'unknown slot' })
    try { await slot.deactivate(); res.json({ ok: true }) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.post('/api/test/:slot', async (req, res) => {
    if (!requireKey(res)) return
    const slot = resolveSlot(req.params.slot)
    if (!slot || !slot.notification) return res.status(409).json({ error: 'slot not active' })
    try {
      const r = await testAdvanced({ base: BASE, apiKey: session.apiKey, name: slot.notification.name })
      res.json(r)
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })

  // Vessel detail lookup — click-through from the event feed. Merges three
  // SDK calls (vessels.get for identity/dimensions, vessels.position for
  // COG/SOG/heading/nav_status, vessels.eta for destination/ETA/draught) so
  // the UI can render a single card without three round-trips.
  app.get('/api/vessel/:id', async (req, res) => {
    if (!requireKey(res)) return
    const { id } = req.params
    const idType = (req.query.type === 'mmsi' ? 'mmsi' : 'imo')
    const opts = { filterIdType: idType }
    try {
      const [vesselR, positionR, etaR] = await Promise.allSettled([
        session.sdk.vessels.get(id, opts),
        session.sdk.vessels.position(id, opts),
        session.sdk.vessels.eta(id, opts)
      ])
      res.json({
        vessel:   vesselR.status   === 'fulfilled' ? (vesselR.value?.vessel ?? null)           : null,
        position: positionR.status === 'fulfilled' ? (positionR.value?.vesselPosition ?? null) : null,
        eta:      etaR.status      === 'fulfilled' ? (etaR.value?.vesselEta ?? null)           : null
      })
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || String(e) })
    }
  })

  app.use(await createViteMiddleware())

  let closing = false
  async function shutdown(signal) {
    if (closing) return
    closing = true
    console.log(`\n[shutdown] ${signal}`)
    await Promise.allSettled([
      europe.cleanup(),
      ...POIS.map(p => poiSlots.get(p.key).cleanup())
    ])
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  httpServer.listen(PORT, () => {
    console.log(`[startup] http://localhost:${PORT}`)
    console.log(`[startup] upstream base=${BASE}`)
    console.log(`[startup] paste your api key in the UI to activate blueprints`)
  })

  function resolveSlot(name) {
    if (name === EUROPE_SLOT_KEY) return europe
    return poiSlots.get(name) || null
  }

  // Seed seenVessels from a live query around each POI's bbox. Runs in the
  // background after /api/session — not part of the response — so a slow
  // upstream doesn't delay the UI's modal dismissal. A new registry-update
  // broadcast fires once per POI so the UI's registry chip animates up.
  async function seedRegistryFromPOIs(mySeedId) {
    if (!session.sdk) return
    const sdk = session.sdk
    const before = seenVessels.size
    for (const poi of POIS) {
      // A newer /api/session has started; abandon this run so its writes
      // don't race the fresh seed.
      if (mySeedId !== session.seedId) return
      const { minLat, maxLat, minLon, maxLon } = poi.bbox
      try {
        // A 10-minute time window keeps us under the upstream's 5000-position
        // per-query cap in dense port areas. Any vessel that's currently
        // there has almost certainly pinged in the last 10 minutes.
        const nowISO = new Date().toISOString()
        const tenMinAgoISO = new Date(Date.now() - 10 * 60 * 1000).toISOString()
        const r = await sdk.location.vesselsBoundingBox({
          latMin: minLat, latMax: maxLat, lonMin: minLon, lonMax: maxLon,
          timeFrom: tenMinAgoISO, timeTo: nowISO,
          paginationLimit: 50 // API caps at 50 per page; one page per POI is plenty for the demo
        })
        if (mySeedId !== session.seedId) return
        let added = 0
        for (const v of r.vessels || []) {
          if (!v.mmsi) continue
          const k = vesselKey({ imo: v.imo || 0, mmsi: v.mmsi })
          if (seenVessels.has(k)) continue
          seenVessels.set(k, { imo: v.imo || 0, mmsi: v.mmsi, vesselName: v.vessel_name || '' })
          added++
        }
        console.log(`[seed ${poi.key}] +${added} vessels (bbox ${minLat.toFixed(2)},${minLon.toFixed(2)} - ${maxLat.toFixed(2)},${maxLon.toFixed(2)})`)
        hub.broadcast({ kind: 'registry-update', count: seenVessels.size })
      } catch (e) {
        console.error(`[seed ${poi.key}] failed:`, e.message)
      }
    }
    console.log(`[seed] done, registry ${before} → ${seenVessels.size}`)
  }
}

function statusSnapshot(slot) {
  const n = slot?.notification
  if (!n) return { active: false }
  return {
    active: n.active,
    name: n.name,
    mode: n.mode,
    prefillStatus: n.prefillStatus,
    vesselCount: n.vessels?.length || 0
  }
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
