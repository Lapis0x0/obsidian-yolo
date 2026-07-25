import type { ModuleDataEnvelope } from '../../core/modules/moduleSettingsStore'
import {
  MODULE_CONFIG_PERSISTENT_DATA,
  MODULE_CONFIG_TRANSFER_KEY,
  canTransferPersistentData,
} from '../../core/persistence/persistentDataRegistry'
import { SETTINGS_SCHEMA_VERSION } from '../../settings/schema/migrations'

import { HOST_CONFIG_KEYS } from './config-keys'
import { redactSensitive } from './redact'
import {
  CONFIG_EXPORT_FORMAT_VERSION,
  ConfigExportFile,
  MODULE_CONFIG_EXPORT_FORMAT_VERSION,
  MODULE_CONFIG_EXPORT_SCHEMA,
} from './types'

/**
 * 计算字符串的 SHA-256 哈希（hex 格式）。
 */
export async function computeChecksum(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type ExportOptions = {
  /** 要导出的 key 列表 */
  keys: string[]
  /** 当前完整的 settings 数据（原始 data.json 内容） */
  settingsData: Record<string, unknown>
  /** 插件版本号 */
  pluginVersion: string
  /** 是否脱敏导出 */
  redacted?: boolean
  /** Generic synchronized module configuration envelopes (format v2). */
  moduleConfigs?: Record<string, ModuleDataEnvelope>
}

/**
 * 根据用户选择的 key 列表，从 settings 中提取数据并生成导出文件内容。
 */
export async function buildExportData(
  options: ExportOptions,
): Promise<ConfigExportFile> {
  const {
    keys,
    settingsData,
    pluginVersion,
    redacted = false,
    moduleConfigs,
  } = options

  // 提取选中的 key 对应的数据
  const data: Record<string, unknown> = {}
  const exportedKeys: string[] = []
  for (const key of keys) {
    if (HOST_CONFIG_KEYS.has(key) && key in settingsData) {
      data[key] = settingsData[key]
      exportedKeys.push(key)
    }
  }
  if (
    keys.includes(MODULE_CONFIG_TRANSFER_KEY) &&
    moduleConfigs !== undefined &&
    canTransferPersistentData(MODULE_CONFIG_PERSISTENT_DATA, redacted)
  ) {
    data[MODULE_CONFIG_TRANSFER_KEY] = moduleConfigs
    exportedKeys.push(MODULE_CONFIG_TRANSFER_KEY)
  }

  const includesModuleConfigs = exportedKeys.includes(
    MODULE_CONFIG_TRANSFER_KEY,
  )

  // 脱敏处理
  const finalData = redacted
    ? (redactSensitive(data) as Record<string, unknown>)
    : data

  // 构建不含 checksum 的对象
  const payload = {
    // A distinct schema prevents older v1 importers from claiming success
    // while silently stripping unknown module configuration.
    settingsVersion: SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    pluginVersion,
    redacted,
    keys: exportedKeys,
    data: finalData,
  }

  // 对完整 payload 计算 SHA-256 作为 checksum
  if (includesModuleConfigs) {
    const modulePayload: Omit<
      Extract<ConfigExportFile, { $schema: 'yolo-config-export-v2' }>,
      'checksum'
    > = {
      ...payload,
      $schema: MODULE_CONFIG_EXPORT_SCHEMA,
      formatVersion: MODULE_CONFIG_EXPORT_FORMAT_VERSION,
    }
    return {
      ...modulePayload,
      checksum: await computeChecksum(JSON.stringify(modulePayload)),
    }
  }
  const legacyPayload: Omit<
    Extract<ConfigExportFile, { $schema: 'yolo-config-export' }>,
    'checksum'
  > = {
    ...payload,
    $schema: 'yolo-config-export',
    formatVersion: CONFIG_EXPORT_FORMAT_VERSION,
  }
  return {
    ...legacyPayload,
    checksum: await computeChecksum(JSON.stringify(legacyPayload)),
  }
}
