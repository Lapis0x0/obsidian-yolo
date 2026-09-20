/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only CodeBuddy executable discovery boundary */
import { access } from 'node:fs/promises'
/* eslint-enable import/no-nodejs-modules */

import {
  findCodebuddyExecutable,
  resolveCodebuddyCommand,
} from './resolve-command'

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  constants: { X_OK: 1 },
}))

const mockedAccess = jest.mocked(access)

const only = (...paths: string[]) => {
  const allowed = new Set(paths)
  mockedAccess.mockImplementation(async (candidate) => {
    if (allowed.has(String(candidate))) return
    throw new Error('ENOENT')
  })
}

describe('CodeBuddy executable discovery', () => {
  beforeEach(() => mockedAccess.mockRejectedValue(new Error('ENOENT')))

  it('prefers CodeBuddy from PATH', async () => {
    only('/custom/bin/codebuddy')

    await expect(
      findCodebuddyExecutable(
        { PATH: '/custom/bin:/usr/bin', HOME: '/home/me' },
        'linux',
      ),
    ).resolves.toBe('/custom/bin/codebuddy')
  })

  it('falls back to the npm global prefix a stale shell PATH misses', async () => {
    only('/home/me/.npm-global/bin/codebuddy')

    await expect(
      findCodebuddyExecutable({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux'),
    ).resolves.toBe('/home/me/.npm-global/bin/codebuddy')
  })

  it('accepts the codebuddy-code bin when the short name is absent', async () => {
    only('/usr/local/bin/codebuddy-code')

    await expect(
      findCodebuddyExecutable({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux'),
    ).resolves.toBe('/usr/local/bin/codebuddy-code')
  })

  /**
   * `cbc` is the package's third bin for the same entry point. It is left
   * out of the probe on purpose — a three-letter name on PATH collides too
   * easily — so an install exposing only `cbc` must go through the override.
   */
  it('ignores the short cbc alias during auto-detection', async () => {
    only('/usr/bin/cbc')

    await expect(
      findCodebuddyExecutable({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux'),
    ).resolves.toBeNull()
  })

  it('prefers the Windows .cmd shim npm installs over the extensionless one', async () => {
    only('C:\\tools\\codebuddy.cmd', 'C:\\tools\\codebuddy')

    await expect(
      findCodebuddyExecutable(
        { Path: 'C:\\tools', USERPROFILE: 'C:\\Users\\me' },
        'win32',
      ),
    ).resolves.toBe('C:\\tools\\codebuddy.cmd')
  })

  it('returns null when CodeBuddy is nowhere on the device', async () => {
    await expect(
      resolveCodebuddyCommand({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux'),
    ).resolves.toBeNull()
  })
})

describe('resolveCodebuddyCommand', () => {
  beforeEach(() => mockedAccess.mockRejectedValue(new Error('ENOENT')))

  it('starts the ACP server pinned to the ask-first permission mode', async () => {
    only('/usr/local/bin/codebuddy')

    await expect(
      resolveCodebuddyCommand({ PATH: '/usr/local/bin' }, 'linux'),
    ).resolves.toEqual({
      command: '/usr/local/bin/codebuddy',
      args: ['--acp', '--permission-mode', 'default'],
    })
  })

  it('lets the Settings path override win over auto-detection', async () => {
    only('/opt/custom/codebuddy', '/usr/local/bin/codebuddy')

    await expect(
      resolveCodebuddyCommand(
        { PATH: '/usr/local/bin' },
        'linux',
        '/opt/custom/codebuddy',
      ),
    ).resolves.toEqual({
      command: '/opt/custom/codebuddy',
      args: ['--acp', '--permission-mode', 'default'],
    })
  })

  it('expands a ~ in the override against the environment home', async () => {
    only('/home/me/bin/codebuddy')

    await expect(
      resolveCodebuddyCommand(
        { PATH: '/usr/bin', HOME: '/home/me' },
        'linux',
        '~/bin/codebuddy',
      ),
    ).resolves.toEqual({
      command: '/home/me/bin/codebuddy',
      args: ['--acp', '--permission-mode', 'default'],
    })
  })

  /**
   * A path synced from another device points at nothing here; falling back
   * to auto-detection keeps that conversation working instead of failing on
   * a setting the user cannot see from this machine.
   */
  it('falls through to auto-detection when the override does not exist', async () => {
    only('/usr/local/bin/codebuddy')

    await expect(
      resolveCodebuddyCommand(
        { PATH: '/usr/local/bin' },
        'linux',
        '/gone/codebuddy',
      ),
    ).resolves.toEqual({
      command: '/usr/local/bin/codebuddy',
      args: ['--acp', '--permission-mode', 'default'],
    })
  })
})
