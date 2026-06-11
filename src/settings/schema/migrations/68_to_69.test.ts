import { migrateFrom68To69 } from './68_to_69'

describe('migrateFrom68To69', () => {
  it('renames legacy chat mode values to ask', () => {
    const result = migrateFrom68To69({
      version: 68,
      chatOptions: {
        chatMode: 'chat',
      },
      continuationOptions: {
        quickAskMode: 'chat',
      },
    })

    expect(result.version).toBe(69)
    expect(result.chatOptions).toEqual({ chatMode: 'ask' })
    expect(result.continuationOptions).toEqual({ quickAskMode: 'ask' })
  })

  it('migrates request transport mode to per-platform settings', () => {
    const result = migrateFrom68To69({
      version: 68,
      providers: [
        {
          id: 'auto-provider',
          additionalSettings: {
            requestTransportMode: 'auto',
          },
        },
        {
          id: 'node-provider',
          additionalSettings: {
            requestTransportMode: 'node',
          },
        },
        {
          id: 'browser-provider',
          additionalSettings: {
            requestTransportMode: 'browser',
          },
        },
        {
          id: 'obsidian-provider',
          additionalSettings: {
            requestTransportMode: 'obsidian',
          },
        },
      ],
    })

    expect(result.providers).toEqual([
      {
        id: 'auto-provider',
        additionalSettings: {
          requestTransportMode: {
            desktop: 'node',
            mobile: 'browser',
          },
        },
      },
      {
        id: 'node-provider',
        additionalSettings: {
          requestTransportMode: {
            desktop: 'node',
            mobile: 'browser',
          },
        },
      },
      {
        id: 'browser-provider',
        additionalSettings: {
          requestTransportMode: {
            desktop: 'browser',
            mobile: 'browser',
          },
        },
      },
      {
        id: 'obsidian-provider',
        additionalSettings: {
          requestTransportMode: {
            desktop: 'obsidian',
            mobile: 'obsidian',
          },
        },
      },
    ])
  })

  it('migrates legacy useObsidianRequestUrl and removes the old flag', () => {
    const result = migrateFrom68To69({
      version: 68,
      providers: [
        {
          id: 'legacy-provider',
          additionalSettings: {
            useObsidianRequestUrl: true,
          },
        },
      ],
    })

    expect(result.providers).toEqual([
      {
        id: 'legacy-provider',
        additionalSettings: {
          requestTransportMode: {
            desktop: 'obsidian',
            mobile: 'obsidian',
          },
        },
      },
    ])
  })
})
