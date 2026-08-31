/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only Hermes profile discovery boundary */
import { readFile, readdir } from 'node:fs/promises'
/* eslint-enable import/no-nodejs-modules */

import {
  HERMES_DEFAULT_PROFILE_ID,
  discoverHermesProfiles,
  resolveHermesRoot,
} from './profiles'

jest.mock('node:fs/promises', () => ({
  readdir: jest.fn(),
  readFile: jest.fn(),
}))

const mockedReaddir = jest.mocked(readdir)
const mockedReadFile = jest.mocked(readFile)

const direntsFor = (names: string[]) =>
  names.map((name) => ({
    name,
    isDirectory: () => true,
  })) as unknown as Awaited<ReturnType<typeof readdir>>

describe('resolveHermesRoot', () => {
  it('uses HERMES_HOME verbatim when set', () => {
    expect(
      resolveHermesRoot({ HERMES_HOME: '/custom/hermes-home' }, 'linux'),
    ).toBe('/custom/hermes-home')
  })

  it('defaults to ~/.hermes on macOS/Linux', () => {
    expect(resolveHermesRoot({ HOME: '/home/me' }, 'linux')).toBe(
      '/home/me/.hermes',
    )
  })

  it('defaults to %LOCALAPPDATA%/hermes on Windows', () => {
    expect(
      resolveHermesRoot(
        { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        'win32',
      ),
    ).toBe('C:\\Users\\me\\AppData\\Local\\hermes')
  })
})

describe('discoverHermesProfiles', () => {
  beforeEach(() => {
    mockedReaddir.mockReset()
    mockedReadFile.mockReset()
    mockedReadFile.mockRejectedValue(new Error('ENOENT'))
  })

  it('always includes the default profile, id-named when profile.yaml is absent', async () => {
    mockedReaddir.mockRejectedValue(new Error('ENOENT'))

    await expect(
      discoverHermesProfiles({ HOME: '/home/me' }, 'linux'),
    ).resolves.toEqual([
      { id: HERMES_DEFAULT_PROFILE_ID, displayName: HERMES_DEFAULT_PROFILE_ID },
    ])
  })

  it("reads the default profile display name from the root profile.yaml's display_name", async () => {
    mockedReaddir.mockRejectedValue(new Error('ENOENT'))
    mockedReadFile.mockImplementation(async (candidate: string) => {
      if (String(candidate) === '/home/me/.hermes/profile.yaml') {
        return 'display_name: \u592a\u4e00\n'
      }
      throw new Error('ENOENT')
    })

    await expect(
      discoverHermesProfiles({ HOME: '/home/me' }, 'linux'),
    ).resolves.toEqual([
      { id: HERMES_DEFAULT_PROFILE_ID, displayName: '\u592a\u4e00' },
    ])
  })

  it("prefers Bot Mode's ui_meta title over display_name, as Hermes itself does", async () => {
    mockedReaddir.mockRejectedValue(new Error('ENOENT'))
    mockedReadFile.mockImplementation(async (candidate: string) => {
      if (String(candidate) === '/home/me/.hermes/profile.yaml') {
        return [
          'display_name: Renamed In Dashboard',
          'ui_meta:',
          '  hermes-bots:',
          '    title: \u592a\u4e00',
        ].join('\n')
      }
      throw new Error('ENOENT')
    })

    await expect(
      discoverHermesProfiles({ HOME: '/home/me' }, 'linux'),
    ).resolves.toEqual([
      { id: HERMES_DEFAULT_PROFILE_ID, displayName: '\u592a\u4e00' },
    ])
  })

  it('lists profiles under profiles/, sorted, falling back to id when profile.yaml names none', async () => {
    mockedReaddir.mockImplementation(async (dir) => {
      if (String(dir) === '/home/me/.hermes/profiles') {
        return direntsFor(['work', 'research'])
      }
      throw new Error('ENOENT')
    })
    mockedReadFile.mockImplementation(async (candidate: string) => {
      if (String(candidate) === '/home/me/.hermes/profiles/work/profile.yaml') {
        return 'display_name: Work Agent\n'
      }
      throw new Error('ENOENT')
    })

    await expect(
      discoverHermesProfiles({ HOME: '/home/me' }, 'linux'),
    ).resolves.toEqual([
      { id: HERMES_DEFAULT_PROFILE_ID, displayName: HERMES_DEFAULT_PROFILE_ID },
      { id: 'research', displayName: 'research' },
      { id: 'work', displayName: 'Work Agent' },
    ])
  })

  it('reads the configured model from config.yaml, unwrapping the map form', async () => {
    mockedReaddir.mockRejectedValue(new Error('ENOENT'))
    mockedReadFile.mockImplementation(async (candidate: string) => {
      if (String(candidate) === '/home/me/.hermes/config.yaml') {
        return 'model:\n  default: xiaomi/mimo-v2.5\n  provider: openrouter\n'
      }
      throw new Error('ENOENT')
    })

    await expect(
      discoverHermesProfiles({ HOME: '/home/me' }, 'linux'),
    ).resolves.toEqual([
      {
        id: HERMES_DEFAULT_PROFILE_ID,
        displayName: HERMES_DEFAULT_PROFILE_ID,
        model: 'xiaomi/mimo-v2.5',
      },
    ])
  })

  it('accepts the bare-string model form Hermes also allows', async () => {
    mockedReaddir.mockRejectedValue(new Error('ENOENT'))
    mockedReadFile.mockImplementation(async (candidate: string) => {
      if (String(candidate) === '/home/me/.hermes/config.yaml') {
        return 'model: gpt-5\n'
      }
      throw new Error('ENOENT')
    })

    const [profile] = await discoverHermesProfiles(
      { HOME: '/home/me' },
      'linux',
    )
    expect(profile.model).toBe('gpt-5')
  })

  it('omits model when config.yaml declares none', async () => {
    mockedReaddir.mockRejectedValue(new Error('ENOENT'))
    mockedReadFile.mockImplementation(async (candidate: string) => {
      if (String(candidate) === '/home/me/.hermes/config.yaml') {
        return 'kanban:\n  review_dispatch: true\n'
      }
      throw new Error('ENOENT')
    })

    await expect(
      discoverHermesProfiles({ HOME: '/home/me' }, 'linux'),
    ).resolves.toEqual([
      { id: HERMES_DEFAULT_PROFILE_ID, displayName: HERMES_DEFAULT_PROFILE_ID },
    ])
  })

  it('ignores non-directory entries under profiles/', async () => {
    mockedReaddir.mockImplementation(async (dir) => {
      if (String(dir) === '/home/me/.hermes/profiles') {
        return [
          { name: 'work', isDirectory: () => true },
          { name: 'notes.txt', isDirectory: () => false },
        ] as unknown as Awaited<ReturnType<typeof readdir>>
      }
      throw new Error('ENOENT')
    })

    const profiles = await discoverHermesProfiles({ HOME: '/home/me' }, 'linux')
    expect(profiles.map((profile) => profile.id)).toEqual([
      HERMES_DEFAULT_PROFILE_ID,
      'work',
    ])
  })

  it('honors HERMES_HOME as the root when resolving profiles/', async () => {
    mockedReaddir.mockImplementation(async (dir) => {
      if (String(dir) === '/opt/hermes-home/profiles')
        return direntsFor(['work'])
      throw new Error('ENOENT')
    })

    const profiles = await discoverHermesProfiles(
      { HERMES_HOME: '/opt/hermes-home', HOME: '/home/me' },
      'linux',
    )
    expect(profiles.map((profile) => profile.id)).toEqual([
      HERMES_DEFAULT_PROFILE_ID,
      'work',
    ])
  })

  it('resolves Windows paths for the profiles directory', async () => {
    mockedReaddir.mockImplementation(async (dir) => {
      if (String(dir) === 'C:\\Users\\me\\AppData\\Local\\hermes\\profiles') {
        return direntsFor(['work'])
      }
      throw new Error('ENOENT')
    })

    const profiles = await discoverHermesProfiles(
      { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      'win32',
    )
    expect(profiles.map((profile) => profile.id)).toEqual([
      HERMES_DEFAULT_PROFILE_ID,
      'work',
    ])
  })

  it('falls back to the id when both display fields are blank', async () => {
    mockedReaddir.mockImplementation(async (dir) => {
      if (String(dir) === '/home/me/.hermes/profiles')
        return direntsFor(['work'])
      throw new Error('ENOENT')
    })
    mockedReadFile.mockImplementation(async (candidate: string) => {
      if (String(candidate) === '/home/me/.hermes/profiles/work/profile.yaml') {
        return [
          'display_name: "   "',
          'ui_meta:',
          '  hermes-bots:',
          '    title: ""',
        ].join('\n')
      }
      throw new Error('ENOENT')
    })

    const profiles = await discoverHermesProfiles({ HOME: '/home/me' }, 'linux')
    expect(profiles.find((profile) => profile.id === 'work')).toEqual({
      id: 'work',
      displayName: 'work',
    })
  })
})
