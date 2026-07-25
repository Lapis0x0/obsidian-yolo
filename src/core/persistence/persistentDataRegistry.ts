import type { YoloSettings } from '../../settings/schema/setting.types'

/**
 * First-phase persistent-data catalog. It centralizes audited metadata and
 * transfer policy, not storage implementations; domains retain their own
 * schema, migrations and stores. Host settings are exhaustive by schema,
 * while the remaining entries document audited domains without forcing every
 * store through this catalog yet.
 */

export type PersistentDataKind =
  | 'config'
  | 'user-data'
  | 'cache'
  | 'runtime-state'

export type PersistentDataScope = 'synchronized' | 'device-local'

export type PersistentDataTransfer = 'config-export' | 'excluded'

/** Whether an entry can be included in a redacted configuration export. */
export type PersistentDataRedaction = 'supported' | 'unredacted-only' | 'none'

export type PersistentDataEntry = Readonly<{
  id: string
  owner: 'host' | 'module'
  kind: PersistentDataKind
  scope: PersistentDataScope
  followsBaseDir: boolean
  transfer: PersistentDataTransfer
  redaction: PersistentDataRedaction
  reason?: string
}>

export type HostSettingsClassification = PersistentDataEntry &
  Readonly<{
    settingsKey: keyof YoloSettings
    fallbackLabel?: string
  }>

const hostSetting = (
  settingsKey: keyof YoloSettings,
  fallbackLabel: string,
): HostSettingsClassification => ({
  id: `host.settings.${settingsKey}`,
  owner: 'host',
  kind: 'config',
  scope: 'synchronized',
  followsBaseDir: false,
  transfer: 'config-export',
  redaction: 'supported',
  settingsKey,
  fallbackLabel,
})

const excludedHostSetting = (
  settingsKey: keyof YoloSettings,
  kind: PersistentDataKind,
  reason: string,
): HostSettingsClassification => ({
  id: `host.settings.${settingsKey}`,
  owner: 'host',
  kind,
  scope: 'synchronized',
  followsBaseDir: false,
  transfer: 'excluded',
  redaction: 'none',
  settingsKey,
  reason,
})

/**
 * The complete, explicit transfer classification for every top-level Host
 * setting. Keep this next to the persistence catalog rather than a UI-only
 * allowlist so schema additions cannot silently disappear from transfers.
 */
export const HOST_SETTINGS_CLASSIFICATIONS = [
  excludedHostSetting('version', 'runtime-state', 'schema metadata'),
  hostSetting('providers', 'AI 服务商'),
  hostSetting('chatModels', '对话模型'),
  hostSetting('embeddingModels', '嵌入模型'),
  hostSetting('chatModelId', '默认对话模型'),
  hostSetting('chatTitleModelId', '标题生成模型'),
  hostSetting('embeddingModelId', '默认嵌入模型'),
  hostSetting('systemPrompt', '系统提示词'),
  excludedHostSetting(
    'timeContextEnabled',
    'config',
    'legacy global fallback; active behavior is stored per assistant',
  ),
  excludedHostSetting(
    'softDismissedUpdateVersion',
    'runtime-state',
    'synchronized update banner dismissal state',
  ),
  excludedHostSetting(
    'mutedUpdateVersion',
    'runtime-state',
    'synchronized update banner mute state',
  ),
  excludedHostSetting(
    'mutedModuleUpdateVersions',
    'runtime-state',
    'synchronized module update banner mute state',
  ),
  hostSetting('pluginUpdateAutoDownloadEnabled', '插件自动下载更新'),
  hostSetting('ragOptions', '知识库设置'),
  hostSetting('mcp', 'MCP 工具'),
  hostSetting('jsSandbox', 'JS 沙箱权限'),
  hostSetting('webSearch', '联网搜索'),
  hostSetting('skills', '技能设置'),
  hostSetting('yolo', '基础设置'),
  hostSetting('debug', '调试设置'),
  hostSetting('chatOptions', '对话偏好'),
  hostSetting('notificationOptions', '通知设置'),
  excludedHostSetting(
    'learningOptions',
    'runtime-state',
    'legacy Learning handoff; current module configuration has its own store',
  ),
  hostSetting('continuationOptions', '续写与补全'),
  hostSetting('assistants', 'Agent 配置'),
  hostSetting('currentAssistantId', '当前 Agent'),
  hostSetting('quickAskAssistantId', 'Quick Ask Agent'),
] as const satisfies readonly HostSettingsClassification[]

