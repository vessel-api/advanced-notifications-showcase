import { useEffect, useRef, useState } from 'react'

const MAX_EVENTS = 500

// Single local WS to the Node server. Receives:
// - slot-status updates (per-slot lifecycle state)
// - event envelopes (forwarded from upstream /ws/advanced)
// - registry-update (a new vessel has been seen in Europe)
// - session (api key set/cleared)
export function useFeed() {
  const [localState, setLocalState] = useState('connecting')
  // Slot statuses keyed by slot name (europe + each POI). Keys are added
  // lazily as the server broadcasts slot-status for each.
  const [slots, setSlots] = useState({})
  const [events, setEvents] = useState([])
  const [registrySize, setRegistrySize] = useState(0)
  const idRef = useRef(0)
  const wsRef = useRef(null)

  // Bootstrap registry count from the REST config — catches the case where
  // the server already has a session and seeded vessels before the UI
  // reconnected (e.g. after a hot-reload or a new browser tab). The
  // registry-update WS broadcast then keeps the count live.
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(c => { if (typeof c?.registrySize === 'number') setRegistrySize(c.registrySize) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let closed = false
    let backoff = 500
    // Tracked so cleanup can clearTimeout any pending reconnect. The `closed`
    // flag below already gates the inner connect() call, but holding a handle
    // makes the cancellation explicit for anyone copy-pasting the pattern.
    let reconnectTimer = null

    const connect = () => {
      if (closed) return
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
      const ws = new WebSocket(url)
      wsRef.current = ws
      setLocalState('connecting')

      ws.addEventListener('open', () => {
        backoff = 500
        setLocalState('open')
      })

      ws.addEventListener('message', (e) => {
        let msg
        try { msg = JSON.parse(e.data) } catch { return }
        if (msg.kind === 'slot-status') {
          setSlots((prev) => ({ ...prev, [msg.slot]: { ...(prev[msg.slot] || {}), ...msg } }))
          return
        }
        if (msg.kind === 'registry-update') {
          setRegistrySize(msg.count || 0)
          return
        }
        if (msg.kind === 'event') {
          const withId = { ...msg, _id: ++idRef.current }
          setEvents((prev) => [withId, ...prev].slice(0, MAX_EVENTS))
        }
      })

      ws.addEventListener('close', () => {
        setLocalState('closed')
        if (!closed) {
          reconnectTimer = setTimeout(connect, backoff)
          backoff = Math.min(backoff * 2, 10_000)
        }
      })
      ws.addEventListener('error', () => { try { ws.close() } catch {} })
    }

    connect()
    return () => {
      closed = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      try { wsRef.current?.close() } catch {}
    }
  }, [])

  return {
    localState,
    slots,
    events,
    registrySize,
    clear: () => setEvents([])
  }
}
