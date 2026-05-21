import { useEffect, useState } from 'react'

// Modal shown when the user clicks an event row.
//
// THE PUNCHLINE OF THIS DEMO: the notification event payload is self-contained
// for everything customers used to need a follow-up REST call for — identity
// (IMO/MMSI/ENI), classification (type/subtype), flag (country/code),
// dimensions (length/breadth), and on position-derived events the current
// heading/speed/lat/lon + last AIS update; ETA events also carry the
// destination. The first two sections of this modal render entirely from the
// event with ZERO network calls, and a visible "From WebSocket event" banner
// makes that obvious to the customer pasting their API key.
//
// The deeper static record (call sign, draft, tonnage, owner/manager/builder,
// year built, home port) is the *only* thing not on the event. We surface it
// behind a "Show full vessel record" button — gated rather than eager, so the
// instant-from-event story isn't muddied by a spinner the customer sees first.

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

// Dimensions: length + breadth are on every EventVessel; draft is only on the
// full vessels.get record. Rule of thumb is "event wins, full record fills
// gaps" — used for both the event-only render and the merged render once the
// full record has loaded.
function formatDimensions(eventVessel, fullRecord) {
  const v = eventVessel || {}
  const d = fullRecord || {}
  const parts = [
    (v.length || d.length) && `${v.length || d.length} ${d.length_unit || 'm'}`,
    (v.breadth || d.breadth) && `${v.breadth || d.breadth} ${d.breadth_unit || 'm'}`,
    d.draft && `${d.draft} ${d.draft_unit || 'm'}`
  ].filter(Boolean)
  return parts.join(' × ') || null
}

