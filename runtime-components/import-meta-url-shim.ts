// PGlite's Emscripten bundle captures `import.meta.url` as `_scriptName` and
// resolves fallback assets relative to it. A Blob worker's own `location.href`
// is another blob URL, which PGlite 0.4.4 does not initialize reliably inside
// Obsidian. Preserve the proven pre-component worker shim: the actual data,
// WASM, and extension modules are injected explicitly, so this stable URL is
// only a browser-safe resolution base.
const import_meta_url =
  typeof WorkerGlobalScope !== 'undefined' &&
  globalThis instanceof WorkerGlobalScope
    ? 'https://pglite-worker.local/worker.js'
    : typeof document !== 'undefined'
      ? document.currentScript?.src ||
        new URL('runtime-component.js', document.baseURI).href
      : 'https://pglite-runtime.local/entry.js'

const _scriptName = import_meta_url
void _scriptName

export { import_meta_url }
