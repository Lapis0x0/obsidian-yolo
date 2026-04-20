import { shouldBypassProxy } from './proxyBypass'

describe('shouldBypassProxy', () => {
  it.each([
    'http://localhost/mcp',
    'http://localhost:3005/mcp',
    'http://foo.localhost/',
    'http://my-printer.local/',
    'http://127.0.0.1:8080',
    'http://127.42.10.5/',
    'http://10.0.0.1/',
    'http://10.255.255.255/',
    'http://192.168.1.21:3005/mcp',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
  ])('bypasses %s', (url) => {
    expect(shouldBypassProxy(url)).toBe(true)
  })

  it.each([
    'http://example.com/',
    'https://api.openai.com/v1',
    'http://8.8.8.8/',
    'http://172.15.0.1/', // just outside 172.16/12
    'http://172.32.0.1/', // just outside 172.16/12
    'http://169.253.0.1/', // outside link-local /16
    'http://[2001:db8::1]/',
    'http://[fe00::1]/', // outside fc00::/7 and fe80::/10
    'http://11.0.0.1/',
  ])('does not bypass %s', (url) => {
    expect(shouldBypassProxy(url)).toBe(false)
  })

  it('returns false for invalid URL inputs', () => {
    expect(shouldBypassProxy('not a url')).toBe(false)
    expect(shouldBypassProxy('')).toBe(false)
  })
})
