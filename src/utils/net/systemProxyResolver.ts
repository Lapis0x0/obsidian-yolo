import { loadDesktopNodeModule } from '../platform/desktopNodeModule'

/**
 * Resolves the system proxy for a URL by delegating to Chromium via
 * Electron's `session.resolveProxy`, which natively handles Windows
 * registry / macOS SystemConfiguration / Linux env, plus PAC/WPAD.
 *
 * Mirrors what Obsidian's `requestUrl` and `globalThis.fetch` already do,
 * so Node-mode requests end up using the same proxy as the rest of the app.
 *
 * Any failure silently degrades to DIRECT (empty string) — safer than
 * throwing inside a request hot path.
 */

type ElectronRemote = {
  getCurrentWebContents: () => {
    session: {
      resolveProxy: (url: string) => Promise<string>
    }
  }
}

let cachedRemote: ElectronRemote | null | undefined

const loadElectronRemote = async (): Promise<ElectronRemote | null> => {
  if (cachedRemote !== undefined) {
    return cachedRemote
  }

  try {
    cachedRemote =
      await loadDesktopNodeModule<ElectronRemote>('@electron/remote')
  } catch {
    cachedRemote = null
  }

  return cachedRemote
}

// PAC token grammar (case-insensitive):
//   DIRECT
//   PROXY  host:port  → http://host:port
//   HTTPS  host:port  → https://host:port
//   SOCKS  host:port  → socks4://host:port  (legacy alias)
//   SOCKS4 host:port  → socks4://host:port
//   SOCKS5 host:port  → socks5://host:port
// Multiple tokens are separated by `;`; Chromium lists them in preference
// order. We only use the first token because `proxy-agent` does not chain
// fallbacks and DIRECT as the primary choice must win.
const PAC_TOKEN_REGEX =
  /^(DIRECT|PROXY|HTTPS|SOCKS5|SOCKS4|SOCKS)(?:\s+(\S+))?$/i

// host:port validation; accepts IPv6 literals like `[::1]:8080` because the
// `\S+:\d+` shape still matches (the colon before `:8080` is the separator).
const HOST_PORT_REGEX = /^\S+:\d+$/

export function parsePacProxyString(pac: string): string {
  if (!pac || !pac.trim()) {
    return ''
  }

  for (const rawToken of pac.split(';')) {
    const token = rawToken.trim()
    if (!token) continue

    const match = PAC_TOKEN_REGEX.exec(token)
    if (!match) continue

    const scheme = match[1].toUpperCase()
    const endpoint = match[2]

    if (scheme === 'DIRECT') {
      return ''
    }

    if (!endpoint || !HOST_PORT_REGEX.test(endpoint)) {
      continue
    }

    switch (scheme) {
      case 'PROXY':
        return `http://${endpoint}`
      case 'HTTPS':
        return `https://${endpoint}`
      case 'SOCKS':
      case 'SOCKS4':
        return `socks4://${endpoint}`
      case 'SOCKS5':
        return `socks5://${endpoint}`
    }
  }

  return ''
}

export async function resolveSystemProxy(url: string): Promise<string> {
  try {
    const remote = await loadElectronRemote()
    if (!remote) return ''

    const pac = await remote.getCurrentWebContents().session.resolveProxy(url)
    return parsePacProxyString(pac)
  } catch {
    return ''
  }
}
