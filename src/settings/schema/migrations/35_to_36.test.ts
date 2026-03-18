import { migrateFrom35To36 } from './35_to_36'

describe('migrateFrom35To36', () => {
  it('maps legacy useObsidianRequestUrl to requestTransportMode', () => {
    const result = migrateFrom35To36({
      version: 35,
      providers: [
        {
          type: 'anthropic',
          id: 'anthropic',
          additionalSettings: {
            useObsidianRequestUrl: true,
          },
        },
        {
          type: 'openai-compatible',
          id: 'openai-compatible',
          additionalSettings: {
            useObsidianRequestUrl: false,
            noStainless: true,
          },
        },
      ],
    })

    expect(result.version).toBe(36)
    expect(result.providers).toEqual([
      {
        type: 'anthropic',
        id: 'anthropic',
        additionalSettings: {
          useObsidianRequestUrl: true,
          requestTransportMode: 'obsidian',
        },
      },
      {
        type: 'openai-compatible',
        id: 'openai-compatible',
        additionalSettings: {
          useObsidianRequestUrl: false,
          noStainless: true,
          requestTransportMode: 'browser',
        },
      },
    ])
  })

  it('keeps providers that already define requestTransportMode', () => {
    const result = migrateFrom35To36({
      version: 35,
      providers: [
        {
          type: 'anthropic',
          id: 'anthropic',
          additionalSettings: {
            requestTransportMode: 'auto',
            useObsidianRequestUrl: true,
          },
        },
      ],
    })

    expect(result.providers).toEqual([
      {
        type: 'anthropic',
        id: 'anthropic',
        additionalSettings: {
          requestTransportMode: 'auto',
          useObsidianRequestUrl: true,
        },
      },
    ])
  })
})
