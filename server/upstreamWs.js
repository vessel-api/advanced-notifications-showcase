import { WebSocket } from 'ws'

// Connects to /ws/advanced?name=<name> on the vessel-notifications API.
// Upstream refuses the upgrade until the notification's prefill status is
// "ready", so the caller should only open this after polling prefill.
// Auto-reconnects with exponential backoff. onEvent receives the parsed
// EventEnvelope; onStatus receives state strings ('connecting'|'open'|'closed').
export function connectAdvancedUpstream({ wsBase, apiKey, name, onEvent, onStatus }) {
  const wsUrl = `${wsBase.replace(/\/$/, '')}/ws/advanced?name=${encodeURIComponent(name)}`
  let ws = null
  let backoff = 1000
  let stopped = false

  function connect() {
    if (stopped) return
    onStatus?.('connecting')
    // handshakeTimeout guards against the "TCP open, HTTP upgrade never
    // completes" case seen during a rolling deploy: a drain-in-progress
    // instance accepts the socket and never responds, so neither 'open' nor
    // 'close' fires and the client stays stuck in 'connecting' forever. The
    // ws library turns the timeout into an error + close, which re-enters
    // the existing backoff reconnect path automatically.
    ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      handshakeTimeout: 10_000
    })

    ws.on('open', () => {
      backoff = 1000
      console.log(`[upstream-ws ${name}] open`)
      onStatus?.('open')
    })
    ws.on('unexpected-response', (_req, res) => {
      let buf = ''
      res.on('data', (d) => { buf += d.toString('utf8') })
      res.on('end', () => {
        console.error(`[upstream-ws ${name}] upgrade refused: ${res.statusCode} body=${buf.slice(0, 300)}`)
      })
    })
    ws.on('message', (buf, isBinary) => {
      if (isBinary) return
      let payload
      try { payload = JSON.parse(buf.toString('utf8')) } catch { return }
      onEvent?.(payload)
    })
    ws.on('close', (code, reason) => {
      onStatus?.('closed', { code, reason: reason?.toString?.() ?? '' })
      if (!stopped) {
        setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    })
    ws.on('error', (err) => {
      console.error(`[upstream-ws ${name}] error:`, err.message)
    })
  }

  connect()

  return {
    close() {
      stopped = true
      try { ws?.close(1000, 'shutdown') } catch {}
    }
  }
}
