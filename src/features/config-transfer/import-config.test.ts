import { SETTINGS_SCHEMA_VERSION } from '../../settings/schema/migrations'
import { parseYoloSettings } from '../../settings/schema/settings'

import { buildExportData, computeChecksum } from './export-config'
import {
  ImportValidationError,
  applyImport,
  parseVaultData,
  renderImportError,
  validateExportFile,
} from './import-config'
import {
  CONFIG_EXPORT_FORMAT_VERSION,
  ConfigExportFile,
  MODULE_CONFIG_EXPORT_FORMAT_VERSION,
  MODULE_CONFIG_EXPORT_SCHEMA,
} from './types'

describe('validateExportFile', () => {
  // 不含 checksum 的基础文件（跳过 checksum 校验）
  const validFile = {
    $schema: 'yolo-config-export',
    formatVersion: CONFIG_EXPORT_FORMAT_VERSION,
    settingsVersion: SETTINGS_SCHEMA_VERSION,
    exportedAt: '2026-05-11T10:00:00.000Z',
    pluginVersion: '1.5.7.5',
    redacted: false,
    keys: ['providers', 'chatModelId'],
    data: {
      providers: [],
      chatModelId: 'test/model',
    },
  }

  it('should accept a valid export file without checksum', async () => {
    const result = await validateExportFile(validFile)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.$schema).toBe('yolo-config-export')
    }
  })

  it('should accept a valid export file with correct checksum', async () => {
    const { checksum, ...payload } = validFile as Record<string, unknown>
    void checksum
    const correctChecksum = await computeChecksum(JSON.stringify(payload))
    const fileWithChecksum = { ...validFile, checksum: correctChecksum }
    const result = await validateExportFile(fileWithChecksum)
    expect(result.valid).toBe(true)
  })

  it('should reject a file with incorrect checksum (tampered content)', async () => {
    const fileWithBadChecksum = {
      ...validFile,
      checksum:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }
    const result = await validateExportFile(fileWithBadChecksum)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorChecksumMismatch')
    }
  })

  it('should reject null input', async () => {
    const result = await validateExportFile(null)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorNotJson')
    }
  })

  it('should reject non-object input', async () => {
    const result = await validateExportFile('not an object')
    expect(result.valid).toBe(false)
  })

  it('should reject missing $schema', async () => {
    const result = await validateExportFile({
      ...validFile,
      $schema: undefined,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorNotExportFile')
    }
  })

  it('should reject wrong $schema value', async () => {
    const result = await validateExportFile({ ...validFile, $schema: 'wrong' })
    expect(result.valid).toBe(false)
  })

  it('should reject invalid formatVersion', async () => {
    const result = await validateExportFile({ ...validFile, formatVersion: 0 })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorInvalidFormatVersion')
    }
  })

  it('should reject invalid settingsVersion', async () => {
    const result = await validateExportFile({
      ...validFile,
      settingsVersion: -1,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorInvalidSettingsVersion')
    }
  })

  it('should reject a fractional settingsVersion', async () => {
    const result = await validateExportFile({
      ...validFile,
      settingsVersion: SETTINGS_SCHEMA_VERSION - 0.5,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorInvalidSettingsVersion')
    }
  })

  it('should accept settingsVersion lower than current schema version', async () => {
    const result = await validateExportFile({
      ...validFile,
      settingsVersion: SETTINGS_SCHEMA_VERSION - 1,
    })
    expect(result.valid).toBe(true)
  })

  it('should reject settingsVersion higher than current schema version', async () => {
    const result = await validateExportFile({
      ...validFile,
      settingsVersion: SETTINGS_SCHEMA_VERSION + 1,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorFileFromNewerVersion')
      expect(result.params?.fileVersion).toBe(SETTINGS_SCHEMA_VERSION + 1)
    }
  })

  it('should reject empty keys array', async () => {
    const result = await validateExportFile({ ...validFile, keys: [] })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorEmptyKeys')
    }
  })

  it('should reject missing data field', async () => {
    const result = await validateExportFile({ ...validFile, data: undefined })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorMissingData')
    }
  })

  it('should reject when data contains keys not declared in keys array', async () => {
    const tampered = {
      ...validFile,
      keys: ['providers'],
      data: {
        providers: [],
        systemPrompt: 'injected',
      },
    }
    const result = await validateExportFile(tampered)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorTampered')
      expect(String(result.params?.fields)).toContain('systemPrompt')
    }
  })

  it('should accept when keys is a superset of data keys (some keys have no data)', async () => {
    const sparse = {
      ...validFile,
      keys: ['providers', 'chatModelId', 'ragOptions'],
      data: {
        providers: [],
        chatModelId: 'test/model',
      },
    }
    const result = await validateExportFile(sparse)
    expect(result.valid).toBe(true)
  })

  it('should reject a file with a newer unsupported formatVersion', async () => {
    const futureFile = {
      ...validFile,
      formatVersion: 99,
    }
    const result = await validateExportFile(futureFile)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorInvalidFormatVersion')
    }
  })

  it('keeps v1 Host-only export files compatible', async () => {
    const result = await validateExportFile({
      ...validFile,
      formatVersion: 1,
    })
    expect(result.valid).toBe(true)
  })

  it('accepts v2 module configuration and rejects it in v1', async () => {
    const v2 = {
      ...validFile,
      $schema: MODULE_CONFIG_EXPORT_SCHEMA,
      formatVersion: MODULE_CONFIG_EXPORT_FORMAT_VERSION,
      keys: ['moduleConfigs'],
      data: {
        moduleConfigs: {
          learning: { schemaVersion: 1, data: { modelId: 'model-a' } },
        },
      },
    }
    await expect(validateExportFile(v2)).resolves.toMatchObject({ valid: true })
    await expect(
      validateExportFile({ ...v2, formatVersion: 1 }),
    ).resolves.toMatchObject({
      valid: false,
      errorKey: 'errorInvalidFormatVersion',
    })
  })

  it('rejects module configuration in a redacted export', async () => {
    const result = await validateExportFile({
      ...validFile,
      $schema: MODULE_CONFIG_EXPORT_SCHEMA,
      formatVersion: MODULE_CONFIG_EXPORT_FORMAT_VERSION,
      redacted: true,
      keys: ['moduleConfigs'],
      data: { moduleConfigs: {} },
    })
    expect(result).toMatchObject({ valid: false, errorKey: 'errorTampered' })
  })

  it('rejects a non-boolean redacted flag', async () => {
    const result = await validateExportFile({
      ...validFile,
      redacted: 'yes',
    })
    expect(result).toMatchObject({ valid: false, errorKey: 'errorTampered' })
  })

  it('requires module data in the module export schema', async () => {
    const result = await validateExportFile({
      ...validFile,
      $schema: MODULE_CONFIG_EXPORT_SCHEMA,
      formatVersion: MODULE_CONFIG_EXPORT_FORMAT_VERSION,
      keys: ['providers'],
      data: { providers: [] },
    })
    expect(result).toMatchObject({ valid: false, errorKey: 'errorTampered' })
  })

  it('rejects malformed module configuration before settings are applied', async () => {
    const result = await validateExportFile({
      ...validFile,
      $schema: MODULE_CONFIG_EXPORT_SCHEMA,
      formatVersion: MODULE_CONFIG_EXPORT_FORMAT_VERSION,
      keys: ['moduleConfigs'],
      data: { moduleConfigs: { learning: { schemaVersion: -1, data: {} } } },
    })
    expect(result).toMatchObject({ valid: false, errorKey: 'errorTampered' })
  })

  it('should validate checksum end-to-end with buildExportData', async () => {
    const exported = await buildExportData({
      keys: ['providers', 'chatModelId'],
      settingsData: {
        providers: [{ id: 'test', apiKey: 'key' }],
        chatModelId: 'test/model',
      },
      pluginVersion: '1.5.7.5',
    })

    // 正常导出的文件应该通过校验
    const result = await validateExportFile(exported)
    expect(result.valid).toBe(true)

    // 篡改后应该失败
    const tampered = { ...exported, redacted: true }
    const tamperedResult = await validateExportFile(tampered)
    expect(tamperedResult.valid).toBe(false)
    if (!tamperedResult.valid) {
      expect(tamperedResult.errorKey).toBe('errorChecksumMismatch')
    }
  })
})

