/**
 * Build-time replacement for the `whatwg-url` package (see esbuild alias).
 *
 * node-fetch 2.x only reads `whatwgUrl.URL`, and only as a fallback:
 * `Url.URL || whatwgUrl.URL`. node-fetch runs solely on desktop, where
 * Electron's Node always provides `require('url').URL`, so the ~280KB
 * whatwg-url/tr46 polyfill is never reached. The global URL keeps the
 * fallback meaningful should that assumption ever break.
 */
module.exports = { URL: globalThis.URL }
