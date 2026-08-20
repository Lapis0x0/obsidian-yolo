import {
  DatabaseSaveFailedError,
  PgliteUnsupportedEnvironmentException,
} from '../../database/exception'

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

describe('classifyRagIndexError - DatabaseSaveFailedError', () => {
  it('classifies DatabaseSaveFailedError as permanent', () => {
    // dumpDataDir OOM is the canonical case (#408): we don't want this to
    // enter the transient retry loop, since retrying immediately won't shrink
    // the snapshot. The run should land on `failed` and surface to the user.
    const oom = new RangeError('Array buffer allocation failed')
    const error = new DatabaseSaveFailedError(oom)
    expect(classifyRagIndexError(error)).toBe('permanent')
    expect(isTransientRagIndexError(error)).toBe(false)
  })

  it('preserves the underlying cause', () => {
    const cause = new Error('disk full')
    const error = new DatabaseSaveFailedError(cause)
    expect(error.cause).toBe(cause)
    expect(error.name).toBe('DatabaseSaveFailedError')
    expect(error.message).toContain('disk full')
  })
})

describe('classifyRagIndexError - PgliteUnsupportedEnvironmentException', () => {
  it('classifies PgliteUnsupportedEnvironmentException as permanent', () => {
    // Missing Response/DecompressionStream (#270, #579) won't resolve by
    // retrying; the run should land on `failed` with actionable copy telling
    // the user to update Obsidian, not thrash on auto-retry.
    const error = new PgliteUnsupportedEnvironmentException(
      'Please update Obsidian.',
    )
    expect(classifyRagIndexError(error)).toBe('permanent')
    expect(isTransientRagIndexError(error)).toBe(false)
  })
})
