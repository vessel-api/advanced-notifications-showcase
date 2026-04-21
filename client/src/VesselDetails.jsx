import { useEffect, useState } from 'react'

// Modal shown when the user clicks an event row. Pulls the full vessel
// picture from the server (/api/vessel/:id merges identity + live position +
// current voyage) and renders a single card with the interesting fields.

// AIS navigational status codes, per ITU-R M.1371 — meaningful replacement
// for the generic "operating_status: Active" string.
const NAV_STATUS = {
  0: 'Under way (engine)',
  1: 'At anchor',
  2: 'Not under command',
  3: 'Restricted manoeuvrability',
  4: 'Constrained by draught',
  5: 'Moored',
  6: 'Aground',
  7: 'Fishing',
  8: 'Under way (sail)',
  15: 'Undefined'
}

export default function VesselDetails({ vessel, event, onClose }) {
  const delta = extractDelta(event)
  const [state, setState] = useState({ loading: true, data: null, error: null })

  useEffect(() => {
    if (!vessel) return
    setState({ loading: true, data: null, error: null })
    const id = vessel.imo || vessel.mmsi
    const type = vessel.imo ? 'imo' : 'mmsi'
    if (!id) { setState({ loading: false, data: null, error: 'no identifier' }); return }
    fetch(`/api/vessel/${encodeURIComponent(id)}?type=${type}`)
      .then(r => r.json().then(b => ({ ok: r.ok, body: b })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body?.error || 'lookup failed')
        setState({ loading: false, data: body, error: null })
      })
      .catch(e => setState({ loading: false, data: null, error: e.message }))
  }, [vessel?.imo, vessel?.mmsi])

  if (!vessel) return null

  const d = state.data?.vessel || {}
  const p = state.data?.position || {}
  const eta = state.data?.eta || {}

  const dim = [
    d.length && `${d.length} ${d.length_unit || 'm'}`,
    d.breadth && `${d.breadth} ${d.breadth_unit || 'm'}`,
    d.draft && `${d.draft} ${d.draft_unit || 'm'}`
  ].filter(Boolean).join(' × ')

  const navStatus = (typeof p.nav_status === 'number')
    ? (NAV_STATUS[p.nav_status] || `code ${p.nav_status}`)
    : null

  const destination = eta.destination_port
    ? `${eta.destination} (${eta.destination_port})`
    : eta.destination || null

  const coords = (typeof p.latitude === 'number' && typeof p.longitude === 'number')
    ? `${p.latitude.toFixed(4)}°${p.latitude >= 0 ? 'N' : 'S'}, ${p.longitude.toFixed(4)}°${p.longitude >= 0 ? 'E' : 'W'}`
    : null

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card details-card" onClick={(e) => e.stopPropagation()}>
        {delta && (
          <div className={`details-delta delta-${delta.tone}`}>
            <div className="delta-label">{delta.label}</div>
            <div className="delta-value">
              {delta.previous !== undefined && (
                <><span className="delta-prev">{delta.previous}</span><span className="delta-arrow">→</span></>
              )}
              <span className="delta-curr">{delta.current}</span>
            </div>
          </div>
        )}
        <div className="details-head">
          <div>
            <div className="details-name">{d.name || vessel.vesselName || 'vessel'}</div>
            <div className="details-sub">
              {d.vessel_type || ''}{d.country ? ` • ${d.country}` : ''}
            </div>
          </div>
          <button className="details-close" onClick={onClose} aria-label="close">×</button>
        </div>

        {state.loading && <div className="details-loading">loading…</div>}
        {state.error && <div className="modal-err">{state.error}</div>}

        {state.data && (
          <>
            <dl className="details-grid">
              <Row k="IMO"         v={fmt(d.imo) || fmt(vessel.imo)} />
              <Row k="MMSI"        v={fmt(d.mmsi) || fmt(vessel.mmsi)} />
              <Row k="ENI"         v={d.eni} />
              <Row k="Call sign"   v={d.call_sign} />
              <Row k="Dimensions"  v={dim} />
              <Row k="Gross tonnage" v={fmt(d.gross_tonnage)} />
              <Row k="Deadweight"  v={fmt(d.deadweight_tonnage)} />
              <Row k="Owner"       v={d.owner_name} />
              <Row k="Manager"     v={d.manager_name} />
              <Row k="Builder"     v={d.builder} />
              <Row k="Year built"  v={fmt(d.year_built)} />
              <Row k="Home port"   v={d.home_port} />
            </dl>

            {(coords || navStatus || typeof p.sog === 'number' || typeof p.cog === 'number') && (
              <>
                <div className="details-section">Current voyage</div>
                <dl className="details-grid">
                  <Row k="Position"    v={coords} />
                  <Row k="Status"      v={navStatus} />
                  <Row k="Speed"       v={typeof p.sog === 'number' ? `${p.sog.toFixed(1)} kn` : null} />
                  <Row k="Course"      v={typeof p.cog === 'number' ? `${p.cog.toFixed(0)}°` : null} />
                  <Row k="Heading"     v={typeof p.heading === 'number' ? `${p.heading}°` : null} />
                  <Row k="Destination" v={destination} />
                  <Row k="ETA"         v={fmtTime(eta.eta)} />
                  <Row k="Draught"     v={typeof eta.draught === 'number' ? `${eta.draught.toFixed(1)} m` : null} />
                  <Row k="Last ping"   v={fmtTime(p.timestamp)} />
                </dl>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Row({ k, v }) {
  if (v === undefined || v === null || v === '') return null
  return (
    <div className="details-row">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}

function fmt(v) {
  if (v === undefined || v === null || v === '') return null
  return String(v)
}

function fmtTime(s) {
  if (!s) return null
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleString()
}

// extractDelta produces the top-of-card banner describing WHY this vessel
// was shown — which event fired, and for delta-carrying events (draught)
// what the previous and current values were. `tone` picks the banner
// colour family (enter/exit/eta/europe) to match the map marker palette.
function extractDelta(event) {
  if (!event) return null
  const ev = event.payload?.event || {}
  const type = ev.type || ''
  const slot = event.slot
  const portName = event.slot && event.slot !== 'europe'
    ? event.slot.charAt(0).toUpperCase() + event.slot.slice(1)
    : 'Europe'

  if (type === 'eta.draught_changed' && ev.data?.draughtChange) {
    const { previous, current } = ev.data.draughtChange
    return {
      tone: 'eta',
      label: `${portName} · draught change`,
      previous: `${Number(previous).toFixed(1)} m`,
      current: `${Number(current).toFixed(1)} m`
    }
  }
  if (type === 'position.geofence_enter') {
    return {
      tone: slot === 'europe' ? 'europe' : 'enter',
      label: `${portName} · entered zone`,
      current: 'inside'
    }
  }
  if (type === 'position.geofence_exit') {
    return {
      tone: 'exit',
      label: `${portName} · exited zone`,
      current: 'outside'
    }
  }
  return {
    tone: 'eta',
    label: `${portName} · ${type || 'event'}`,
    current: ''
  }
}
