#!/usr/bin/env node
// CDP Profiler.start / stop wrapper for the Obsidian renderer.
// Usage: node scripts/obsidian-cpu-sample.mjs <seconds>

const HOST = process.env.OBSIDIAN_DEBUG_HOST || 'localhost'
const PORT = Number(process.env.OBSIDIAN_DEBUG_PORT || 9222)

const seconds = Number(process.argv[2] || 60)
if (!Number.isFinite(seconds) || seconds < 3) {
  console.error('Usage: node obsidian-cpu-sample.mjs <seconds>')
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

await send('Profiler.enable')
await send('Profiler.setSamplingInterval', { interval: 1000 }) // 1ms
await send('Profiler.start')
console.error(
  `[${new Date().toLocaleTimeString()}] CPU profiling started. Window = ${seconds}s. Trigger the hot path now.`,
)
await new Promise((r) => setTimeout(r, seconds * 1000))
console.error(`[${new Date().toLocaleTimeString()}] stopping...`)
const { profile } = await send('Profiler.stop')
ws.close()

// profile: { nodes: [{ id, callFrame, hitCount, children }], startTime, endTime, samples, timeDeltas }
// Compute inclusive (total) and exclusive (self) sample counts per node.
const nodeById = new Map()
for (const node of profile.nodes) nodeById.set(node.id, node)

const selfHits = new Map() // nodeId -> samples that landed exactly here
for (const s of profile.samples || []) {
  selfHits.set(s, (selfHits.get(s) || 0) + 1)
}

// Aggregate by function identity (name + url + line)
const selfByFunc = new Map()
for (const [nodeId, hits] of selfHits) {
  const node = nodeById.get(nodeId)
  if (!node) continue
  const f = node.callFrame
  const key = `${f.functionName || '(anon)'}@${f.url || '<native>'}:${f.lineNumber}`
  selfByFunc.set(key, (selfByFunc.get(key) || 0) + hits)
}

// Inclusive time: walk up the tree for each node
const parentOf = new Map()
for (const node of profile.nodes) {
  for (const child of node.children || []) parentOf.set(child, node.id)
}
const totalByFunc = new Map()
for (const [nodeId, hits] of selfHits) {
  let cur = nodeId
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const node = nodeById.get(cur)
    if (!node) break
    const f = node.callFrame
    const key = `${f.functionName || '(anon)'}@${f.url || '<native>'}:${f.lineNumber}`
    totalByFunc.set(key, (totalByFunc.get(key) || 0) + hits)
    cur = parentOf.get(cur)
  }
}

const totalMs = Math.round((profile.endTime - profile.startTime) / 1000)
console.log(
  `# profile window = ${totalMs} ms, total samples = ${profile.samples?.length || 0}`,
)

const renderHitsToMs = (hits) => Math.round(hits) // samples are ms-spaced

console.log('\n## top self-time functions (ms)')
const selfRows = [...selfByFunc.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25)
for (const [key, hits] of selfRows) {
  console.log(`${String(renderHitsToMs(hits)).padStart(7)} ms  ${key}`)
}

console.log('\n## top total-time functions (ms, inclusive)')
const totalRows = [...totalByFunc.entries()]
  .filter(
    ([k]) =>
      !k.startsWith('(idle)') &&
      !k.startsWith('(program)') &&
      !k.startsWith('(garbage collector)') &&
      !k.startsWith('(root)'),
  )
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25)
for (const [key, hits] of totalRows) {
  console.log(`${String(renderHitsToMs(hits)).padStart(7)} ms  ${key}`)
}

// Specifically call out GC and native
console.log('\n## meta')
const metaKeys = ['(idle)', '(program)', '(garbage collector)']
for (const k of metaKeys) {
  const hits = [...selfByFunc.entries()].find(([x]) => x.startsWith(k))?.[1] || 0
  console.log(`${String(renderHitsToMs(hits)).padStart(7)} ms  ${k}`)
}
