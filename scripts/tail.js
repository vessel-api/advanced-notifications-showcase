#!/usr/bin/env node
// Tail the local hub WebSocket for debugging; prints every event as a compact line.
import { WebSocket } from 'ws'

const url = process.env.URL || 'ws://localhost:3001/ws'
const ws = new WebSocket(url)

ws.on('open', () => console.log(`[tail] connected ${url}`))
ws.on('close', (c, r) => { console.log(`[tail] closed code=${c} reason=${r}`); process.exit(0) })
ws.on('error', (e) => console.error(`[tail] error`, e.message))

ws.on('message', (buf) => {
  let m; try { m = JSON.parse(buf.toString('utf8')) } catch { return }
  if (m.kind === 'hello') {
    console.log(`[tail] hello serverTime=${m.serverTime} upstreamState=${m.lastStatus?.websocket}`)
    return
  }
  if (m.kind === 'status') {
    console.log(`[tail] status channel=${m.channel} state=${m.state}${m.code ? ` code=${m.code}` : ''}`)
    return
  }
  if (m.kind === 'event') {
    const e = m.payload?.event || {}
    const v = e.vessel?.vesselName || e.vessel?.imo || ''
    const vStr = v ? ` vessel="${v}"` : ''
    const hdr = m.headers?.eventType ? ` header_type=${m.headers.eventType}` : ''
    console.log(`[tail] ${m.source.padEnd(9)} ${e.type || '(no-type)'}${vStr}${hdr} at=${m.receivedAt}`)
  }
})
