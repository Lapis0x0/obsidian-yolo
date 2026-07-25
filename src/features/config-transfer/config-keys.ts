import {
  EXCLUDED_HOST_SETTINGS,
  EXPORTABLE_HOST_SETTINGS,
  MODULE_CONFIG_PERSISTENT_DATA,
  MODULE_CONFIG_TRANSFER_KEY,
} from '../../core/persistence/persistentDataRegistry'

import type { ConfigKeyMeta } from './types'

/** Transfer UI entries are derived from the persistent-data catalog. */
export const EXPORTABLE_CONFIG_KEYS: readonly ConfigKeyMeta[] = [
  ...EXPORTABLE_HOST_SETTINGS.map((entry) => ({
    key: entry.settingsKey,
    fallbackLabel: entry.fallbackLabel!,
  })),
  {
    key: MODULE_CONFIG_TRANSFER_KEY,
    fallbackLabel: '模块配置',
    unredactedOnly:
      MODULE_CONFIG_PERSISTENT_DATA.redaction === 'unredacted-only',
  },
]

/** Host keys explicitly excluded by the persistence catalog plus file metadata. */
export const EXCLUDED_KEYS = new Set<string>([
  'version',
  '__meta',
  ...EXCLUDED_HOST_SETTINGS.map((entry) => entry.settingsKey),
])

export const HOST_CONFIG_KEYS = new Set<string>(
  EXPORTABLE_HOST_SETTINGS.map((entry) => entry.settingsKey),
)
