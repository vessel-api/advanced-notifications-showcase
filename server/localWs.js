import { WebSocketServer } from 'ws'

export function createLocalWsHub(httpServer, { path = '/ws' } = {}) {
  const wss = new WebSocketServer({ server: httpServer, path })
  const clients = new Set()
  let lastStatus = { websocket: 'unknown' }

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
    ws.send(JSON.stringify({ kind: 'hello', serverTime: new Date().toISOString(), lastStatus }))
  })

  function broadcast(msg) {
    if (msg.kind === 'status' && msg.channel) {
      lastStatus = { ...lastStatus, [msg.channel]: msg.state }
    }
    const frame = JSON.stringify(msg)
    for (const c of clients) {
      if (c.readyState === 1) {
        try { c.send(frame) } catch {}
      }
    }
  }

  return { broadcast, clients }
}
