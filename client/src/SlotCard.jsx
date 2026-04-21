import { useState } from 'react'

// A single blueprint card: editable body JSON, activate/deactivate, test.
// Status comes from the feed (slot-status broadcasts).
export default function SlotCard({ slot, title, tone, blueprint, status, disabled, disabledReason, onActivate, onDeactivate, onTest }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(() => JSON.stringify(blueprint, null, 2))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const active = Boolean(status?.prefillStatus)
  const state = status?.state || 'idle'
  const prefill = status?.prefillStatus
  const vcount = status?.vesselCount ?? (status?.active ? status?.vesselCount : null)

  const handle = async (fn) => {
    setBusy(true)
    setErr(null)
    try { await fn() } catch (e) { setErr(e.message || String(e)) }
    finally { setBusy(false) }
  }

  const activate = () => handle(async () => {
    let body
    try { body = JSON.parse(text) } catch (e) { throw new Error(`JSON: ${e.message}`) }
    await onActivate(body)
  })

  return (
    <div className={`card card-${tone}`}>
      <div className="card-head">
        <span className={`card-dot dot-${tone}`} />
        <div className="card-title">{title}</div>
        <StatePill state={state} prefill={prefill} />
      </div>
      <div className="card-meta">
        <span>mode: <b>{blueprint.mode}</b></span>
        {vcount !== null && vcount !== undefined && (
          <span>vessels: <b>{vcount}</b></span>
        )}
      </div>
      <div className="card-actions">
        {!active ? (
          <button disabled={disabled || busy} onClick={activate} title={disabledReason || ''}>
            {busy ? 'activating…' : 'Activate'}
          </button>
        ) : (
          <>
            <button
              disabled={disabled || busy || state !== 'open'}
              onClick={() => handle(onTest)}
              className="secondary"
            >
              Test event
            </button>
            <button disabled={disabled || busy} onClick={() => handle(onDeactivate)} className="danger">
              Deactivate
            </button>
          </>
        )}
        <button onClick={() => setOpen(o => !o)} className="ghost">
          {open ? 'hide config' : 'edit config'}
        </button>
      </div>
      {!active && disabledReason && <div className="card-hint">{disabledReason}</div>}
      {err && <div className="card-err">{err}</div>}
      {open && (
        <textarea
          className="card-body"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          disabled={active || busy}
          rows={14}
        />
      )}
    </div>
  )
}

function StatePill({ state, prefill }) {
  let cls = 'pill-wait', text = state
  if (state === 'open') { cls = 'pill-ok'; text = 'streaming' }
  else if (state === 'idle') { cls = 'pill-muted'; text = 'idle' }
  else if (state === 'error') { cls = 'pill-err'; text = 'error' }
  else if (state === 'waiting-prefill') { cls = 'pill-wait'; text = `prefill: ${prefill || '...'}` }
  else if (state === 'connecting' || state === 'creating') { cls = 'pill-wait' }
  return <span className={`pill ${cls}`}>{text}</span>
}
