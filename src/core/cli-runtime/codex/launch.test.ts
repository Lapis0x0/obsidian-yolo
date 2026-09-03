/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only Codex executable discovery boundary */
import { access } from 'node:fs/promises'
/* eslint-enable import/no-nodejs-modules */

import {
  findCodexExecutable,
  inferWslDistro,
  isWindowsStylePath,
  parseDefaultWslDistro,
  resolveCodexLaunch,
  windowsPathToWsl,
  wslPathToWindows,
} from './launch'

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  constants: { X_OK: 1 },
}))

const mockedAccess = jest.mocked(access)

describe('Codex launch discovery', () => {
  beforeEach(() => mockedAccess.mockRejectedValue(new Error('ENOENT')))

  it('prefers a Windows executable before npm command shims', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === 'C:\\tools\\codex.exe') return
      if (String(candidate) === 'C:\\tools\\codex.cmd') return
      throw new Error('ENOENT')
    })

    await expect(
      findCodexExecutable(
        { PATH: 'C:\\tools', USERPROFILE: 'C:\\Users\\me' },
        'win32',
      ),
    ).resolves.toBe('C:\\tools\\codex.exe')
  })

  it('finds the npm codex.cmd shim from APPDATA without relying on PATH', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (
        String(candidate) === 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'
      ) {
        return
      }
      throw new Error('ENOENT')
    })

    await expect(
      findCodexExecutable(
        {
          APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
          USERPROFILE: 'C:\\Users\\me',
        },
        'win32',
      ),
    ).resolves.toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd')
  })

  it('infers a WSL distribution from a WSL UNC vault path', () => {
    expect(inferWslDistro('\\\\wsl$\\Ubuntu\\home\\me\\vault')).toBe('Ubuntu')
    expect(inferWslDistro('C:\\vault')).toBeNull()
  })

  it('parses the default distro from UTF-16LE wsl.exe output', () => {
    const output = Buffer.from(
      '\uFEFF  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n',
      'utf16le',
    )
    expect(parseDefaultWslDistro(output)).toBe('Ubuntu')
  })

  it('maps drive and WSL UNC paths across the runtime boundary', () => {
    expect(windowsPathToWsl('C:\\vault\\notes', 'Ubuntu')).toBe(
      '/mnt/c/vault/notes',
    )
    expect(
      windowsPathToWsl('\\\\wsl$\\Ubuntu\\home\\me\\vault', 'Ubuntu'),
    ).toBe('/home/me/vault')
    expect(wslPathToWindows('/home/me/.codex/session.jsonl', 'Ubuntu')).toBe(
      '\\\\wsl$\\Ubuntu\\home\\me\\.codex\\session.jsonl',
    )
  })

  it('searches the bundled Codex.app binary on macOS', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (
        String(candidate) === '/Applications/Codex.app/Contents/Resources/codex'
      ) {
        return
      }
      throw new Error('ENOENT')
    })

    await expect(
      findCodexExecutable({ HOME: '/Users/me' }, 'darwin'),
    ).resolves.toBe('/Applications/Codex.app/Contents/Resources/codex')
  })

  it('prefers an existing configured path with home expansion', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/Users/me/.nvm/current/bin/codex') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveCodexLaunch(
        '/vault',
        { HOME: '/Users/me' },
        'darwin',
        '~/.nvm/current/bin/codex',
      ),
    ).resolves.toMatchObject({ command: '/Users/me/.nvm/current/bin/codex' })
  })

  it('falls back to auto-detection when the configured path is missing', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/opt/homebrew/bin/codex') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveCodexLaunch(
        '/vault',
        { HOME: '/Users/me' },
        'darwin',
        '/Users/me/gone/codex',
      ),
    ).resolves.toMatchObject({ command: '/opt/homebrew/bin/codex' })
  })

  it('uses a configured non-Windows-style command inside WSL', async () => {
    await expect(
      resolveCodexLaunch(
        '\\\\wsl$\\Ubuntu\\home\\me\\vault',
        { USERPROFILE: 'C:\\Users\\me' },
        'win32',
        '/home/me/.local/bin/codex',
      ),
    ).resolves.toMatchObject({
      command: 'wsl.exe',
      launchArgs: [
        '--distribution',
        'Ubuntu',
        '--cd',
        '/home/me/vault',
        '/home/me/.local/bin/codex',
      ],
    })
  })

  it('rewrites a Git Bash which-codex override to the sibling .cmd', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      const path = String(candidate)
      if (
        path === 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex' ||
        path === 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'
      ) {
        return
      }
      throw new Error('ENOENT')
    })

    await expect(
      resolveCodexLaunch(
        'C:\\vault',
        { USERPROFILE: 'C:\\Users\\me' },
        'win32',
        'C:\\Users\\me\\AppData\\Roaming\\npm\\codex',
      ),
    ).resolves.toMatchObject({
      command: 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
    })
  })

  it('classifies Windows-style CLI references', () => {
    expect(isWindowsStylePath('C:\\tools\\codex.exe')).toBe(true)
    expect(isWindowsStylePath('codex.cmd')).toBe(true)
    expect(isWindowsStylePath('\\\\server\\share\\codex')).toBe(true)
    expect(isWindowsStylePath('/home/me/.local/bin/codex')).toBe(false)
  })
})
