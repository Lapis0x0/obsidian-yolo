/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only Grok executable discovery boundary */
import { access } from 'node:fs/promises'
/* eslint-enable import/no-nodejs-modules */

import { findGrokExecutable, resolveGrokCommand } from './resolve-command'

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  constants: { X_OK: 1 },
}))

const mockedAccess = jest.mocked(access)

describe('Grok executable discovery', () => {
  beforeEach(() => mockedAccess.mockRejectedValue(new Error('ENOENT')))

  it('prefers Grok from PATH', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/custom/bin/grok') return
      throw new Error('ENOENT')
    })

    await expect(
      findGrokExecutable(
        { PATH: '/custom/bin:/usr/bin', HOME: '/home/me' },
        'linux',
      ),
    ).resolves.toBe('/custom/bin/grok')
  })

  it('finds the official per-user install and launches an isolated ACP process in ask-first mode', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/home/me/.grok/bin/grok') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveGrokCommand({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux'),
    ).resolves.toEqual({
      command: '/home/me/.grok/bin/grok',
      args: [
        '--no-auto-update',
        '--permission-mode',
        'default',
        'agent',
        '--no-leader',
        'stdio',
      ],
    })
  })

  it('honors the official GROK_HOME installation override before the default home', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (
        String(candidate) === '/custom/grok-home/bin/grok' ||
        String(candidate) === '/usr/bin/grok'
      )
        return
      throw new Error('ENOENT')
    })

    await expect(
      findGrokExecutable(
        {
          PATH: '/usr/bin',
          HOME: '/home/me',
          GROK_HOME: '/custom/grok-home',
        },
        'linux',
      ),
    ).resolves.toBe('/custom/grok-home/bin/grok')
  })

  it('prefers an existing configured path and expands a Unix home shortcut', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/home/me/bin/grok') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveGrokCommand(
        { PATH: '/usr/bin', HOME: '/home/me' },
        'linux',
        '~/bin/grok',
      ),
    ).resolves.toEqual({
      command: '/home/me/bin/grok',
      args: [
        '--no-auto-update',
        '--permission-mode',
        'default',
        'agent',
        '--no-leader',
        'stdio',
      ],
    })
  })

  it('falls back to auto-detection when a configured path is stale', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/home/me/.grok/bin/grok') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveGrokCommand(
        { PATH: '/usr/bin', HOME: '/home/me' },
        'linux',
        '/stale/grok',
      ),
    ).resolves.toMatchObject({ command: '/home/me/.grok/bin/grok' })
  })

  it('probes the official per-user Windows install using USERPROFILE before a Git-Bash HOME', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === 'C:\\Users\\me\\.grok\\bin\\grok.exe') return
      throw new Error('ENOENT')
    })

    await expect(
      findGrokExecutable(
        {
          PATH: '',
          HOME: '/c/Users/me',
          USERPROFILE: 'C:\\Users\\me',
        },
        'win32',
      ),
    ).resolves.toBe('C:\\Users\\me\\.grok\\bin\\grok.exe')
  })

  it('rewrites a Windows extensionless override to a spawnable wrapper', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      const value = String(candidate)
      if (value === 'C:\\tools\\grok' || value === 'C:\\tools\\grok.cmd') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveGrokCommand(
        { USERPROFILE: 'C:\\Users\\me' },
        'win32',
        'C:\\tools\\grok',
      ),
    ).resolves.toMatchObject({ command: 'C:\\tools\\grok.cmd' })
  })

  it('expands a Windows home-relative override against USERPROFILE', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === 'C:\\Users\\me\\custom\\grok.cmd') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveGrokCommand(
        {
          HOME: '/c/Users/me',
          USERPROFILE: 'C:\\Users\\me',
        },
        'win32',
        '~/custom/grok',
      ),
    ).resolves.toMatchObject({
      command: 'C:\\Users\\me\\custom\\grok.cmd',
    })
  })

  it('returns null when Grok cannot be found', async () => {
    await expect(
      resolveGrokCommand({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux'),
    ).resolves.toBeNull()
  })
})
