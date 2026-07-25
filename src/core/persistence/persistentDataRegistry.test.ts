import { yoloSettingsSchema } from '../../settings/schema/setting.types'

import {
  EXCLUDED_HOST_SETTINGS,
  EXPORTABLE_HOST_SETTINGS,
  HOST_SETTINGS_CLASSIFICATIONS,
  MODULE_CONFIG_PERSISTENT_DATA,
  PERSISTENT_DATA_REGISTRY,
  canTransferPersistentData,
} from './persistentDataRegistry'

describe('persistent data registry', () => {
  it('explicitly classifies every top-level Host settings field', () => {
    const schemaKeys = Object.keys(yoloSettingsSchema.shape).sort()
    const classifiedKeys = HOST_SETTINGS_CLASSIFICATIONS.map(
      (entry) => entry.settingsKey,
    ).sort()

    expect(classifiedKeys).toEqual(schemaKeys)
    expect(new Set(classifiedKeys).size).toBe(classifiedKeys.length)
    expect(EXPORTABLE_HOST_SETTINGS.length).toBeGreaterThan(0)
    expect(EXCLUDED_HOST_SETTINGS.every((entry) => entry.reason)).toBe(true)
  })

  it('keeps non-config content registered but excluded from transfer', () => {
    const ids = new Set(PERSISTENT_DATA_REGISTRY.map((entry) => entry.id))
    expect(ids.size).toBe(PERSISTENT_DATA_REGISTRY.length)
    expect(ids.has('host.chat-history')).toBe(true)
    expect(ids.has('module.learning-content')).toBe(true)
  })

  it('keeps transfer and redaction policies consistent', () => {
    for (const entry of PERSISTENT_DATA_REGISTRY) {
      if (entry.transfer === 'config-export') {
        expect(['supported', 'unredacted-only']).toContain(entry.redaction)
      } else {
        expect(entry.redaction).toBe('none')
        expect(entry.reason).toBeTruthy()
      }
    }
  })

  it('allows module configuration transfer only without redaction', () => {
    expect(
      canTransferPersistentData(MODULE_CONFIG_PERSISTENT_DATA, false),
    ).toBe(true)
    expect(canTransferPersistentData(MODULE_CONFIG_PERSISTENT_DATA, true)).toBe(
      false,
    )
  })
})