describe('parseVaultData', () => {
  it('should parse vault data.json with matching version', () => {
    const vaultData = {
      version: SETTINGS_SCHEMA_VERSION,
      __meta: { deviceId: 'other-device' },
      providers: [{ id: 'openai', apiKey: 'sk-xxx' }],
      chatModels: [
        { id: 'openai/gpt-4', model: 'gpt-4', providerId: 'openai' },
      ],
      chatModelId: 'openai/gpt-4',
    }

    const result = parseVaultData(vaultData, '1.5.0')
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.settingsVersion).toBe(SETTINGS_SCHEMA_VERSION)
      expect(result.data.keys).toContain('providers')
      expect(result.data.keys).toContain('chatModels')
      expect(result.data.keys).toContain('chatModelId')
      expect(result.data.keys).not.toContain('version')
      expect(result.data.keys).not.toContain('__meta')
      expect(result.data.data).not.toHaveProperty('version')
      expect(result.data.data).not.toHaveProperty('__meta')
    }
  })

  it('should reject null input', () => {
    const result = parseVaultData(null)
    expect(result.valid).toBe(false)
  })

  it('should reject empty object (no exportable keys)', () => {
    const result = parseVaultData({
      version: SETTINGS_SCHEMA_VERSION,
      __meta: {},
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorVaultEmpty')
    }
  })

  it('should reject when version field is missing', () => {
    const result = parseVaultData({ providers: [] })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorVaultMissingVersion')
    }
  })

  it('should migrate older vault data before extracting importable keys', () => {
    const result = parseVaultData({
      version: 71,
      ragOptions: { enabled: true },
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.settingsVersion).toBe(SETTINGS_SCHEMA_VERSION)
      expect(result.data.data.ragOptions).toMatchObject({
        enabled: true,
        excludeYoloBaseDir: true,
      })
    }
  })

  it('should reject newer vault version', () => {
    const result = parseVaultData({
      version: SETTINGS_SCHEMA_VERSION + 1,
      providers: [],
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errorKey).toBe('errorVaultFromNewerVersion')
    }
  })

  it('should drop unknown top-level keys not in EXPORTABLE_CONFIG_KEYS', () => {
    // 同版本策略下，未在白名单内的字段被 schema strip 后不会落盘，
    // 不应让用户在 UI 里勾选它们造成"导入成功但无效"的错觉。
    const vaultData = {
      version: SETTINGS_SCHEMA_VERSION,
      providers: [],
      futureFeature: { enabled: true },
    }
    const result = parseVaultData(vaultData)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.keys).toContain('providers')
      expect(result.data.keys).not.toContain('futureFeature')
      expect(result.data.data).not.toHaveProperty('futureFeature')
    }
  })
})

