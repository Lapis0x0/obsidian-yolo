import { migrateFrom83To84 } from './83_to_84'

describe('migrateFrom83To84', () => {
  it('renames smartSpaceQuickActions to continuationQuickActions', () => {
    const result = migrateFrom83To84({
      version: 83,
      continuationOptions: {
        enableTabCompletion: true,
        smartSpaceQuickActions: [
          { id: 'a1', label: 'Continue', instruction: 'Keep writing' },
        ],
      },
    })

    expect(result.version).toBe(84)
    expect(result.continuationOptions).toEqual({
      enableTabCompletion: true,
      continuationQuickActions: [
        { id: 'a1', label: 'Continue', instruction: 'Keep writing' },
      ],
    })
  })

  it('leaves continuationOptions untouched when smartSpaceQuickActions is absent', () => {
    const result = migrateFrom83To84({
      version: 83,
      continuationOptions: { enableTabCompletion: true },
    })

    expect(result.continuationOptions).toEqual({ enableTabCompletion: true })
  })

  it('is a no-op when continuationOptions is missing', () => {
    const result = migrateFrom83To84({ version: 83 })

    expect(result.version).toBe(84)
    expect(result.continuationOptions).toBeUndefined()
  })
})
