jest.mock('obsidian', () => ({
  normalizePath: (path: string) => path,
}))

import { isWithinYoloBaseDir } from './yoloPaths'

describe('isWithinYoloBaseDir', () => {
  it('matches the base dir itself and anything nested inside it, under the default base', () => {
    expect(isWithinYoloBaseDir('YOLO', undefined)).toBe(true)
    expect(isWithinYoloBaseDir('YOLO/data/foo.json', undefined)).toBe(true)
    expect(isWithinYoloBaseDir('Notes/YOLO/foo.md', undefined)).toBe(false)
    expect(isWithinYoloBaseDir('YOLOTypo/foo.md', undefined)).toBe(false)
    expect(isWithinYoloBaseDir('Notes/foo.md', undefined)).toBe(false)
  })

  it('follows a custom base dir set in settings — every consumer (VectorManager index scope, RagAutoUpdateService dirty tracking, ScopeSummary candidate files) must key off the same current settings, not a hardcoded "YOLO"', () => {
    const settings = { yolo: { baseDir: 'MyVault/Custom Root' } }
    expect(isWithinYoloBaseDir('MyVault/Custom Root', settings)).toBe(true)
    expect(
      isWithinYoloBaseDir('MyVault/Custom Root/data/x.json', settings),
    ).toBe(true)
    // The old default no longer matches once the base dir has moved.
    expect(isWithinYoloBaseDir('YOLO/data/x.json', settings)).toBe(false)
    expect(isWithinYoloBaseDir('MyVault/Other/x.md', settings)).toBe(false)
  })
})
