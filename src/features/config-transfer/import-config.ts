import { ensureDefaultAssistantInSettings } from '../../core/agent/default-assistant'
import { SETTINGS_SCHEMA_VERSION } from '../../settings/schema/migrations'
import {
  YoloSettings,
  yoloSettingsSchema,
} from '../../settings/schema/setting.types'
import {
  migrateYoloSettingsData,
  normalizeYoloSettingsReferences,
} from '../../settings/schema/settings'

import { EXCLUDED_KEYS, EXPORTABLE_CONFIG_KEYS } from './config-keys'
import { computeChecksum } from './export-config'
import { deepMerge } from './merge-utils'
import { clearSensitive } from './redact'
import { ConfigExportFile, ImportErrorKey, MergeStrategy } from './types'

export type ValidationFailure = {
  valid: false
  errorKey: ImportErrorKey
  fallback: string
  params?: Record<string, string | number>
}

export type ValidationResult =
  | { valid: true; data: ConfigExportFile }
  | ValidationFailure

function failure(
  errorKey: ImportErrorKey,
  fallback: string,
  params?: Record<string, string | number>,
): ValidationFailure {
  return { valid: false, errorKey, fallback, params }
}

/**
 * 校验导出文件格式是否合法。
 */
export async function validateExportFile(
  raw: unknown,
): Promise<ValidationResult> {
  if (!raw || typeof raw !== 'object') {
    return failure('errorNotJson', '文件内容不是有效的 JSON 对象')
  }

  const obj = raw as Record<string, unknown>

  if (obj.$schema !== 'yolo-config-export') {
    return failure(
      'errorNotExportFile',
      '该文件不是 YOLO 插件的配置导出文件，请选择通过「导出配置」功能生成的 .json 文件。',
    )
  }

  if (typeof obj.formatVersion !== 'number' || obj.formatVersion < 1) {
    return failure(
      'errorInvalidFormatVersion',
      '配置文件格式版本不合法，可能已损坏。',
    )
  }

  if (
    typeof obj.settingsVersion !== 'number' ||
    !Number.isInteger(obj.settingsVersion) ||
    obj.settingsVersion < 0
  ) {
    return failure(
      'errorInvalidSettingsVersion',
      '配置文件中的设置版本号不合法，可能已损坏。',
    )
  }

  if (obj.settingsVersion > SETTINGS_SCHEMA_VERSION) {
    return failure(
      'errorFileFromNewerVersion',
      `配置文件来自更高版本的插件（版本 ${obj.settingsVersion}），当前插件版本为 ${SETTINGS_SCHEMA_VERSION}，请先升级当前插件后再导入。`,
      {
        fileVersion: obj.settingsVersion,
        currentVersion: SETTINGS_SCHEMA_VERSION,
      },
    )
  }

  if (!Array.isArray(obj.keys) || obj.keys.length === 0) {
    return failure('errorEmptyKeys', '配置文件中没有包含任何配置项。')
  }

  if (!obj.data || typeof obj.data !== 'object') {
    return failure('errorMissingData', '配置文件中的数据字段缺失或不合法。')
  }

  // 校验 keys 与 data 的一致性
  const dataKeys = Object.keys(obj.data as Record<string, unknown>)
  const declaredKeys = new Set(obj.keys as string[])
  const undeclaredKeys = dataKeys.filter((k) => !declaredKeys.has(k))
  if (undeclaredKeys.length > 0) {
    return failure(
      'errorTampered',
      `配置文件数据与声明不一致：data 中包含未在 keys 中声明的字段（${undeclaredKeys.join(', ')}），文件可能已被篡改。`,
      { fields: undeclaredKeys.join(', ') },
    )
  }

  // 校验 checksum 完整性
  if (typeof obj.checksum === 'string' && obj.checksum.length > 0) {
    const { checksum, ...payload } = obj
    const expectedChecksum = await computeChecksum(JSON.stringify(payload))
    if (checksum !== expectedChecksum) {
      return failure(
        'errorChecksumMismatch',
        '配置文件完整性校验失败，文件内容可能已被修改。',
      )
    }
  }

  return { valid: true, data: obj as unknown as ConfigExportFile }
}

