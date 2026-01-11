import { DEFAULT_TAB_COMPLETION_LENGTH_PRESET } from '../setting.types'

import { migrateFrom22To23 } from './22_to_23'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

describe('migrateFrom22To23', () => {
  it('should add default length preset when missing', () => {
    const result = migrateFrom22To23({
      version: 22,
      continuationOptions: {},
    })

    expect(result.version).toBe(23)
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    expect(result.continuationOptions.tabCompletionLengthPreset).toBe(
      DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
    )
  })

  it('should normalize invalid length preset', () => {
    const result = migrateFrom22To23({
      version: 22,
      continuationOptions: {
        tabCompletionLengthPreset: 'extra-long',
      },
    })

    expect(result.version).toBe(23)
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    expect(result.continuationOptions.tabCompletionLengthPreset).toBe(
      DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
    )
  })

  it('should keep valid length preset', () => {
    const result = migrateFrom22To23({
      version: 22,
      continuationOptions: {
        tabCompletionLengthPreset: 'short',
      },
    })

    expect(result.version).toBe(23)
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    expect(result.continuationOptions.tabCompletionLengthPreset).toBe('short')
  })
})
