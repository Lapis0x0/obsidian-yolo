declare module 'node-fetch/lib/index.js' {
  // eslint-disable-next-line no-restricted-imports -- This local type shim matches the desktop-only dynamic import in sdkFetch.ts
  import fetch from 'node-fetch'

  export default fetch
}
