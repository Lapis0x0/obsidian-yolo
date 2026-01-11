import { DEFAULT_TAB_COMPLETION_OPTIONS } from '../setting.types'

import { migrateFrom24To25 } from './24_to_25'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

describe('migrateFrom24To25', () => {
  it('should add auto trigger fields when missing', () => {
    const result = migrateFrom24To25({
      version: 24,
      continuationOptions: {
        tabCompletionOptions: {
          idleTriggerEnabled: true,
        },
      },
    })

    expect(result.version).toBe(25)
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const tabOptions = result.continuationOptions.tabCompletionOptions
    if (!isRecord(tabOptions)) {
      throw new Error('Expected tabCompletionOptions to be an object')
    }
    expect(tabOptions.autoTriggerDelayMs).toBe(
      DEFAULT_TAB_COMPLETION_OPTIONS.autoTriggerDelayMs,
    )
    expect(tabOptions.autoTriggerCooldownMs).toBe(
      DEFAULT_TAB_COMPLETION_OPTIONS.autoTriggerCooldownMs,
    )
  })

  it('should preserve existing auto trigger fields', () => {
    const result = migrateFrom24To25({
      version: 24,
      continuationOptions: {
        tabCompletionOptions: {
          autoTriggerDelayMs: 2500,
          autoTriggerCooldownMs: 5000,
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
    expect(tabOptions.autoTriggerDelayMs).toBe(2500)
    expect(tabOptions.autoTriggerCooldownMs).toBe(5000)
  })
})
