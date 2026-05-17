import { useEffect, useState } from 'react'
import MapView from './Map.jsx'
import SlotCard from './SlotCard.jsx'
import VesselDetails from './VesselDetails.jsx'
import { useFeed } from './useFeed.js'
import { europeBlueprint, poiBlueprints } from './blueprints.js'

// Friendly short labels for the feed. On the wire the event type stays
// "eta.draught_changed" (shared with classic notifications, not our call
// to rename upstream) — this is demo-side polish only. Hoisted to module
// scope so it isn't reallocated on every render (matches TYPE_TO_BADGE_LABEL
// below).
const TYPE_LABEL = {
  'position.geofence_enter': 'enter',
  'position.geofence_exit':  'exit',
  'eta.draught_changed':     'draught',
  'eta.destination_changed': 'destination',
  'eta.eta_changed':         'eta shift'
}

export default function App() {
  const { localState, slots, events, registrySize } = useFeed()
  const [hasKey, setHasKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [keyErr, setKeyErr] = useState(null)
  const [submittingKey, setSubmittingKey] = useState(false)
  // { vessel, event } — the event is passed alongside the vessel so the
  // details card can render a "what changed" banner for the specific delta.
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(c => setHasKey(Boolean(c?.hasKey))).catch(() => {})
  }, [])

  const submitKey = async (e) => {
    e?.preventDefault?.()
    setKeyErr(null)
    if (!apiKey.trim()) return
    setSubmittingKey(true)
    try {
      const r = await fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() })
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`)
      setHasKey(true)
      // Drop the key from React state once the server has it — the input is
      // unmounted alongside the modal, but clearing here means no stale copy
      // sits in the closure for the lifetime of the page.
      setApiKey('')
    } catch (e) { setKeyErr(e.message) }
    finally { setSubmittingKey(false) }
  }

  const clearKey = async () => {
    await fetch('/api/session/clear', { method: 'POST' })
    setApiKey('')
    setHasKey(false)
  }

  const activate = (slot) => async (body) => {
    const r = await fetch(`/api/activate/${slot}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
  }
  const deactivate = (slot) => async () => {
    const r = await fetch(`/api/deactivate/${slot}`, { method: 'POST' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  }
  const test = (slot) => async () => {
    const r = await fetch(`/api/test/${slot}`, { method: 'POST' })
    const data = await r.json()
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
  }

  const europeEvents = events.filter(e => e.slot === 'europe').length
  const poiEvents = events.length - europeEvents

  return (
    <div className="app">
      <MapView events={events} focus={selected?.event} />

      <div className="hud-top">
        <div className="brand">
          <span className="brand-badge">VESSELAPI</span>
          <span className="brand-title">Advanced Notifications — Live Showcase</span>
        </div>
        <div className="hud-status">
          <span className="meta-chip">local WS: <b>{localState}</b></span>
          <span className="meta-chip">europe: <b>{europeEvents}</b></span>
          <span className="meta-chip">POIs: <b>{poiEvents}</b></span>
          <span className="meta-chip">registry: <b>{registrySize}</b></span>
        </div>
      </div>

      <div className="hud-left">
        <SlotCard
          slot="europe"
          title="Europe — ENI vessels"
          tone="europe"
          blueprint={europeBlueprint}
          status={slots.europe}
          disabled={!hasKey}
          onActivate={activate('europe')}
          onDeactivate={deactivate('europe')}
          onTest={test('europe')}
        />
        {poiBlueprints.map((p) => (
          <SlotCard
            key={p.key}
            slot={p.key}
            title={`${p.displayName} port`}
            tone="poi"
            blueprint={p.blueprint}
            status={slots[p.key]}
            disabled={!hasKey || registrySize === 0}
            disabledReason={!hasKey ? null : registrySize === 0
              ? 'Waiting for the session to seed the vessel registry — a few seconds. Activate Europe in the meantime to grow the list from live traffic.'
              : null}
            onActivate={activate(p.key)}
            onDeactivate={deactivate(p.key)}
            onTest={test(p.key)}
          />
        ))}
        <div className="key-controls">
          {hasKey && (
            <button className="key-change" onClick={clearKey}>
              change API key
            </button>
          )}
        </div>
      </div>

      <div className="hud-right">
        <div className="feed-title">Event feed <span className="feed-hint">(click a row for vessel details)</span></div>
        {events.length === 0
          ? <div className="feed-empty">No events yet. Activate a blueprint and wait for vessels to cross its boundary — or click "Test event" after prefill is ready.</div>
          : <div className="feed">{events.map(e => (
              <EventRow
                key={e._id}
                event={e}
                label={TYPE_LABEL[e.payload?.event?.type] || e.payload?.event?.type}
                onOpen={() => setSelected({ vessel: e.payload?.event?.vessel, event: e })}
              />
            ))}</div>
        }
      </div>

      {!hasKey && (
        <div className="modal">
          <form className="modal-card" onSubmit={submitKey}>
            <h2>Paste your VesselAPI key</h2>
            <p>The key stays in this container's memory. It's never written to disk or logged. You'll need a Pro-plan key — advanced notifications are Pro-only.</p>
            <input
              type="password" autoFocus
              value={apiKey}
              placeholder="<apikey>"
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button disabled={submittingKey || !apiKey.trim()}>
              {submittingKey ? 'checking…' : 'Start demo'}
            </button>
            {keyErr && <div className="modal-err">{keyErr}</div>}
          </form>
        </div>
      )}

      {selected && (
        <VesselDetails
          vessel={selected.vessel}
          event={selected.event}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

// Badge is a short pill in the event row's top-left that names the event's
// category. Colour + label encode both the source (Europe/POI) and the event
// family (geofence vs ETA-family). Draught gets its own label because "ETA"
// is the source table — the event itself is cargo activity.
const TYPE_TO_BADGE_LABEL = {
  'eta.draught_changed':     'DRAUGHT',
  'eta.destination_changed': 'DEST',
  'eta.eta_changed':         'ETA SHIFT'
}

function EventRow({ event, label, onOpen }) {
  const e = event.payload?.event || {}
  const v = e.vessel || {}
  const vessel = v.vesselName || (v.imo ? `IMO ${v.imo}` : v.mmsi ? `MMSI ${v.mmsi}` : '(unknown vessel)')
  const ts = event.receivedAt ? new Date(event.receivedAt).toLocaleTimeString() : ''
  const clickable = Boolean(v.imo || v.mmsi)
  const isETA = (e.type || '').startsWith('eta.')
  const isEurope = event.slot === 'europe'

  // Pill colour family matches the map marker palette: amber for ETA-family,
  // purple for Europe, cyan for any POI (all POIs share one family so a
  // single pill rule covers every port — the port name is in the label).
  const badgeClass = isETA ? 'badge-eta'
    : isEurope ? 'badge-europe'
    : 'badge-poi'
  const badgeLabel = isETA
    ? (TYPE_TO_BADGE_LABEL[e.type] || 'ETA')
    : (event.slot || '').toUpperCase()

  const styleClass = isETA ? 'event-eta' : `event-${isEurope ? 'europe' : 'poi'}`

  // Position for display: real lat/lon on geofence events, fall back to the
  // POI name for ETA events (which carry no position payload).
  const pos = e.data?.position
  const where = (typeof pos?.latitude === 'number' && typeof pos?.longitude === 'number')
    ? `${pos.latitude.toFixed(3)}°, ${pos.longitude.toFixed(3)}°`
    : (isETA && event.slot !== 'europe' ? `~ ${event.slot}` : null)
  return (
    <div
      className={`event ${styleClass}${clickable ? ' event-clickable' : ''}`}
      onClick={clickable ? onOpen : undefined}
      title={clickable ? 'view vessel details · zoom map' : ''}
    >
      <div className="event-line1">
        <span className={`event-badge ${badgeClass}`}>{badgeLabel}</span>
        <span className="event-type">{label || e.type || '(event)'}</span>
      </div>
      <div className="event-line2">
        <span className="event-vessel">{vessel}</span>
        <span className="event-time">{ts}</span>
      </div>
      {where && <div className="event-line3"><span className="event-pos">{where}</span></div>}
    </div>
  )
}