/**
 * 从另一个笔记库的 data.json 原始数据中提取可导入的配置。
 * 返回一个类似 ConfigExportFile 的结构，方便后续统一处理。
 */
export function parseVaultData(
  raw: unknown,
  pluginVersion?: string,
): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return failure('errorVaultParseFailed', '无法解析目标笔记库的配置数据')
  }

  const obj = raw as Record<string, unknown>

  if (
    typeof obj.version !== 'number' ||
    !Number.isInteger(obj.version) ||
    obj.version < 0
  ) {
    return failure(
      'errorVaultMissingVersion',
      '目标笔记库的配置数据缺少 version 字段，无法判断版本兼容性。',
    )
  }

  if (obj.version > SETTINGS_SCHEMA_VERSION) {
    return failure(
      'errorVaultFromNewerVersion',
      `目标笔记库使用更高版本的插件（版本 ${obj.version}），当前插件版本为 ${SETTINGS_SCHEMA_VERSION}，请先升级当前插件后再导入。`,
      { vaultVersion: obj.version, currentVersion: SETTINGS_SCHEMA_VERSION },
    )
  }

  // 笔记库来源包含完整 data.json，应先在完整上下文中迁移，再提取可导入项。
  // 这能保留跨字段迁移所需的信息（例如 assistants 迁移依赖 mcp）。
  const migrated = migrateYoloSettingsData(obj)

  // 未在 EXPORTABLE_CONFIG_KEYS 中声明的顶层字段不应进入候选列表，
  // 否则用户能勾选这些字段，但 yoloSettingsSchema 会 strip 掉，最终出现
  // "导入成功"但实际未生效的误导。
  const exportableKeySet = new Set(EXPORTABLE_CONFIG_KEYS.map((k) => k.key))
  const data: Record<string, unknown> = {}
  const keys: string[] = []
  for (const [key, value] of Object.entries(migrated)) {
    if (EXCLUDED_KEYS.has(key)) continue
    if (!exportableKeySet.has(key)) continue
    data[key] = value
    keys.push(key)
  }

  if (keys.length === 0) {
    return failure('errorVaultEmpty', '目标笔记库的配置数据为空')
  }

  const exportFile: ConfigExportFile = {
    $schema: 'yolo-config-export',
    formatVersion: 1,
    settingsVersion: SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    pluginVersion: pluginVersion ?? 'unknown',
    redacted: false,
    keys,
    data,
    checksum: '',
  }

  return { valid: true, data: exportFile }
}

export type ImportOptions = {
  /** 导入的配置数据（已校验，版本不高于当前版本） */
  importData: ConfigExportFile
  /** 用户选择要导入的 key 列表 */
  selectedKeys: string[]
  /** 当前完整的 settings */
  currentSettings: YoloSettings
  /** 合并策略 */
  mergeStrategy: MergeStrategy
}

type TranslateFn = (keyPath: string, fallback?: string) => string

function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    name in params ? String(params[name]) : `{${name}}`,
  )
}

/**
 * 把 ValidationFailure / ImportValidationError 中的 errorKey + fallback + params
 * 渲染成最终展示给用户的字符串。
 */
export function renderImportError(
  failure:
    | ValidationFailure
    | {
        errorKey: ImportErrorKey
        fallback: string
        params?: Record<string, string | number>
      },
  t: TranslateFn,
): string {
  const template = t(
    `configTransfer.errors.${failure.errorKey}`,
    failure.fallback,
  )
  return interpolate(template, failure.params)
}

export class ImportValidationError extends Error {
  constructor(
    public readonly errorKey: ImportErrorKey,
    public readonly fallback: string,
    public readonly issues: string[] = [],
    public readonly params?: Record<string, string | number>,
  ) {
    super(fallback)
    this.name = 'ImportValidationError'
  }
}

