/**
 * Returns true when the target URL points at a host that physically cannot
 * be reached through a forward HTTP proxy (loopback, RFC1918 private ranges,
 * link-local, unique local IPv6, `.local`/`.localhost` suffixes).
 *
 * Mirrors the implicit bypass behavior of curl-with-system-proxy, browsers,
 * Node `undici`, and VS Code's networking layer, which `proxy-from-env`
 * alone does not implement.
 */
export function shouldBypassProxy(url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }

  if (!hostname) {
    return false
  }

  // URL#hostname strips the brackets for IPv6 literals, but be defensive.
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true
  }

  if (host.endsWith('.local')) {
    return true
  }

  const ipv4 = parseIpv4(host)
  if (ipv4) {
    return isPrivateIpv4(ipv4)
  }

  if (host.includes(':')) {
    return isPrivateIpv6(host)
  }

  return false
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) {
    return null
  }

  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }
    const value = Number(part)
    if (value < 0 || value > 255) {
      return null
    }
    octets.push(value)
  }

  return octets as [number, number, number, number]
}

function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets

  if (a === 127) return true // loopback
  if (a === 10) return true // 10.0.0.0/8
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local

  return false
}

function isPrivateIpv6(host: string): boolean {
  if (host === '::1') return true

  // Normalize to the first hextet for prefix checks. IPv6 address hextets are
  // separated by ':'; '::' compression may appear, in which case the first
  // hextet is still the leftmost token.
  const firstHextet = host.split(':')[0]
  if (firstHextet === '') {
    // Address starts with '::' (e.g. '::1' already handled, or '::ffff:...').
    return false
  }

  const value = parseInt(firstHextet, 16)
  if (Number.isNaN(value)) {
    return false
  }

  // fc00::/7 — unique local addresses (first 7 bits are 1111110).
  if ((value & 0xfe00) === 0xfc00) return true

  // fe80::/10 — link-local (first 10 bits are 1111111010).
  if ((value & 0xffc0) === 0xfe80) return true

  return false
}
