/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only pi executable discovery boundary */
import { access } from 'node:fs/promises'
/* eslint-enable import/no-nodejs-modules */

import { findPiExecutable, resolvePiCommand } from './resolve-command'

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  constants: { X_OK: 1 },
}))

const mockedAccess = jest.mocked(access)

describe('pi executable discovery', () => {
  beforeEach(() => mockedAccess.mockRejectedValue(new Error('ENOENT')))

  it('prefers the npm pi.cmd shim on Windows', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (
        String(candidate) === 'C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd'
      ) {
        return
      }
      throw new Error('ENOENT')
    })

    await expect(
      findPiExecutable(
        {
          APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
          USERPROFILE: 'C:\\Users\\me',
        },
        'win32',
      ),
    ).resolves.toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd')
  })
})

describe('resolvePiCommand', () => {
  beforeEach(() => mockedAccess.mockRejectedValue(new Error('ENOENT')))

  it('rewrites a Git Bash which-pi override to the sibling .cmd', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      const path = String(candidate)
      if (
        path === 'C:\\Users\\me\\AppData\\Roaming\\npm\\pi' ||
        path === 'C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd'
      ) {
        return
      }
      throw new Error('ENOENT')
    })

    await expect(
      resolvePiCommand(
        { USERPROFILE: 'C:\\Users\\me' },
        'win32',
        'C:\\Users\\me\\AppData\\Roaming\\npm\\pi',
      ),
    ).resolves.toEqual({
      command: 'C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd',
    })
  })
})
