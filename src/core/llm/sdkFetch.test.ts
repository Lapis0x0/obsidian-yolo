import { parseMacOsProxyEnv, resolveDesktopProxyEnv } from './sdkFetch'

describe('sdkFetch proxy helpers', () => {
  it('parses macOS scutil proxy output into proxy env vars', () => {
    const env = parseMacOsProxyEnv(`<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1/8
    1 : localhost
    2 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`)

    expect(env).toMatchObject({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      http_proxy: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      https_proxy: 'http://127.0.0.1:7897',
      ALL_PROXY: 'socks5://127.0.0.1:7897',
      all_proxy: 'socks5://127.0.0.1:7897',
      NO_PROXY: '127.0.0.1/8,localhost,*.local',
      no_proxy: '127.0.0.1/8,localhost,*.local',
    })
  })

  it('does not override an explicit proxy env from the process', () => {
    const env = resolveDesktopProxyEnv({
      HTTPS_PROXY: 'http://custom-proxy:8080',
    } as NodeJS.ProcessEnv)

    expect(env).toEqual({})
  })
})
