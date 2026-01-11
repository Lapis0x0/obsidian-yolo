import { DEFAULT_TAB_COMPLETION_OPTIONS } from '../setting.types'

import { migrateFrom23To24 } from './23_to_24'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

describe('migrateFrom23To24', () => {
  it('should add idleTriggerEnabled when missing', () => {
    const result = migrateFrom23To24({
      version: 23,
      continuationOptions: {
        tabCompletionOptions: {
          triggerDelayMs: 500,
        },
      },
    })

    expect(result.version).toBe(24)
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const tabOptions = result.continuationOptions.tabCompletionOptions
    if (!isRecord(tabOptions)) {
      throw new Error('Expected tabCompletionOptions to be an object')
    }
    expect(tabOptions.idleTriggerEnabled).toBe(
      DEFAULT_TAB_COMPLETION_OPTIONS.idleTriggerEnabled,
    )
  })

  it('should preserve existing idleTriggerEnabled', () => {
    const result = migrateFrom23To24({
      version: 23,
      continuationOptions: {
        tabCompletionOptions: {
          idleTriggerEnabled: true,
        },
      },
    })

    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const tabOptions = result.continuationOptions.tabCompletionOptions
    if (!isRecord(tabOptions)) {
      throw new Error('Expected tabCompletionOptions to be an object')
    }
    expect(tabOptions.idleTriggerEnabled).toBe(true)
  })
})
