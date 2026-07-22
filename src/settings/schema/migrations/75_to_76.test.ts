import { migrateFrom75To76 } from './75_to_76'

describe('75_to_76', () => {
  it('adds an empty per-module muted update map', () => {
    expect(migrateFrom75To76({ version: 75, existing: true })).toEqual({
      version: 76,
      existing: true,
      mutedModuleUpdateVersions: {},
    })
  })
})
