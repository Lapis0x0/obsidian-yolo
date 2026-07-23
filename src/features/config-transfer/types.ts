/**
 * 配置导入/导出功能的类型定义
 */

type ConfigExportFileBase = {
  /** 导出时的 SETTINGS_SCHEMA_VERSION，导入时用于驱动迁移链 */
  settingsVersion: number
  /** 导出时间 ISO 字符串 */
  exportedAt: string
  /** 导出时的插件版本号 */
  pluginVersion: string
  /** 是否为脱敏导出（敏感字段已替换为随机字符串） */
  redacted: boolean
  /** 导出的配置 key 列表 */
  keys: string[]
  /** 实际配置数据（仅包含 keys 中列出的字段） */
  data: Record<string, unknown>
  /** 除 checksum 外所有字段的 JSON 序列化 SHA-256 哈希（hex），用于完整性校验 */
  checksum: string
}

/** Legacy Host-only file and the module bundle are intentionally disjoint. */
export type ConfigExportFile =
  | (ConfigExportFileBase & {
      $schema: 'yolo-config-export'
      formatVersion: 1
    })
  | (ConfigExportFileBase & {
      $schema: 'yolo-config-export-v2'
      formatVersion: 2
    })

/** 导入来源类型 */
export type ImportSource = 'file' | 'vault'

/** 导入合并策略 */
export type MergeStrategy = 'overwrite' | 'merge'

/** 配置 key 的元信息 */
export type ConfigKeyMeta = {
  /** data.json 中的 key */
  key: string
  /** i18n 缺失时使用的可读默认 label（中文） */
  fallbackLabel: string
  /** The entry cannot be safely redacted by Host-owned code. */
  unredactedOnly?: boolean
}

/** Legacy Host-only format. Keep emitting it when no module config is present. */
export const CONFIG_EXPORT_FORMAT_VERSION = 1
export const MODULE_CONFIG_EXPORT_SCHEMA = 'yolo-config-export-v2'
export const MODULE_CONFIG_EXPORT_FORMAT_VERSION = 2

/**
 * 导入/校验失败时使用的错误 key，配合 `configTransfer.errors.*` 翻译条目。
 */
export type ImportErrorKey =
  | 'errorNotJson'
  | 'errorNotExportFile'
  | 'errorInvalidFormatVersion'
  | 'errorInvalidSettingsVersion'
  | 'errorFileFromNewerVersion'
  | 'errorEmptyKeys'
  | 'errorMissingData'
  | 'errorTampered'
  | 'errorChecksumMismatch'
  | 'errorVaultParseFailed'
  | 'errorVaultMissingVersion'
  | 'errorVaultFromNewerVersion'
  | 'errorVaultEmpty'
  | 'errorApplyVersionMismatch'
  | 'errorApplySchema'
