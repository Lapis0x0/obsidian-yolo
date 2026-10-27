import {
  WHITEBOARD_SETTINGS_CONTRIBUTION,
  contributeWhiteboardSettings,
  resolveNewBoardFolder,
} from './settings'

describe('Whiteboard settings contribution', () => {
  it('declares the new-board folder as a text field', () => {
    const contribute = jest.fn()

    contributeWhiteboardSettings({
      contribute,
    } as unknown as YoloModuleHostApiV1['settings'])

    expect(contribute).toHaveBeenCalledWith(WHITEBOARD_SETTINGS_CONTRIBUTION)
    expect(WHITEBOARD_SETTINGS_CONTRIBUTION).toEqual(
      expect.objectContaining({
        id: 'whiteboard',
        icon: 'waypoints',
        fields: [
          {
            key: 'newBoardFolder',
            type: 'text',
            name: expect.any(String),
            description: expect.any(String),
          },
        ],
        localizations: {
          en: expect.any(Object),
          zh: expect.any(Object),
          it: expect.any(Object),
        },
      }),
    )
  })
})

describe('resolveNewBoardFolder', () => {
  function createHarness(data: unknown) {
    let snapshot = { schemaVersion: 1, data }
    const host = {
      config: {
        getSnapshot: jest.fn(() => snapshot),
      },
    } as unknown as YoloModuleHostApiV1
    return { host, replace: (next: typeof snapshot) => (snapshot = next) }
  }

  it('reads the configured folder', () => {
    const { host } = createHarness({ newBoardFolder: 'Whiteboards' })
    expect(resolveNewBoardFolder(host)).toBe('Whiteboards')
  })

  it('falls back to the vault root when the setting is absent', () => {
    const { host } = createHarness({})
    expect(resolveNewBoardFolder(host)).toBe('')
  })

  it('falls back to the vault root when the config is empty or malformed', () => {
    for (const data of [undefined, null, 'Whiteboards', []]) {
      const { host } = createHarness(data)
      expect(resolveNewBoardFolder(host)).toBe('')
    }
  })

  it('falls back to the vault root for non-string values', () => {
    const { host } = createHarness({ newBoardFolder: 42 })
    expect(resolveNewBoardFolder(host)).toBe('')
  })

  it('normalizes the folder to a vault-relative path', () => {
    const { host } = createHarness({ newBoardFolder: ' /Whiteboards/ ' })
    expect(resolveNewBoardFolder(host)).toBe('Whiteboards')
  })

  it('treats a blank value as the vault root', () => {
    const { host } = createHarness({ newBoardFolder: '   ' })
    expect(resolveNewBoardFolder(host)).toBe('')
  })

  it('reads the current snapshot, not a cached one', () => {
    const { host, replace } = createHarness({})
    expect(resolveNewBoardFolder(host)).toBe('')
    replace({ schemaVersion: 1, data: { newBoardFolder: 'Boards' } })
    expect(resolveNewBoardFolder(host)).toBe('Boards')
  })
})
