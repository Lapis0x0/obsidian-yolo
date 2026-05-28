import { migrateFrom62To63 } from './62_to_63'

describe('migrateFrom62To63', () => {
  it('removes persistSelectionHighlight from continuationOptions', () => {
    const result = migrateFrom62To63({
      version: 62,
      continuationOptions: {
        enableSmartSpace: true,
        persistSelectionHighlight: false,
      },
    })

    expect(result.version).toBe(63)
    expect(result.continuationOptions).toEqual({
      enableSmartSpace: true,
    })
    expect(
      (result.continuationOptions as Record<string, unknown>)
        .persistSelectionHighlight,
    ).toBeUndefined()
  })

  it('leaves settings unchanged when continuationOptions is missing', () => {
    const result = migrateFrom62To63({
      version: 62,
      chatModelId: 'gpt-4',
    })

    expect(result.version).toBe(63)
    expect(result.continuationOptions).toBeUndefined()
  })
})
