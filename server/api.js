// Thin wrapper around vessel-notifications' advanced-notification REST endpoints.
// Each call takes { base, apiKey } so nothing leaks across sessions.

async function req(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!res.ok) {
    const err = new Error(`${init?.method || 'GET'} ${url} -> ${res.status}: ${text}`)
    err.status = res.status
    err.body = data
    throw err
  }
  return data
}

function auth(apiKey) {
  return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

export async function createAdvanced({ base, apiKey, body }) {
  const data = await req(`${base}/notifications/advanced`, {
    method: 'POST', headers: auth(apiKey), body: JSON.stringify(body)
  })
  return data?.notification ?? data
}

export async function updateAdvanced({ base, apiKey, name, body }) {
  const data = await req(`${base}/notifications/advanced/${encodeURIComponent(name)}`, {
    method: 'PUT', headers: auth(apiKey), body: JSON.stringify(body)
  })
  return data?.notification ?? data
}

export async function getAdvanced({ base, apiKey, name }) {
  try {
    const data = await req(`${base}/notifications/advanced/${encodeURIComponent(name)}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    })
    return data?.notification ?? data
  } catch (e) {
    if (e.status === 404) return null
    throw e
  }
}

export async function deleteAdvanced({ base, apiKey, name }) {
  const res = await fetch(`${base}/notifications/advanced/${encodeURIComponent(name)}`, {
    method: 'DELETE', headers: { 'Authorization': `Bearer ${apiKey}` }
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE advanced/${name} -> ${res.status}: ${await res.text()}`)
  }
}

export async function testAdvanced({ base, apiKey, name }) {
  return await req(`${base}/notifications/advanced/${encodeURIComponent(name)}/test`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}` }
  })
}