export const MODULE_CONFIG_TRANSFER_KEY = 'moduleConfigs'

/** `__meta` is transport metadata in plugin data.json, not a settings field. */
export const HOST_SETTINGS_META: PersistentDataEntry = {
  id: 'host.settings.__meta',
  owner: 'host',
  kind: 'runtime-state',
  scope: 'synchronized',
  followsBaseDir: false,
  transfer: 'excluded',
  redaction: 'none',
  reason: 'cross-device conflict-resolution metadata',
}

export const MODULE_CONFIG_PERSISTENT_DATA: PersistentDataEntry = {
  id: 'module.config',
  owner: 'module',
  kind: 'config',
  scope: 'synchronized',
  followsBaseDir: true,
  transfer: 'config-export',
  // Module configuration is arbitrary module-owned JSON. Core has no safe
  // generic way to identify its secrets, so only an explicit future module
  // redaction contract may make it eligible for redacted exports.
  redaction: 'unredacted-only',
}

export function canTransferPersistentData(
  entry: PersistentDataEntry,
  redacted: boolean,
): boolean {
  return (
    entry.transfer === 'config-export' &&
    (!redacted || entry.redaction === 'supported')
  )
}

/**
 * Known domains are registered for ownership/scope visibility only. They do
 * not gain export behavior unless their entry explicitly says config-export.
 */
export const PERSISTENT_DATA_REGISTRY = [
  ...HOST_SETTINGS_CLASSIFICATIONS,
  HOST_SETTINGS_META,
  MODULE_CONFIG_PERSISTENT_DATA,
  {
    id: 'host.module-intent',
    owner: 'host',
    kind: 'config',
    scope: 'synchronized',
    followsBaseDir: true,
    transfer: 'excluded',
    redaction: 'none',
    reason: 'synchronized desired installation and enablement intent',
  },
  {
    id: 'module.private-synchronized',
    owner: 'module',
    kind: 'user-data',
    scope: 'synchronized',
    followsBaseDir: true,
    transfer: 'excluded',
    redaction: 'none',
    reason: 'module-private blob',
  },
  {
    id: 'module.device-local-installation-state',
    owner: 'module',
    kind: 'runtime-state',
    scope: 'device-local',
    followsBaseDir: false,
    transfer: 'excluded',
    redaction: 'none',
    reason: 'local module installation state',
  },
  {
    id: 'module.private-device-local',
    owner: 'module',
    kind: 'runtime-state',
    scope: 'device-local',
    followsBaseDir: false,
    transfer: 'excluded',
    redaction: 'none',
    reason: 'module-private device-local blobs',
  },
  {
    id: 'host.chat-history',
    owner: 'host',
    kind: 'user-data',
    scope: 'synchronized',
    followsBaseDir: true,
    transfer: 'excluded',
    redaction: 'none',
    reason: 'chat content and snapshots',
  },
  {
    id: 'host.memory',
    owner: 'host',
    kind: 'user-data',
    scope: 'synchronized',
    followsBaseDir: true,
    transfer: 'excluded',
    redaction: 'none',
    reason: 'user memory content',
  },
  {
    id: 'host.skills-and-snippets',
    owner: 'host',
    kind: 'user-data',
    scope: 'synchronized',
    followsBaseDir: true,
    transfer: 'excluded',
    redaction: 'none',
    reason: 'workspace content',
  },
  {
    id: 'host.vector-and-media-cache',
    owner: 'host',
    kind: 'cache',
    scope: 'synchronized',
    followsBaseDir: true,
    transfer: 'excluded',
    redaction: 'none',
    reason: 'vault-managed derived vector/image/PDF cache',
  },
  {
    id: 'module.learning-content',
    owner: 'module',
    kind: 'user-data',
    scope: 'synchronized',
    followsBaseDir: true,
    transfer: 'excluded',
    redaction: 'none',
    reason: 'Learning SRS content',
  },
] as const satisfies readonly PersistentDataEntry[]

export const EXPORTABLE_HOST_SETTINGS = HOST_SETTINGS_CLASSIFICATIONS.filter(
  (entry) => entry.transfer === 'config-export',
)

export const EXCLUDED_HOST_SETTINGS = HOST_SETTINGS_CLASSIFICATIONS.filter(
  (entry) => entry.transfer === 'excluded',
)
