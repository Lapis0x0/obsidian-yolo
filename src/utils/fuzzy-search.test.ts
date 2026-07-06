import { MENTION_SEARCHABLE_EXTENSIONS } from './fuzzy-search'

describe('MENTION_SEARCHABLE_EXTENSIONS', () => {
  it('includes conservative text formats for @ file mentions', () => {
    for (const extension of ['canvas', 'base', 'json', 'yaml', 'yml', 'txt']) {
      expect(MENTION_SEARCHABLE_EXTENSIONS.has(extension)).toBe(true)
    }
  })
})
