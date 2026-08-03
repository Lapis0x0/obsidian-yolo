import { access } from 'node:fs/promises'

import {
  findCodexExecutable,
  inferWslDistro,
  parseDefaultWslDistro,
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
})
