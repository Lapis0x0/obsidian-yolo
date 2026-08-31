/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only Hermes executable discovery boundary */
import { access } from 'node:fs/promises'
/* eslint-enable import/no-nodejs-modules */

import { findHermesExecutable, resolveHermesCommand } from './resolve-command'

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  constants: { X_OK: 1 },
}))

const mockedAccess = jest.mocked(access)

describe('Hermes executable discovery', () => {
  beforeEach(() => mockedAccess.mockRejectedValue(new Error('ENOENT')))

  it('finds hermes on PATH', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/usr/local/bin/hermes') return
      throw new Error('ENOENT')
    })

    await expect(
      findHermesExecutable(
        { PATH: '/usr/local/bin', HOME: '/home/me' },
        'darwin',
      ),
    ).resolves.toBe('/usr/local/bin/hermes')
  })

  it('falls back to the uv/pipx default install dir (~/.local/bin) when PATH misses it', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/home/me/.local/bin/hermes') return
      throw new Error('ENOENT')
    })

    await expect(
      findHermesExecutable({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux'),
    ).resolves.toBe('/home/me/.local/bin/hermes')
  })

  it('probes Windows executable names in the per-user Scripts directory', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === 'C:\\Users\\me\\.local\\bin\\hermes.exe') return
      throw new Error('ENOENT')
    })

    await expect(
      findHermesExecutable({ PATH: '', USERPROFILE: 'C:\\Users\\me' }, 'win32'),
    ).resolves.toBe('C:\\Users\\me\\.local\\bin\\hermes.exe')
  })

  it('returns null when no candidate exists anywhere', async () => {
    await expect(
      findHermesExecutable({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux'),
    ).resolves.toBeNull()
  })
})

describe('resolveHermesCommand', () => {
  beforeEach(() => mockedAccess.mockRejectedValue(new Error('ENOENT')))

  it('prefers a configured cli-path-override that exists on disk', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/opt/custom/hermes') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveHermesCommand(
        { PATH: '/usr/bin', HOME: '/home/me' },
        'linux',
        '/opt/custom/hermes',
        'default',
      ),
    ).resolves.toEqual({
      command: '/opt/custom/hermes',
      args: ['-p', 'default', 'acp'],
    })
  })

  it('falls through to auto-detection when the override does not exist', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/home/me/.local/bin/hermes') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveHermesCommand(
        { PATH: '/usr/bin', HOME: '/home/me' },
        'linux',
        '/does/not/exist/hermes',
        'default',
      ),
    ).resolves.toEqual({
      command: '/home/me/.local/bin/hermes',
      args: ['-p', 'default', 'acp'],
    })
  })

  it('always passes -p explicitly, including for the default profile', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/usr/local/bin/hermes') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveHermesCommand(
        { PATH: '/usr/local/bin', HOME: '/home/me' },
        'darwin',
        undefined,
        'default',
      ),
    ).resolves.toEqual({
      command: '/usr/local/bin/hermes',
      args: ['-p', 'default', 'acp'],
    })
  })

  it('passes a non-default profile id through to -p', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/usr/local/bin/hermes') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveHermesCommand(
        { PATH: '/usr/local/bin', HOME: '/home/me' },
        'darwin',
        undefined,
        'work',
      ),
    ).resolves.toEqual({
      command: '/usr/local/bin/hermes',
      args: ['-p', 'work', 'acp'],
    })
  })

  it('rewrites a Git Bash which-hermes override to the sibling .cmd', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      const path = String(candidate)
      if (
        path === 'C:\\Users\\me\\AppData\\Roaming\\Python\\Scripts\\hermes' ||
        path === 'C:\\Users\\me\\AppData\\Roaming\\Python\\Scripts\\hermes.cmd'
      ) {
        return
      }
      throw new Error('ENOENT')
    })

    await expect(
      resolveHermesCommand(
        { USERPROFILE: 'C:\\Users\\me' },
        'win32',
        'C:\\Users\\me\\AppData\\Roaming\\Python\\Scripts\\hermes',
        'default',
      ),
    ).resolves.toEqual({
      command: 'C:\\Users\\me\\AppData\\Roaming\\Python\\Scripts\\hermes.cmd',
      args: ['-p', 'default', 'acp'],
    })
  })

  it('returns null when Hermes cannot be found at all', async () => {
    await expect(
      resolveHermesCommand(
        { PATH: '/usr/bin', HOME: '/home/me' },
        'linux',
        undefined,
        'default',
      ),
    ).resolves.toBeNull()
  })
})