/**
 * 执行配置导入，返回合并后的完整 settings。
 *
 * 流程：
 * 1. 旧版部分导出文件以当前配置补齐迁移上下文，迁移后只提取导出字段
 * 2. 按合并策略将导入数据合并到 currentSettings
 *    （脱敏导出时先把所有敏感字段清空，避免假凭证被写入）
 * 3. 通过 yoloSettingsSchema 显式校验；失败时抛出 ImportValidationError，
 *    调用方负责提示用户并保留原配置（不静默回退到默认值）
 * 4. 在合法结果上做引用规范化与默认 assistant 兜底
 */
export function applyImport(options: ImportOptions): YoloSettings {
  const { importData, selectedKeys, currentSettings, mergeStrategy } = options

  if (importData.settingsVersion > SETTINGS_SCHEMA_VERSION) {
    throw new ImportValidationError(
      'errorApplyVersionMismatch',
      `导入数据版本（${importData.settingsVersion}）高于当前插件版本（${SETTINGS_SCHEMA_VERSION}），无法导入。`,
      [],
      {
        importVersion: importData.settingsVersion,
        currentVersion: SETTINGS_SCHEMA_VERSION,
      },
    )
  }

  let incomingData = importData.redacted
    ? (clearSensitive(importData.data) as Record<string, unknown>)
    : importData.data

  const currentRaw = currentSettings as unknown as Record<string, unknown>

  if (importData.settingsVersion < SETTINGS_SCHEMA_VERSION) {
    // 部分导出缺少 migration 依赖的其他字段。用当前配置补齐上下文，并让
    // 导出值优先；迁移后仍只提取文件声明的字段，不会改动未导出的配置。
    const incomingKeys = Object.keys(incomingData)
    const migrationContext = JSON.parse(
      JSON.stringify({
        ...currentRaw,
        ...incomingData,
        version: importData.settingsVersion,
      }),
    ) as Record<string, unknown>
    const migrated = migrateYoloSettingsData(migrationContext)
    incomingData = Object.fromEntries(
      incomingKeys.flatMap((key) =>
        key in migrated ? [[key, migrated[key]]] : [],
      ),
    )
  }

  // 2. 按合并策略合并到当前配置。脱敏导出时所有敏感字段（apiKey/password/
  //    headers/env/customHeaders.value）已是随机字符串，导入前清空，
  //    避免被当成真凭证写回 providers/webSearch/mcp。
  const merged: Record<string, unknown> = { ...currentRaw }

  for (const key of selectedKeys) {
    if (EXCLUDED_KEYS.has(key)) continue

    const importedValue = incomingData[key]
    if (importedValue === undefined) continue

    if (mergeStrategy === 'overwrite') {
      merged[key] = importedValue
    } else {
      const currentValue = merged[key]
      if (
        typeof currentValue === 'object' &&
        currentValue !== null &&
        !Array.isArray(currentValue) &&
        typeof importedValue === 'object' &&
        importedValue !== null &&
        !Array.isArray(importedValue)
      ) {
        merged[key] = deepMerge(
          currentValue as Record<string, unknown>,
          importedValue as Record<string, unknown>,
        )
      } else {
        merged[key] = importedValue
      }
    }
  }

  merged.version = SETTINGS_SCHEMA_VERSION

  // 3. 显式 schema 校验，失败时抛错（不走 parseYoloSettings 的默认值兜底）
  const parsed = yoloSettingsSchema.safeParse(merged)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    throw new ImportValidationError(
      'errorApplySchema',
      '导入的配置未通过校验，可能存在字段缺失或格式错误。',
      issues,
    )
  }

  // 4. 引用规范化 + 默认 assistant 兜底
  const normalized = normalizeYoloSettingsReferences(parsed.data)
  return ensureDefaultAssistantInSettings({
    ...normalized,
    version: SETTINGS_SCHEMA_VERSION,
  })
}
