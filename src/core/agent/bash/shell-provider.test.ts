jest.mock('shell-env', () => ({
  shellEnvSync: () => ({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SHELL: '/bin/bash',
  }),
}))

jest.mock('./which', () => ({
  which: jest.fn().mockResolvedValue('/bin/bash'),
}))

const getSystemProxyBridgeUrlMock = jest.fn<Promise<string | null>, []>()

jest.mock('./system-proxy-bridge', () => ({
  getSystemProxyBridgeUrl: () => getSystemProxyBridgeUrlMock(),
}))

import { __test__ } from './shell-provider'

describe('shell-provider', () => {
  beforeEach(() => {
    getSystemProxyBridgeUrlMock.mockReset()
  })

  it('wraps POSIX commands with a done marker', () => {
    const provider = __test__.createPosixProvider('/bin/bash', {})
    const wrapped = provider.wrapCommand({
      command: 'pwd',
      token: 'abc123',
      cwd: '/tmp/example path',
    })

    expect(wrapped).toContain("if cd -- '/tmp/example path'; then")
    expect(wrapped).toContain('__YOLO_DONE_abc123_%s__')
    expect(provider.parseDoneMarker('__YOLO_DONE_abc123_0__')).toEqual({
      token: 'abc123',
      exitCode: 0,
    })
  })

  it('wraps PowerShell commands with a done marker', () => {
    const provider = __test__.createPowerShellProvider('pwsh.exe', {})
    const wrapped = provider.wrapCommand({
      command: 'Get-Location',
      token: 'def456',
      cwd: "C:\\Users\\O'Brien",
    })

    expect(wrapped).toContain("Set-Location -LiteralPath 'C:\\Users\\O''Brien'")
    expect(wrapped).toContain('__YOLO_DONE_def456_')
    expect(provider.parseDoneMarker('__YOLO_DONE_def456_1__')).toEqual({
      token: 'def456',
      exitCode: 1,
    })
  })

  it('adds the system proxy bridge to the shell environment', async () => {
    getSystemProxyBridgeUrlMock.mockResolvedValue('http://127.0.0.1:45678')

    const env = await __test__.withSystemProxyEnv({
      PATH: '/usr/bin',
      NO_PROXY: 'localhost',
    })

    expect(env).toEqual({
      PATH: '/usr/bin',
      NO_PROXY: 'localhost',
      HTTP_PROXY: 'http://127.0.0.1:45678',
      http_proxy: 'http://127.0.0.1:45678',
      HTTPS_PROXY: 'http://127.0.0.1:45678',
      https_proxy: 'http://127.0.0.1:45678',
    })
    expect(getSystemProxyBridgeUrlMock).toHaveBeenCalledTimes(1)
  })

  it('does not replace an explicit proxy environment', async () => {
    const originalEnv = {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://user-proxy:8080',
    }

    const env = await __test__.withSystemProxyEnv(originalEnv)

    expect(env).toBe(originalEnv)
    expect(getSystemProxyBridgeUrlMock).not.toHaveBeenCalled()
  })

  it('recognizes lowercase explicit proxy variables on POSIX', async () => {
    const originalEnv = {
      PATH: '/usr/bin',
      https_proxy: 'http://user-proxy:8080',
    }

    const env = await __test__.withSystemProxyEnv(originalEnv)

    expect(env).toBe(originalEnv)
    expect(getSystemProxyBridgeUrlMock).not.toHaveBeenCalled()
  })

  it('recognizes mixed-case explicit proxy variables on Windows', () => {
    expect(
      __test__.envHasExplicitProxy(
        { Https_Proxy: 'http://user-proxy:8080' },
        'win32',
      ),
    ).toBe(true)
    expect(
      __test__.envHasExplicitProxy(
        { Https_Proxy: 'http://user-proxy:8080' },
        'darwin',
      ),
    ).toBe(false)
  })

  it('keeps the original environment when the bridge cannot start', async () => {
    getSystemProxyBridgeUrlMock.mockResolvedValue(null)
    const originalEnv = { PATH: '/usr/bin' }

    const env = await __test__.withSystemProxyEnv(originalEnv)

    expect(env).toBe(originalEnv)
  })
})