export default function VesselDetails({ vessel, event, onClose }) {
  const delta = extractDelta(event)
  // The deep static record from /api/vessel (proxy of vessels.get) is opt-in:
  // the customer has to click "Show full vessel record" to fetch it. Until
  // then the modal stays 100% event-driven — that's the headline message of
  // this feature, and we want it visible without a spinner muddying it.
  const [extra, setExtra] = useState({ loading: false, data: null, error: null, fetched: false })

  // Reset the "fetched" flag whenever a new vessel is opened, so the button
  // reappears on a fresh row rather than us showing stale data.
  useEffect(() => {
    setExtra({ loading: false, data: null, error: null, fetched: false })
  }, [vessel?.imo, vessel?.mmsi])

  const fetchFullRecord = () => {
    if (!vessel) return
    const id = vessel.imo || vessel.mmsi
    const type = vessel.imo ? 'imo' : 'mmsi'
    if (!id) { setExtra({ loading: false, data: null, error: 'no identifier', fetched: true }); return }
    setExtra({ loading: true, data: null, error: null, fetched: true })
    fetch(`/api/vessel/${encodeURIComponent(id)}?type=${type}`)
      .then(r => r.json().then(b => ({ ok: r.ok, body: b })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body?.error || 'lookup failed')
        setExtra({ loading: false, data: body, error: null, fetched: true })
      })
      .catch(e => setExtra({ loading: false, data: null, error: e.message, fetched: true }))
  }

  if (!vessel) return null

  // The event payload carries the everyday identity + kinematic state.
  const ev = event?.payload?.event || {}
  const pos = ev.data?.position || {}
  const eta = ev.data?.vesselEta || {}
  // Deeper static info comes from the SDK proxy — only present after the
  // customer opts in via the button below.
  const d = extra.data?.vessel || {}

  const dim = formatDimensions(vessel, d)

  const navStatus = (typeof pos.nav_status === 'number')
    ? (NAV_STATUS[pos.nav_status] || `code ${pos.nav_status}`)
    : null

  // Destination resolution:
  //  - `vessel.destination` ships on EventVessel for ETA events (omitempty
  //    strips it on position/port events that have no destination context).
  //  - `eta.destination` (free-text port name) + `eta.destination_port`
  //    (UN/LOCODE — the canonical code) come along on any event whose payload
  //    happens to include an attached vesselEta row, which some non-ETA flows
  //    do carry. Kept as a fallback for those cases.
  const destination = vessel.destination
    || (eta.destination_port ? `${eta.destination || eta.destination_port} (${eta.destination_port})` : eta.destination)
    || null

  const coords = (typeof pos.latitude === 'number' && typeof pos.longitude === 'number')
    ? `${pos.latitude.toFixed(4)}°${pos.latitude >= 0 ? 'N' : 'S'}, ${pos.longitude.toFixed(4)}°${pos.longitude >= 0 ? 'E' : 'W'}`
    : null

  // Heading / speed / last-AIS-update are on the event's vessel block. Fall
  // back to event.data.position fields just in case (older events or replays).
  const speed = (typeof vessel.speed === 'number') ? vessel.speed
              : (typeof pos.sog === 'number') ? pos.sog : null
  const heading = (typeof vessel.heading === 'number') ? vessel.heading
              : (typeof pos.cog === 'number') ? pos.cog : null
  const lastAIS = vessel.lastAISUpdate || pos.timestamp || null

  // Country line: prefer the rich pair from the event (name + ISO), fall
  // back to whatever vessels.get returned (which would be the same in
  // steady state, but during a sub-second race the event arrives first).
  const country = vessel.country || d.country
  const countryCode = vessel.countryCode || d.country_code
  const typeLabel = vessel.vesselSubtype || vessel.vesselType || d.vessel_type
  const subType = vessel.vesselSubtype && vessel.vesselType && vessel.vesselSubtype !== vessel.vesselType
    ? vessel.vesselType
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
            <div className="details-name">{vessel.vesselName || d.name || 'vessel'}</div>
            <div className="details-sub">
              {typeLabel || ''}
              {subType ? ` · ${subType}` : ''}
              {country ? ` · ${country}${countryCode ? ` (${countryCode})` : ''}` : ''}
            </div>
          </div>
          <button className="details-close" onClick={onClose} aria-label="close">×</button>
        </div>

        {/* Section 1: identity straight off the event — no REST call. */}
        <SourceBanner tone="event">
          From WebSocket event · instant · no REST call
        </SourceBanner>
        <dl className="details-grid">
          <Row k="IMO"        v={fmt(vessel.imo)} />
          <Row k="MMSI"       v={fmt(vessel.mmsi)} />
          <Row k="ENI"        v={vessel.eni} />
          <Row k="AIS name"   v={vessel.nameAIS && vessel.nameAIS !== (vessel.vesselName || '') ? vessel.nameAIS : null} />
          <Row k="Type"       v={vessel.vesselType || d.vessel_type} />
          <Row k="Subtype"    v={vessel.vesselSubtype} />
          <Row k="Dimensions" v={dim} />
        </dl>

        {/* Section 2: kinematics + voyage state — also from the event. */}
        {(coords || navStatus || speed != null || heading != null || destination || lastAIS) && (
          <>
            <div className="details-section">Current voyage</div>
            <dl className="details-grid">
              <Row k="Position"    v={coords} />
              <Row k="Status"      v={navStatus} />
              <Row k="Speed"       v={speed != null ? `${Number(speed).toFixed(1)} kn` : null} />
              <Row k="Heading"     v={heading != null ? `${Number(heading).toFixed(0)}°` : null} />
              <Row k="Destination" v={destination} />
              <Row k="ETA"         v={fmtTime(eta.eta)} />
              <Row k="Draught"     v={typeof eta.draught === 'number' ? `${eta.draught.toFixed(1)} m` : null} />
              <Row k="Last ping"   v={fmtTime(lastAIS)} />
            </dl>
          </>
        )}

        {/* Section 2.5: long-term observations our backend derives from AIS
            history — carried in the event, no REST call. Rendered only when at
            least one value is present (moored / sparse vessels may have none). */}
        {(vessel.speedCalculatedAvg || vessel.speedObservedMax
          || vessel.draughtCalculatedAvg || vessel.draughtObservedMax
          || vessel.teu || vessel.summerDraught) && (
          <>
            <div className="details-section">Observed history · last 31 days</div>
            <SourceBanner tone="event">
              Derived from our AIS history · in the event · no REST call
            </SourceBanner>
            <dl className="details-grid">
              <Row k="Avg speed"    v={vessel.speedCalculatedAvg ? `${Number(vessel.speedCalculatedAvg).toFixed(1)} kn` : null} />
              <Row k="Max speed"    v={vessel.speedObservedMax ? `${Number(vessel.speedObservedMax).toFixed(1)} kn` : null} />
              <Row k="Avg draught"  v={vessel.draughtCalculatedAvg ? `${Number(vessel.draughtCalculatedAvg).toFixed(1)} m` : null} />
              <Row k="Max draught"  v={vessel.draughtObservedMax ? `${Number(vessel.draughtObservedMax).toFixed(1)} m` : null} />
              <Row k="TEU"          v={vessel.teu ? fmt(vessel.teu) : null} />
              <Row k="Summer draught" v={vessel.summerDraught ? `${Number(vessel.summerDraught).toFixed(1)} m` : null} />
            </dl>
          </>
        )}

        {/* Section 3: deeper static fields. Opt-in fetch so the
            event-is-self-contained punchline above isn't muddied. */}
        <div className="details-section">Vessel record</div>
        <SourceBanner tone="rest">
          From <code>vessels.get</code> · lazy · one REST call
        </SourceBanner>
        {!extra.fetched && (
          <button className="details-fetch" onClick={fetchFullRecord}>
            Show full vessel record
          </button>
        )}
        {extra.loading && <div className="details-loading">loading vessel record…</div>}
        {extra.error && <div className="modal-err">{extra.error}</div>}
        {extra.data && (
          <dl className="details-grid">
            <Row k="Call sign"     v={d.call_sign} />
            <Row k="Gross tonnage" v={fmt(d.gross_tonnage)} />
            <Row k="Deadweight"    v={fmt(d.deadweight_tonnage)} />
            <Row k="Owner"         v={d.owner_name} />
            <Row k="Manager"       v={d.manager_name} />
            <Row k="Builder"       v={d.builder} />
            <Row k="Year built"    v={fmt(d.year_built)} />
            <Row k="Home port"     v={d.home_port} />
          </dl>
        )}
      </div>
    </div>
  )
}

// SourceBanner labels which fields below it come from where. The whole point
// of the redesign: the customer should see "From WebSocket event" at a glance
// and connect it with the instant-rendered rows underneath.
function SourceBanner({ tone, children }) {
  return <div className={`details-source details-source-${tone}`}>{children}</div>
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
  if (type === 'eta.destination_changed' && ev.data?.destinationChange) {
    const { previous, current } = ev.data.destinationChange
    return {
      tone: 'eta',
      label: `${portName} · destination change`,
      previous: previous || '—',
      current: current || '—'
    }
  }
  if (type === 'eta.eta_changed' && ev.data?.etaChange) {
    const { shiftMinutes } = ev.data.etaChange
    return {
      tone: 'eta',
      label: `${portName} · ETA shift`,
      current: shiftMinutes != null ? `${shiftMinutes} min` : ''
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
