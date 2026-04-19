#!/usr/bin/env node
// Minimal Chrome DevTools Protocol helper for a locally running Obsidian
// instance. Obsidian must be started with `--remote-debugging-port=9222`.
//
// Usage:
//   node scripts/obsidian-devtools.mjs targets
//   node scripts/obsidian-devtools.mjs install          # inject log capture
//   node scripts/obsidian-devtools.mjs logs [limit]     # dump captured logs
//   node scripts/obsidian-devtools.mjs errors [limit]   # only errors/warnings
//   node scripts/obsidian-devtools.mjs clear            # clear captured logs
//   node scripts/obsidian-devtools.mjs mem              # heap + DOM summary
//   node scripts/obsidian-devtools.mjs eval '<js>'      # run JS in renderer
//
// The capture buffer lives on `window.__smtcmpDevtools` inside Obsidian's
// renderer and is purely in-memory (no file is written). Run `install`
// once per Obsidian session; it is idempotent.

const PORT = Number(process.env.OBSIDIAN_DEBUG_PORT || 9222)
const HOST = process.env.OBSIDIAN_DEBUG_HOST || 'localhost'

async function listTargets() {
  const res = await fetch(`http://${HOST}:${PORT}/json`)
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`)
  const all = await res.json()
  return all.filter(
    (t) => t.type === 'page' && t.url?.startsWith('app://obsidian.md'),
  )
}

async function pickMainTarget() {
  const pages = await listTargets()
  if (pages.length === 0) {
    throw new Error(
      'No Obsidian page target found. Start Obsidian with --remote-debugging-port=9222.',
    )
  }
  return pages[0]
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 0
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++nextId
        pending.set(id, { res, rej })
        ws.send(JSON.stringify({ id, method, params }))
      })
    ws.onopen = () => resolve({ ws, send })
    ws.onerror = (e) => reject(new Error(`WebSocket error: ${e.message ?? e}`))
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

async function runInPage(expression, { awaitPromise = false } = {}) {
  const target = await pickMainTarget()
  const { ws, send } = await connect(target.webSocketDebuggerUrl)
  try {
    await send('Runtime.enable')
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    })
    if (result.exceptionDetails) {
      const ex = result.exceptionDetails
      const text = ex.exception?.description || ex.text || 'unknown'
      throw new Error(`Page exception: ${text}`)
    }
    return result.result?.value
  } finally {
    ws.close()
  }
}

// Code snippet injected into the Obsidian renderer. It installs a capped
// ring buffer that wraps console.{log,info,warn,error,debug} plus global
// error hooks. Safe to call repeatedly.
const INSTALLER_SRC = `
(() => {
  const MAX = 2000;
  const key = '__smtcmpDevtools';
  if (window[key] && window[key].__installed) {
    return { alreadyInstalled: true, bufferSize: window[key].buffer.length };
  }
  const state = {
    __installed: true,
    buffer: [],
    push(entry) {
      this.buffer.push(entry);
      if (this.buffer.length > MAX) this.buffer.splice(0, this.buffer.length - MAX);
    },
    clear() { this.buffer.length = 0; },
  };
  window[key] = state;

  const stringify = (v) => {
    if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 0); } catch { return String(v); }
  };
  const record = (level, args) => {
    try {
      state.push({
        t: Date.now(),
        level,
        msg: Array.from(args).map(stringify).join(' '),
      });
    } catch {}
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = function (...args) {
      record(level, args);
      return orig(...args);
    };
  }
  window.addEventListener('error', (ev) => {
    record('error', [ev.message + ' @ ' + (ev.filename || '?') + ':' + (ev.lineno || 0), ev.error?.stack || '']);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    record('error', ['[unhandledrejection] ' + (r?.stack || r?.message || r)]);
  });
  return { alreadyInstalled: false, bufferSize: 0 };
})()
`

const cmd = process.argv[2]

try {
  switch (cmd) {
    case 'targets': {
      const targets = await listTargets()
      for (const t of targets) {
        console.log(`${t.id}  ${t.title}`)
      }
      break
    }
    case 'install': {
      const r = await runInPage(INSTALLER_SRC)
      console.log(JSON.stringify(r))
      break
    }
    case 'logs':
    case 'errors': {
      const limit = Number(process.argv[3] || 200)
      const onlyErr = cmd === 'errors'
      const expr = `(() => {
        const s = window.__smtcmpDevtools;
        if (!s) return { installed: false };
        const all = s.buffer;
        const filtered = ${onlyErr} ? all.filter(e => e.level === 'error' || e.level === 'warn') : all;
        const tail = filtered.slice(-${limit});
        return { installed: true, total: all.length, shown: tail.length, entries: tail };
      })()`
      const r = await runInPage(expr)
      if (!r?.installed) {
        console.error(
          "Log buffer not installed. Run 'install' first (ideally right after Obsidian launch).",
        )
        process.exit(2)
      }
      console.log(
        `# total=${r.total}  shown=${r.shown}${onlyErr ? '  (errors/warnings only)' : ''}`,
      )
      for (const e of r.entries) {
        const ts = new Date(e.t).toISOString().slice(11, 23)
        console.log(`${ts} [${e.level}] ${e.msg}`)
      }
      break
    }
    case 'clear': {
      const r = await runInPage(
        `(() => { const s = window.__smtcmpDevtools; if (!s) return { installed: false }; const n = s.buffer.length; s.clear(); return { installed: true, cleared: n }; })()`,
      )
      console.log(JSON.stringify(r))
      break
    }
    case 'mem': {
      const r = await runInPage(`(() => {
        const m = performance.memory || {};
        return {
          heapUsedMB: m.usedJSHeapSize ? Math.round(m.usedJSHeapSize / 1048576) : null,
          heapTotalMB: m.totalJSHeapSize ? Math.round(m.totalJSHeapSize / 1048576) : null,
          heapLimitMB: m.jsHeapSizeLimit ? Math.round(m.jsHeapSizeLimit / 1048576) : null,
          domNodes: document.getElementsByTagName('*').length,
          detachedQuery: 'open DevTools → Memory → Heap Snapshot, then filter by "Detached"',
          logBufferSize: window.__smtcmpDevtools?.buffer?.length ?? null,
        };
      })()`)
      console.log(JSON.stringify(r, null, 2))
      break
    }
    case 'eval': {
      const expr = process.argv.slice(3).join(' ')
      if (!expr) {
        console.error('Usage: eval <javascript expression>')
        process.exit(2)
      }
      // If the input looks like a bare expression (no statement separators
      // and no leading statement keyword) we auto-wrap it with `return`.
      // Otherwise we treat it as a function body — the caller is responsible
      // for `return`ing a value if they want one.
      const looksLikeStatements =
        /;|\n/.test(expr) ||
        /^\s*(?:const|let|var|if|for|while|do|switch|return|throw|try|function|async|class)\b/.test(
          expr,
        ) ||
        /^\s*\{/.test(expr)
      const body = looksLikeStatements ? expr : `return (${expr});`
      const wrapped = `(async () => {
        const v = await (async () => { ${body} })();
        return v === undefined ? '<undefined>' : v;
      })()`
      const r = await runInPage(wrapped, { awaitPromise: true })
      console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2))
      break
    }
    default: {
      console.log(
        'Usage: node scripts/obsidian-devtools.mjs <targets|install|logs [n]|errors [n]|clear|mem|eval <js>>',
      )
      process.exit(cmd ? 2 : 0)
    }
  }
} catch (err) {
  console.error('[obsidian-devtools] ' + (err?.message || err))
  process.exit(1)
}
