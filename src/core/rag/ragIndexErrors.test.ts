import { DatabaseSaveFailedError } from '../../database/exception'

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