describe('applyImport', () => {
  const currentSettings = parseYoloSettings({
    version: SETTINGS_SCHEMA_VERSION,
    providers: [
      { id: 'existing', presetType: 'openai', apiKey: 'existing-key' },
    ],
    chatModels: [
      {
        providerId: 'existing',
        id: 'existing/gpt-4',
        model: 'gpt-4',
        enable: true,
      },
    ],
    chatModelId: 'existing/gpt-4',
    ragOptions: {
      enabled: true,
      chunkSize: 1000,
      limit: 10,
      excludePatterns: ['*.tmp'],
    },
  })

  const makeImportData = (
    overrides: Partial<
      Extract<ConfigExportFile, { $schema: 'yolo-config-export' }>
    >,
  ): Extract<ConfigExportFile, { $schema: 'yolo-config-export' }> => ({
    $schema: 'yolo-config-export',
    formatVersion: 1,
    settingsVersion: SETTINGS_SCHEMA_VERSION,
    exportedAt: '2026-05-11T10:00:00.000Z',
    pluginVersion: '1.5.7.5',
    redacted: false,
    checksum: '',
    keys: [],
    data: {},
    ...overrides,
  })

  it('should overwrite selected keys in overwrite mode', () => {
    const importData = makeImportData({
      keys: ['ragOptions'],
      data: { ragOptions: { enabled: false, chunkSize: 500, limit: 5 } },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['ragOptions'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    expect(result.ragOptions.enabled).toBe(false)
    expect(result.ragOptions.chunkSize).toBe(500)
    expect(result.ragOptions.limit).toBe(5)
    expect(result.providers).toEqual(currentSettings.providers)
  })

  it('should deep merge in merge mode, preserving current-only fields', () => {
    const importData = makeImportData({
      keys: ['ragOptions'],
      data: { ragOptions: { chunkSize: 800, limit: 20 } },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['ragOptions'],
      currentSettings,
      mergeStrategy: 'merge',
    })

    expect(result.ragOptions.chunkSize).toBe(800)
    expect(result.ragOptions.limit).toBe(20)
    expect(result.ragOptions.enabled).toBe(true)
    expect(result.ragOptions.excludePatterns).toEqual(['*.tmp'])
  })

  it('should only import selected keys, ignoring unselected ones', () => {
    const importData = makeImportData({
      keys: ['ragOptions', 'systemPrompt'],
      data: { ragOptions: { chunkSize: 500 }, systemPrompt: 'imported prompt' },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['systemPrompt'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    expect(result.systemPrompt).toBe('imported prompt')
    expect(result.ragOptions.chunkSize).toBe(1000)
  })

  it('should migrate an older partial export before importing it', () => {
    const importData = makeImportData({
      settingsVersion: SETTINGS_SCHEMA_VERSION - 1,
      pluginVersion: '1.4.0',
      keys: ['ragOptions'],
      data: { ragOptions: { enabled: false, chunkSize: 750 } },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['ragOptions'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    expect(result.ragOptions.enabled).toBe(false)
    expect(result.ragOptions.chunkSize).toBe(750)
    expect(result.ragOptions.excludeYoloBaseDir).toBe(true)
  })

  it('should not apply migration-generated fields that were not exported', () => {
    const importData = makeImportData({
      settingsVersion: SETTINGS_SCHEMA_VERSION - 1,
      keys: ['systemPrompt'],
      data: { systemPrompt: 'from old export' },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['systemPrompt'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    expect(result.systemPrompt).toBe('from old export')
    expect(result.ragOptions).toEqual(currentSettings.ragOptions)
  })

  it('should keep a sparse old export key absent from data untouched', () => {
    const importData = makeImportData({
      settingsVersion: SETTINGS_SCHEMA_VERSION - 1,
      keys: ['systemPrompt', 'ragOptions'],
      data: { systemPrompt: 'from old export' },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['systemPrompt', 'ragOptions'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    expect(result.systemPrompt).toBe('from old export')
    expect(result.ragOptions).toEqual(currentSettings.ragOptions)
  })

  it('should clear apiKey fields when importData.redacted is true', () => {
    const importData = makeImportData({
      redacted: true,
      keys: ['providers'],
      data: {
        providers: [
          {
            id: 'redacted-provider',
            presetType: 'openai',
            // 脱敏导出的随机字符串绝不能当成真的 key 写入
            apiKey: 'FAKE_RANDOM_KEY_abcdefghijklmnop',
          },
        ],
      },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['providers'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    const importedProvider = result.providers.find(
      (p) => p.id === 'redacted-provider',
    )
    expect(importedProvider).toBeDefined()
    expect(importedProvider?.apiKey).toBe('')
  })

  it('should not touch apiKey when importData.redacted is false', () => {
    const importData = makeImportData({
      redacted: false,
      keys: ['providers'],
      data: {
        providers: [
          {
            id: 'real-provider',
            presetType: 'openai',
            apiKey: 'sk-real-key',
          },
        ],
      },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['providers'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    const importedProvider = result.providers.find(
      (p) => p.id === 'real-provider',
    )
    expect(importedProvider?.apiKey).toBe('sk-real-key')
  })

  it('should silently replace malformed field with schema default (known schema .catch behavior)', () => {
    // 已知限制：yoloSettingsSchema 每个字段都用 .catch(default)，
    // 所以同版本下"字段格式非法"不会抛错，会被默默替换成默认值。
    // 本测试用于固化当前行为，避免后续 review 误以为 applyImport 能拦截。
    // 真正的字段级严格化需要在 schema 层单独 issue 解决。
    const importData = makeImportData({
      keys: ['ragOptions'],
      data: {
        ragOptions: 'not-an-object' as unknown as Record<string, unknown>,
      },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['ragOptions'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    // 没有抛错；坏字段被默认值替换
    expect(result.ragOptions).toBeDefined()
    expect(typeof result.ragOptions).toBe('object')
    expect(typeof result.ragOptions.chunkSize).toBe('number')
  })

  it('should not silently fall back to defaults when version mismatches', () => {
    // 回归：旧实现走 parseYoloSettings 的兜底，跨版本会返回一个被默认值覆盖
    // 的"成功"结果。新实现必须显式抛错，调用方据此保留原配置。
    const importData = makeImportData({
      settingsVersion: SETTINGS_SCHEMA_VERSION + 1,
      keys: ['ragOptions'],
      data: { ragOptions: { enabled: false, chunkSize: 999 } },
    })

    expect(() =>
      applyImport({
        importData,
        selectedKeys: ['ragOptions'],
        currentSettings,
        mergeStrategy: 'overwrite',
      }),
    ).toThrow(ImportValidationError)

    // currentSettings 未被改动
    expect(currentSettings.ragOptions.chunkSize).toBe(1000)
    expect(currentSettings.ragOptions.enabled).toBe(true)
  })

  it('should normalize references after import (orphan model references)', () => {
    const importData = makeImportData({
      keys: ['chatModelId'],
      data: { chatModelId: 'nonexistent/model' },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['chatModelId'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    expect(result.chatModelId).not.toBe('nonexistent/model')
  })

  it('should handle primitive value import in merge mode (direct overwrite)', () => {
    const importData = makeImportData({
      keys: ['systemPrompt'],
      data: { systemPrompt: 'new prompt' },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['systemPrompt'],
      currentSettings,
      mergeStrategy: 'merge',
    })

    expect(result.systemPrompt).toBe('new prompt')
  })

  it('should ignore EXCLUDED_KEYS in selectedKeys', () => {
    const importData = makeImportData({
      keys: ['systemPrompt', 'version'],
      data: { systemPrompt: 'imported', version: 999 },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['systemPrompt', 'version', '__meta'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    expect(result.systemPrompt).toBe('imported')
    // version 应该是当前 SETTINGS_SCHEMA_VERSION，不被导入覆盖
    expect(result.version).toBe(SETTINGS_SCHEMA_VERSION)
  })

  it('should replace arrays in merge mode (providers list)', () => {
    const importData = makeImportData({
      keys: ['providers'],
      data: {
        providers: [
          { id: 'new-provider', presetType: 'openai', apiKey: 'new-key' },
        ],
      },
    })

    const result = applyImport({
      importData,
      selectedKeys: ['providers'],
      currentSettings,
      mergeStrategy: 'merge',
    })

    // 数组在 merge 模式下是直接覆盖，不是追加
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].id).toBe('new-provider')
  })

  it('should skip keys whose imported value is undefined', () => {
    const importData = makeImportData({
      keys: ['systemPrompt', 'chatModelId'],
      data: { chatModelId: 'existing/gpt-4' },
      // systemPrompt 在 keys 中声明但 data 中没有
    })

    const result = applyImport({
      importData,
      selectedKeys: ['systemPrompt', 'chatModelId'],
      currentSettings,
      mergeStrategy: 'overwrite',
    })

    // systemPrompt 不在 migratedData 中，应保持当前值
    expect(result.systemPrompt).toBe(currentSettings.systemPrompt)
    expect(result.chatModelId).toBe('existing/gpt-4')
  })
})

describe('renderImportError', () => {
  it('interpolates params into the i18n template', () => {
    const t = (keyPath: string, fallback?: string): string => {
      if (keyPath === 'configTransfer.errors.errorFileFromNewerVersion') {
        return 'File v{fileVersion} > current v{currentVersion}'
      }
      return fallback ?? keyPath
    }
    const out = renderImportError(
      {
        valid: false,
        errorKey: 'errorFileFromNewerVersion',
        fallback: 'newer version',
        params: { fileVersion: 53, currentVersion: 52 },
      },
      t,
    )
    expect(out).toBe('File v53 > current v52')
  })

  it('falls back to the fallback string when translation is missing', () => {
    const t = (_key: string, fallback?: string): string => fallback ?? _key
    const out = renderImportError(
      {
        valid: false,
        errorKey: 'errorNotJson',
        fallback: '文件不是 JSON',
      },
      t,
    )
    expect(out).toBe('文件不是 JSON')
  })

  it('renders ImportValidationError via the same path', () => {
    const t = (_key: string, fallback?: string): string => fallback ?? _key
    const err = new ImportValidationError(
      'errorApplyVersionMismatch',
      'fallback {importVersion}/{currentVersion}',
      [],
      { importVersion: 49, currentVersion: 52 },
    )
    expect(renderImportError(err, t)).toBe('fallback 49/52')
  })
})
