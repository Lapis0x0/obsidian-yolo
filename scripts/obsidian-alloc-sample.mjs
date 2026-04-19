#!/usr/bin/env node
// One-shot CDP allocation sampling. Keeps one WebSocket open for the entire
// sampling window — stopping on a separate connection loses profiler state.
//
// Usage:
//   node scripts/obsidian-alloc-sample.mjs <seconds>
//   (trigger the target hot path during the window, then wait for output)

const HOST = process.env.OBSIDIAN_DEBUG_HOST || 'localhost'
const PORT = Number(process.env.OBSIDIAN_DEBUG_PORT || 9222)

const seconds = Number(process.argv[2] || 90)
if (!Number.isFinite(seconds) || seconds < 5) {
  console.error('Usage: node obsidian-alloc-sample.mjs <seconds>  (min 5)')
  process.exit(2)
}

async function pickMainTarget() {
  const res = await fetch(`http://${HOST}:${PORT}/json`)
  const all = await res.json()
  const pages = all.filter(
    (t) => t.type === 'page' && t.url?.startsWith('app://obsidian.md'),
  )
  if (!pages.length) throw new Error('No Obsidian page target.')
  return pages[0]
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map()
    let id = 0
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const mid = ++id
        pending.set(mid, { res, rej })
        ws.send(JSON.stringify({ id: mid, method, params }))
      })
    ws.onopen = () => resolve({ ws, send })
    ws.onerror = (e) => reject(e)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
      }
    }
  })
}

const target = await pickMainTarget()
const { ws, send } = await connect(target.webSocketDebuggerUrl)

await send('HeapProfiler.enable')
await send('HeapProfiler.startSampling', { samplingInterval: 32768 })
console.error(`[${new Date().toLocaleTimeString()}] sampling started. Window = ${seconds}s. Trigger the hot path now.`)

await new Promise((r) => setTimeout(r, seconds * 1000))

console.error(`[${new Date().toLocaleTimeString()}] stopping...`)
const { profile } = await send('HeapProfiler.stopSampling')
ws.close()

const byFunc = new Map()
const byUrl = new Map()
const walk = (node) => {
  const fn = node.callFrame.functionName || '(anon)'
  const url = node.callFrame.url || '<native>'
  const line = node.callFrame.lineNumber
  const key = `${fn}@${url}:${line}`
  const prev = byFunc.get(key) ?? { selfKB: 0, hits: 0 }
  prev.selfKB += Math.round((node.selfSize || 0) / 1024)
  prev.hits += 1
  byFunc.set(key, prev)

  const urlKey = url || '<native>'
  const u = byUrl.get(urlKey) ?? 0
  byUrl.set(urlKey, u + (node.selfSize || 0))

  for (const child of node.children || []) walk(child)
}
walk(profile.head)

const totalMB = Math.round(
  (profile.samples?.reduce((s, x) => s + (x.size || 0), 0) || 0) / 1048576,
)
console.log(
  `# total sampled allocation: ${totalMB} MB across ${profile.samples?.length ?? 0} samples`,
)

console.log('\n## top self-allocation sites (>= 512 KB, by function)')
const rows = [...byFunc.entries()]
  .filter(([, v]) => v.selfKB >= 512)
  .sort((a, b) => b[1].selfKB - a[1].selfKB)
  .slice(0, 30)
for (const [key, v] of rows) {
  console.log(`${String(v.selfKB).padStart(8)} KB  ${key}`)
}

console.log('\n## top scripts by total self-allocation')
const urlRows = [...byUrl.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .map(([u, b]) => [u, Math.round(b / 1024 / 1024)])
for (const [url, mb] of urlRows) {
  if (mb < 1) continue
  console.log(`${String(mb).padStart(6)} MB  ${url}`)
}
