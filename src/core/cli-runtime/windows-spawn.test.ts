import {
  killCliChild,
  quoteWindowsShellArgument,
  resolveCliSpawnSpec,
  resolveWindowsSpawnablePath,
} from './windows-spawn'

describe('resolveCliSpawnSpec', () => {
  it('passes the command and args through on non-Windows platforms', () => {
    expect(
      resolveCliSpawnSpec('/usr/local/bin/pi', ['--mode', 'rpc'], 'darwin'),
    ).toEqual({
      command: '/usr/local/bin/pi',
      args: ['--mode', 'rpc'],
      killProcessTree: false,
      windowsVerbatimArguments: false,
    })
  })

  it('passes a Windows .exe through without wrapping', () => {
    expect(
      resolveCliSpawnSpec('C:\\tools\\pi.exe', ['--mode', 'rpc'], 'win32'),
    ).toEqual({
      command: 'C:\\tools\\pi.exe',
      args: ['--mode', 'rpc'],
      killProcessTree: false,
      windowsVerbatimArguments: false,
    })
  })

  it('wraps a .cmd shim in cmd.exe /d /s /c so spawn does not EINVAL', () => {
    expect(
      resolveCliSpawnSpec(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd',
        ['--mode', 'rpc'],
        'win32',
        'cmd.exe',
      ),
    ).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '"C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd ^"--mode^" ^"rpc^""',
      ],
      killProcessTree: true,
      windowsVerbatimArguments: true,
    })
  })

  it('wraps .bat the same way as .cmd, case-insensitively', () => {
    const spec = resolveCliSpawnSpec(
      'C:\\tools\\hermes.BAT',
      ['-p', 'default', 'acp'],
      'win32',
      'C:\\Windows\\System32\\cmd.exe',
    )
    expect(spec.command).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(spec.killProcessTree).toBe(true)
    expect(spec.args[3]).toBe(
      '"C:\\tools\\hermes.BAT ^"-p^" ^"default^" ^"acp^""',
    )
  })

  it('quotes arguments that would otherwise be interpreted by cmd.exe', () => {
    const spec = resolveCliSpawnSpec(
      'C:\\Program Files\\pi.cmd',
      ['--session', 'a b'],
      'win32',
      'cmd.exe',
    )
    expect(spec.args[3]).toBe(
      `"C:\\Program^ Files\\pi.cmd ^"--session^" ^"a^ b^""`,
    )
  })
})

describe('quoteWindowsShellArgument', () => {
  it('quotes the empty string as a distinct argument', () => {
    expect(quoteWindowsShellArgument('')).toBe('^"^"')
  })

  it('prevents cmd.exe from expanding percent-delimited environment names', () => {
    expect(quoteWindowsShellArgument('C:\\vault\\%TEMP%\\session.json')).toBe(
      '^"C:\\vault\\^%TEMP^%\\session.json^"',
    )
  })

  it('preserves quotes and trailing backslashes through Windows argv parsing', () => {
    expect(quoteWindowsShellArgument('a"b\\')).toBe('^"a\\^"b\\\\^"')
  })
})

describe('killCliChild', () => {
  it('uses taskkill /t when the spawn went through cmd.exe', () => {
    const kill = jest.fn()
    const spawn = jest.fn(() => ({ on: jest.fn() }))
    killCliChild({ pid: 42, kill }, { killProcessTree: true }, spawn, 'win32')
    expect(spawn).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/pid', '42', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    )
    expect(kill).not.toHaveBeenCalled()
  })

  it('falls back to SIGTERM when no process tree was created', () => {
    const kill = jest.fn()
    const spawn = jest.fn()
    killCliChild({ pid: 42, kill }, { killProcessTree: false }, spawn, 'win32')
    expect(spawn).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })
})

describe('resolveWindowsSpawnablePath', () => {
  const exists = async (path: string): Promise<boolean> =>
    new Set([
      'C:\\Users\\me\\AppData\\Roaming\\npm\\pi',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd',
    ]).has(path)

  it('rewrites an extensionless npm shim to the sibling .cmd', async () => {
    await expect(
      resolveWindowsSpawnablePath(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\pi',
        exists,
        'win32',
      ),
    ).resolves.toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd')
  })

  it('keeps a .cmd/.exe path that already exists', async () => {
    await expect(
      resolveWindowsSpawnablePath(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd',
        exists,
        'win32',
      ),
    ).resolves.toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd')
  })

  it('returns the original path on non-Windows platforms', async () => {
    await expect(
      resolveWindowsSpawnablePath(
        '/usr/local/bin/pi',
        async () => true,
        'darwin',
      ),
    ).resolves.toBe('/usr/local/bin/pi')
  })

  it('returns null when nothing exists', async () => {
    await expect(
      resolveWindowsSpawnablePath(
        'C:\\missing\\pi',
        async () => false,
        'win32',
      ),
    ).resolves.toBeNull()
  })
})
