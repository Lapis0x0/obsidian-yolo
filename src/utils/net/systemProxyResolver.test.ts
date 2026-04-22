import { parsePacProxyString } from './systemProxyResolver'

describe('parsePacProxyString', () => {
  it('returns empty string for DIRECT', () => {
    expect(parsePacProxyString('DIRECT')).toBe('')
  })

  it('maps PROXY to http://', () => {
    expect(parsePacProxyString('PROXY 1.2.3.4:8080')).toBe(
      'http://1.2.3.4:8080',
    )
  })

  it('maps HTTPS to https://', () => {
    expect(parsePacProxyString('HTTPS proxy.corp:443')).toBe(
      'https://proxy.corp:443',
    )
  })

  it('maps SOCKS5 to socks5://', () => {
    expect(parsePacProxyString('SOCKS5 s.example.com:1080')).toBe(
      'socks5://s.example.com:1080',
    )
  })

  it('maps SOCKS and SOCKS4 to socks4://', () => {
    expect(parsePacProxyString('SOCKS old:1080')).toBe('socks4://old:1080')
    expect(parsePacProxyString('SOCKS4 old:1080')).toBe('socks4://old:1080')
  })

  it('picks the first non-empty token', () => {
    expect(parsePacProxyString('PROXY a:1; HTTPS b:2; DIRECT')).toBe(
      'http://a:1',
    )
  })

  it('honors DIRECT as the first token (explicit direct intent)', () => {
    expect(parsePacProxyString('DIRECT; PROXY a:1')).toBe('')
  })

  it('is case-insensitive for the scheme keyword', () => {
    expect(parsePacProxyString('proxy 1.2.3.4:8080')).toBe(
      'http://1.2.3.4:8080',
    )
    expect(parsePacProxyString('Socks5 s:1080')).toBe('socks5://s:1080')
  })

  it('handles IPv6 literals in host:port', () => {
    expect(parsePacProxyString('PROXY [::1]:8080')).toBe('http://[::1]:8080')
  })

  it('skips malformed tokens and falls through to the next', () => {
    expect(parsePacProxyString('PROXY foo; HTTPS b:2')).toBe('https://b:2')
  })

  it('returns empty string when no token is valid', () => {
    expect(parsePacProxyString('PROXY foo; garbage')).toBe('')
  })

  it('returns empty string for empty or whitespace input', () => {
    expect(parsePacProxyString('')).toBe('')
    expect(parsePacProxyString('   ')).toBe('')
    expect(parsePacProxyString(';;;')).toBe('')
  })

  it('tolerates extra whitespace around tokens', () => {
    expect(parsePacProxyString('   PROXY 1.2.3.4:8080  ')).toBe(
      'http://1.2.3.4:8080',
    )
  })
})
