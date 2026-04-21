import { createAdvanced, updateAdvanced, getAdvanced, deleteAdvanced } from './api.js'
import { connectAdvancedUpstream } from './upstreamWs.js'

const PREFILL_POLL_MS = 2000
const PREFILL_MAX_MS = 5 * 60 * 1000

// A "slot" is one of the blueprint notifications the demo manages (Europe +
// one per POI). It owns the upstream notification's lifecycle plus the local
// WebSocket connection, and reports status/events through the hub tagged with
// its slot key. Callers pass onEvent so the orchestrator can cross-wire slots
// (Europe → POI vessel list) without slots needing to know about each other.
export function createSlot({ key, hub, onEvent }) {
  let config = null            // { base, wsBase, apiKey }
  let currentBody = null       // last create/update body (for diffs)
  let notification = null      // latest upstream response
  let upstream = null          // WS handle
  let prefillPoller = null
  let prefillDeadline = 0
  let statusState = 'idle'

  function broadcastStatus(patch) {
    statusState = patch.state || statusState
    hub.broadcast({
      kind: 'slot-status',
      slot: key,
      state: statusState,
      prefillStatus: notification?.prefillStatus || null,
      active: notification?.active ?? null,
      vesselCount: notification?.vessels?.length ?? null,
      ...patch
    })
  }

  function stopPoller() {
    if (prefillPoller) { clearInterval(prefillPoller); prefillPoller = null }
  }

  function closeUpstream() {
    if (upstream) { try { upstream.close() } catch {} upstream = null }
  }

  async function pollPrefillOnce() {
    try {
      const n = await getAdvanced({ ...config, name: currentBody.name })
      if (!n) return
      notification = n
      broadcastStatus({ state: statusState })
      if (n.prefillStatus === 'ready' && n.active) {
        stopPoller()
        openUpstream()
      } else if (n.prefillStatus === 'failed') {
        stopPoller()
        broadcastStatus({ state: 'error', error: n.prefillError || 'prefill failed' })
      } else if (Date.now() > prefillDeadline) {
        stopPoller()
        broadcastStatus({ state: 'error', error: `prefill timed out after ${PREFILL_MAX_MS / 1000}s` })
      }
    } catch (e) {
      console.error(`[slot ${key}] prefill poll failed:`, e.message)
    }
  }

  function startPrefillPoller() {
    stopPoller()
    prefillDeadline = Date.now() + PREFILL_MAX_MS
    prefillPoller = setInterval(pollPrefillOnce, PREFILL_POLL_MS)
    pollPrefillOnce()
  }

  function openUpstream() {
    if (upstream) return
    broadcastStatus({ state: 'connecting' })
    upstream = connectAdvancedUpstream({
      wsBase: config.wsBase,
      apiKey: config.apiKey,
      name: currentBody.name,
      onEvent: (payload) => {
        // Envelope looks like { object: 'event', event: {...} }
        hub.broadcast({
          kind: 'event',
          slot: key,
          receivedAt: new Date().toISOString(),
          payload
        })
        onEvent?.(payload)
      },
      onStatus: (state, meta) => broadcastStatus({ state, ...meta })
    })
  }

  return {
    key,
    get notification() { return notification },
    get config() { return config },

    // Create or overwrite the slot. If the notification already exists it's
    // updated (polygon/filters/vessels); otherwise it's created.
    async activate({ base, wsBase, apiKey, body }) {
      config = { base, wsBase, apiKey }
      currentBody = body
      closeUpstream()
      stopPoller()
      broadcastStatus({ state: 'creating' })
      const existing = await getAdvanced({ base, apiKey, name: body.name })
      if (existing) {
        // Can't change mode/name via PUT — everything else is fair game.
        const { name, mode, ...rest } = body
        notification = await updateAdvanced({ base, apiKey, name: body.name, body: { ...rest, active: true } })
      } else {
        notification = await createAdvanced({ base, apiKey, body })
      }
      broadcastStatus({ state: 'waiting-prefill' })
      startPrefillPoller()
      return notification
    },

    // Append vessels to the current notification. POIs call this whenever
    // Europe picks up a new ENI-carrying vessel, so the POI list keeps growing
    // to match the registered fleet. MMSI==0 is dropped because the
    // vessel_list validator rejects it (the state table is keyed on MMSI).
    async addVessels(newRefs) {
      if (!notification || !config || !currentBody) return
      const withMmsi = newRefs.filter(r => r.mmsi && r.mmsi > 0)
      if (withMmsi.length === 0) return
      const existing = notification.vessels || []
      const k = (r) => `${r.imo || 0}-${r.mmsi || 0}`
      const seen = new Set(existing.map(k))
      const toAdd = withMmsi.filter(r => !seen.has(k(r)))
      if (toAdd.length === 0) return
      const merged = [...existing, ...toAdd]
      notification = await updateAdvanced({
        ...config, name: currentBody.name, body: { vessels: merged }
      })
      currentBody = { ...currentBody, vessels: merged }
      broadcastStatus({ state: statusState })
    },

    async deactivate() {
      closeUpstream()
      stopPoller()
      if (config && currentBody?.name) {
        try { await deleteAdvanced({ ...config, name: currentBody.name }) } catch (e) {
          console.error(`[slot ${key}] delete failed:`, e.message)
        }
      }
      notification = null
      currentBody = null
      config = null
      broadcastStatus({ state: 'idle' })
    },

    async cleanup() {
      closeUpstream()
      stopPoller()
      if (config && currentBody?.name) {
        try { await deleteAdvanced({ ...config, name: currentBody.name }) } catch (e) {
          console.error(`[slot ${key}] cleanup delete failed:`, e.message)
        }
      }
    }
  }
}
