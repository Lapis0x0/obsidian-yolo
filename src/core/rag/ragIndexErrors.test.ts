import {
  RagIndexIncompleteError,
  classifyRagIndexError,
  isTransientRagIndexError,
} from './ragIndexErrors'

describe('classifyRagIndexError - RagIndexIncompleteError', () => {
  it('classifies RagIndexIncompleteError as transient', () => {
    const error = new RagIndexIncompleteError(['a.md', 'b.md'])
    expect(classifyRagIndexError(error)).toBe('transient')
    expect(isTransientRagIndexError(error)).toBe(true)
  })

  it('carries the rolled-back paths', () => {
    const error = new RagIndexIncompleteError(['a.md', 'b.md'])
    expect(error.rolledBackPaths).toEqual(['a.md', 'b.md'])
    expect(error.name).toBe('RagIndexIncompleteError')
  })
})
