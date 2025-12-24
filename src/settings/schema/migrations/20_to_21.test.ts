import { DEFAULT_TAB_COMPLETION_TRIGGERS } from '../setting.types'

import { migrateFrom20To21 } from './20_to_21'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

describe('migrateFrom20To21', () => {
  it('should strip scope from triggers', () => {
    const result = migrateFrom20To21({
      version: 20,
      continuationOptions: {
        tabCompletionTriggers: [
          {
            id: 'test',
            type: 'string',
            pattern: ', ',
            enabled: true,
            scope: 'before',
            description: 'Comma trigger',
          },
        ],
      },
    })

    expect(result.version).toBe(21)
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const triggers = result.continuationOptions.tabCompletionTriggers
    if (!Array.isArray(triggers)) {
      throw new Error('Expected tabCompletionTriggers to be an array')
    }
    expect(triggers[0]).toEqual({
      id: 'test',
      type: 'string',
      pattern: ', ',
      enabled: true,
      description: 'Comma trigger',
    })
  })

  it('should add defaults when triggers missing', () => {
    const result = migrateFrom20To21({
      version: 20,
      continuationOptions: {},
    })

    expect(result.version).toBe(21)
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
