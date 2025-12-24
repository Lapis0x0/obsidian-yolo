import { DEFAULT_TAB_COMPLETION_TRIGGERS } from '../setting.types'

import { migrateFrom19To20 } from './19_to_20'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

describe('migrateFrom19To20', () => {
  it('should add default triggers when missing', () => {
    const result = migrateFrom19To20({
      version: 19,
      continuationOptions: {},
    })

    expect(result.version).toBe(20)
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const triggers = result.continuationOptions.tabCompletionTriggers
    if (!Array.isArray(triggers)) {
      throw new Error('Expected tabCompletionTriggers to be an array')
    }
    expect(triggers).toEqual(
      expect.arrayContaining(DEFAULT_TAB_COMPLETION_TRIGGERS),
    )
  })
})
