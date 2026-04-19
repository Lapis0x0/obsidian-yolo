#!/usr/bin/env node
// Interactive one-shot diagnostic for reproducible memory / CPU hotspots
// in the Obsidian renderer. Press Enter to start, trigger your scenario,
// press Enter again to stop. Prints heap delta, memory curve peak,
// and top CPU functions.
//
// Prerequisite: Obsidian launched with --remote-debugging-port=9222.
// Usage:
//   node scripts/obsidian-diagnose.mjs

import readline from 'node:readline/promises'

const HOST = process.env.OBSIDIAN_DEBUG_HOST || 'localhost'
const PORT = Number(process.env.OBSIDIAN_DEBUG_PORT || 9222)

async function pickMainTarget() {
  const res = await fetch(`http://${HOST}:${PORT}/json`)
  const all = await res.json()
  const pages = all.filter(
    (t) => t.type === 'page' && t.url?.startsWith('app://obsidian.md'),
  )
  if (!pages.length) {
    throw new Error(
      'No Obsidian page target. Launch Obsidian with --remote-debugging-port=9222.',
    )
  }
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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

const target = await pickMainTarget()
const { ws, send } = await connect(target.webSocketDebuggerUrl)

await send('Runtime.enable')
await send('Profiler.enable')

// Grab a baseline heap + install a lightweight sampler
const baseline = await send('Runtime.evaluate', {
  expression: `(() => ({
    heap: Math.round(performance.memory.usedJSHeapSize / 1048576),
    dom: document.getElementsByTagName('*').length,
    t: Date.now(),
  }))()`,
  returnByValue: true,
})
const baseHeap = baseline.result.value.heap
const baseDom = baseline.result.value.dom

await send('Runtime.evaluate', {
  expression: `(() => {
    const K = '__smtcmpDiagnose';
    if (window[K]) { clearInterval(window[K].id); }
    const samples = [];
    const id = setInterval(() => {
      try {
        samples.push({
          t: Date.now(),
          heap: Math.round(performance.memory.usedJSHeapSize / 1048576),
          dom: document.getElementsByTagName('*').length,
        });
      } catch {}
    }, 250);
    window[K] = { id, samples };
  })()`,
})

console.log('---')
console.log(`baseline heap = ${baseHeap} MB   dom = ${baseDom} nodes`)
console.log('---')
console.log(
  'Press ENTER to START profiling, then trigger your scenario in Obsidian.',
)
await rl.question('> ')

await send('Profiler.setSamplingInterval', { interval: 1000 })
await send('Profiler.start')
const t0 = Date.now()
console.log(
  `[${new Date().toLocaleTimeString()}] profiling... trigger the bug now.`,
)
console.log('Press ENTER again when finished.')
await rl.question('> ')

const durationMs = Date.now() - t0
const { profile } = await send('Profiler.stop')

const samplesRes = await send('Runtime.evaluate', {
  expression: `(() => {
    const s = window.__smtcmpDiagnose;
    if (!s) return null;
    clearInterval(s.id);
    return s.samples;
  })()`,
  returnByValue: true,
})
const memSamples = samplesRes.result.value || []

const finalHeap = await send('Runtime.evaluate', {
  expression: `Math.round(performance.memory.usedJSHeapSize / 1048576)`,
  returnByValue: true,
})

ws.close()
rl.close()

// ---------- memory curve ----------
const peakSample = memSamples.reduce(
  (a, b) => (b.heap > (a?.heap ?? -1) ? b : a),
  null,
)
const peakHeap = peakSample?.heap ?? baseHeap
const peakDom = peakSample?.dom ?? baseDom
const finalHeapMB = finalHeap.result.value

console.log('\n================== RESULT ==================')
console.log(`profile window : ${Math.round(durationMs / 1000)} s`)
console.log(
  `heap           : baseline ${baseHeap} MB -> peak ${peakHeap} MB -> end ${finalHeapMB} MB  (delta peak ${peakHeap - baseHeap} MB)`,
)
console.log(
  `dom nodes      : baseline ${baseDom} -> peak ${peakDom}  (delta ${peakDom - baseDom})`,
)

// ---------- CPU profile analysis ----------
const nodeById = new Map()
for (const node of profile.nodes) nodeById.set(node.id, node)
const selfByFunc = new Map()
const totalByFunc = new Map()
const parentOf = new Map()
for (const node of profile.nodes) {
  for (const c of node.children || []) parentOf.set(c, node.id)
}
const keyFor = (f) =>
  `${f.functionName || '(anon)'}  ${f.url || '<native>'}:${f.lineNumber}`

for (const s of profile.samples || []) {
  const node = nodeById.get(s)
  if (!node) continue
  const k = keyFor(node.callFrame)
  selfByFunc.set(k, (selfByFunc.get(k) || 0) + 1)
  let cur = s
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const n = nodeById.get(cur)
    if (!n) break
    const tk = keyFor(n.callFrame)
    totalByFunc.set(tk, (totalByFunc.get(tk) || 0) + 1)
    cur = parentOf.get(cur)
  }
}

const ignored = /^(\(idle\)|\(program\)|\(garbage collector\)|\(root\))/
const topSelf = [...selfByFunc.entries()]
  .filter(([k]) => !ignored.test(k))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
const topTotal = [...totalByFunc.entries()]
  .filter(([k]) => !ignored.test(k))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)

const gcMs = [...selfByFunc.entries()].find(([k]) =>
  k.startsWith('(garbage collector)'),
)?.[1] || 0
const idleMs = [...selfByFunc.entries()].find(([k]) => k.startsWith('(idle)'))?.[1] || 0

console.log(
  `\nCPU: idle ${idleMs} ms, GC ${gcMs} ms, active ~${Math.max(
    0,
    durationMs - idleMs,
  )} ms`,
)

console.log('\n## top self-time JS functions (ms)')
if (topSelf.length === 0) {
  console.log('  (none — main thread was idle)')
} else {
  for (const [k, v] of topSelf) console.log(`  ${String(v).padStart(6)} ms  ${k}`)
}

console.log('\n## top total-time JS functions (ms, inclusive)')
if (topTotal.length === 0) {
  console.log('  (none)')
} else {
  for (const [k, v] of topTotal) console.log(`  ${String(v).padStart(6)} ms  ${k}`)
}

if (idleMs > durationMs * 0.9 && peakHeap - baseHeap > 100) {
  console.log('\nNOTE: main thread was >90% idle, but heap grew sharply.')
  console.log(
    '      The allocation likely happens outside the renderer — e.g. a Node-side transport, a worker, or native code.',
  )
}

console.log('============================================\n')
