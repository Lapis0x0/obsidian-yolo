jest.mock('shell-env', () => ({
  shellEnvSync: () => ({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SHELL: '/bin/bash',
  }),
}))

jest.mock('./which', () => ({
  which: jest.fn().mockResolvedValue('/bin/bash'),
}))

import { __test__ } from './shell-provider'

describe('shell-provider', () => {
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
})
