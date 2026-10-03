import { migrateFrom87To88 } from './87_to_88'

describe('migrateFrom87To88', () => {
  it('turns a disabled update notice into the off mode', () => {
    expect(
      migrateFrom87To88({
        version: 87,
        pluginUpdateNoticeEnabled: false,
        pluginUpdateAutoDownloadEnabled: true,
      }),
    ).toEqual({ version: 88, pluginUpdateMode: 'off' })
  })

  it('keeps everyone else on notify, whatever the download toggle was', () => {
    expect(
      migrateFrom87To88({
        version: 87,
        pluginUpdateNoticeEnabled: true,
        pluginUpdateAutoDownloadEnabled: false,
      }),
    ).toEqual({ version: 88, pluginUpdateMode: 'notify' })
    expect(migrateFrom87To88({ version: 87 })).toEqual({
      version: 88,
      pluginUpdateMode: 'notify',
    })
  })
})

describe('migrateFrom87To88 auto context compaction', () => {
  it('moves users still on the old defaults to the new ones', () => {
    expect(
      migrateFrom87To88({
        version: 87,
        chatOptions: {
          chatMode: 'agent',
          autoContextCompactionEnabled: false,
          autoContextCompactionThresholdMode: 'tokens',
          autoContextCompactionThresholdTokens: 100000,
          autoContextCompactionThresholdRatio: 0.8,
        },
      }).chatOptions,
    ).toEqual({
      chatMode: 'agent',
      autoContextCompactionEnabled: true,
      autoContextCompactionThresholdRatio: 0.9,
    })
  })

  it('keeps a user-chosen toggle or ratio and drops the removed fields', () => {
    expect(
      migrateFrom87To88({
        version: 87,
        chatOptions: {
          autoContextCompactionEnabled: true,
          autoContextCompactionThresholdMode: 'tokens',
          autoContextCompactionThresholdTokens: 50000,
          autoContextCompactionThresholdRatio: 0.8,
        },
      }).chatOptions,
    ).toEqual({
      autoContextCompactionEnabled: true,
      autoContextCompactionThresholdRatio: 0.8,
    })
    expect(
      migrateFrom87To88({
        version: 87,
        chatOptions: {
          autoContextCompactionEnabled: false,
          autoContextCompactionThresholdRatio: 0.7,
        },
      }).chatOptions,
    ).toEqual({
      autoContextCompactionEnabled: false,
      autoContextCompactionThresholdRatio: 0.7,
    })
  })
})

describe('migrateFrom87To88 agent tool master switches', () => {
  const migrateAgent = (assistant: Record<string, unknown>) =>
    (
      migrateFrom87To88({ version: 87, assistants: [assistant] })
        .assistants as Record<string, unknown>[]
    )[0]

  it('drops both switches from an agent that had them on', () => {
    expect(
      migrateAgent({
        id: 'a',
        enableTools: true,
        includeBuiltinTools: true,
        builtinCapabilityPreferences: { file_reading: { enabled: true } },
      }),
    ).toEqual({
      id: 'a',
      builtinCapabilityPreferences: { file_reading: { enabled: true } },
    })
  })

  it('turns every built-in capability off when built-in tools were excluded', () => {
    const migrated = migrateAgent({
      id: 'a',
      includeBuiltinTools: false,
      builtinCapabilityPreferences: {
        file_reading: { enabled: true, approvalMode: 'full_access' },
      },
      toolPreferences: { srv__search: { enabled: true } },
    })
    const capabilities = migrated.builtinCapabilityPreferences as Record<
      string,
      { enabled: boolean }
    >
    expect(capabilities.file_reading).toEqual({
      enabled: false,
      approvalMode: 'full_access',
    })
    expect(capabilities.vault_shell).toEqual({ enabled: false })
    expect(Object.values(capabilities).every((p) => !p.enabled)).toBe(true)
    expect(migrated.toolPreferences).toEqual({
      srv__search: { enabled: true },
    })
    expect(migrated).not.toHaveProperty('includeBuiltinTools')
  })

  it('turns every built-in capability and remote tool off when tools were disabled', () => {
    const migrated = migrateAgent({
      id: 'a',
      enableTools: false,
      includeBuiltinTools: true,
      enabledToolNames: ['srv__search'],
      toolPreferences: {
        srv__search: { enabled: true, approvalMode: 'full_access' },
      },
    })
    expect(migrated.toolPreferences).toEqual({
      srv__search: { enabled: false, approvalMode: 'full_access' },
    })
    expect(migrated.enabledToolNames).toEqual([])
    expect(
      Object.values(
        migrated.builtinCapabilityPreferences as Record<
          string,
          { enabled: boolean }
        >,
      ).every((p) => !p.enabled),
    ).toBe(true)
    expect(migrated).not.toHaveProperty('enableTools')
  })
})
