/**
 * Shim for import.meta.url compatibility in CommonJS environment.
 *
 * Provides module URL resolution for 'pglite' dependency which uses
 * ESM-specific import.meta.url while being bundled as CommonJS.
 */

const import_meta_url =
  typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope
    ? 'https://pglite-worker.local/worker.js'
    : typeof document !== 'undefined'
      ? (document.currentScript && document.currentScript.src) ||
        new URL('main.js', document.baseURI).href
      : require('url').pathToFileURL(__filename).href

var _scriptName = import_meta_url

export { import_meta_url }
