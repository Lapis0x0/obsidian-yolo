import { migrateFrom63To64 } from './63_to_64'

describe('migrateFrom63To64', () => {
  it('removes history archive options from chatOptions', () => {
    const result = migrateFrom63To64({
      version: 63,
      chatOptions: {
        includeCurrentFileContent: true,
        historyArchiveEnabled: false,
        historyArchiveThreshold: 120,
      },
    })

    expect(result.version).toBe(64)
    expect(result.chatOptions).toEqual({
      includeCurrentFileContent: true,
    })
    expect(
      (result.chatOptions as Record<string, unknown>).historyArchiveEnabled,
    ).toBeUndefined()
    expect(
      (result.chatOptions as Record<string, unknown>).historyArchiveThreshold,
    ).toBeUndefined()
  })

  it('leaves settings unchanged when chatOptions is missing', () => {
    const result = migrateFrom63To64({
      version: 63,
      chatModelId: 'gpt-4',
    })

    expect(result.version).toBe(64)
    expect(result.chatOptions).toBeUndefined()
  })
})
