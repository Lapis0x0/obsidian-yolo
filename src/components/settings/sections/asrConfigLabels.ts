import type {
  AsrConfig,
  AsrConfigCategory,
  AsrWebSocketProtocol,
} from '../../../settings/schema/setting.types'
import type { ObsidianDropdownOptionGroup } from '../../common/ObsidianDropdown'

const CATEGORY_ORDER: AsrConfigCategory[] = [
  'http-short-audio',
  'http-long-audio',
  'websocket',
]

const CATEGORY_LABEL: Record<AsrConfigCategory, string> = {
  'http-short-audio': 'HTTP short audio',
  'http-long-audio': 'HTTP long audio',
  websocket: 'WebSocket',
}

const WS_PROVIDER_LABEL: Record<AsrWebSocketProtocol, string> = {
  'deepgram-compatible': 'Deepgram',
  'whisperlivekit-native': 'WhisperLiveKit',
}

const LONG_PROVIDER_LABEL: Record<string, string> = {
  'funasr-local': 'FunASR local',
  'deepgram-prerecorded': 'Deepgram pre-recorded',
  'tencent-flash': 'Tencent Flash',
  'volcengine-auc-flash': 'Volcengine / Doubao Flash',
  'speechmatics-batch': 'Speechmatics Batch',
}

export function getAsrConfigCategory(config: AsrConfig): AsrConfigCategory {
  if (
    config.asrCategory === 'websocket' ||
    config.format === 'deepgram-compatible-websocket' ||
    config.webSocketProtocol === 'whisperlivekit-native' ||
    config.asrProvider === 'whisperlivekit-native'
  ) {
    return 'websocket'
  }
  if (config.asrCategory === 'http-long-audio') return 'http-long-audio'
  return config.asrCategory ?? 'http-short-audio'
}

export function isHttpShortAudioAsrConfig(config: AsrConfig | null): boolean {
  return config !== null && getAsrConfigCategory(config) === 'http-short-audio'
}

export function getAsrConfigCategoryLabel(category: AsrConfigCategory): string {
  return CATEGORY_LABEL[category]
}

export function formatAsrConfigDropdownLabel(
  config: AsrConfig,
  unnamedLabel: string,
  providerLabels: Partial<Record<string, string>> = {},
): string {
  const name = config.name.trim() || unnamedLabel
  const model = config.model.trim()
  const category = getAsrConfigCategory(config)
  const provider =
    category === 'websocket'
      ? WS_PROVIDER_LABEL[config.webSocketProtocol]
      : category === 'http-long-audio'
        ? (providerLabels[config.asrProvider] ??
          LONG_PROVIDER_LABEL[config.asrProvider])
        : ''
  const prefix = provider && !name.includes(provider) ? `${provider} · ` : ''

  return model ? `${prefix}${name} · ${model}` : `${prefix}${name}`
}

export function buildGroupedAsrConfigOptions(input: {
  configs: AsrConfig[]
  unnamedLabel: string
  includeCategories: AsrConfigCategory[]
  categoryLabels?: Partial<Record<AsrConfigCategory, string>>
  providerLabels?: Partial<Record<string, string>>
}): ObsidianDropdownOptionGroup[] {
  const include = new Set(input.includeCategories)
  return CATEGORY_ORDER.filter((category) => include.has(category))
    .map<ObsidianDropdownOptionGroup | null>((category) => {
      const options = input.configs
        .filter((config) => getAsrConfigCategory(config) === category)
        .map((config) => ({
          value: config.id,
          label: formatAsrConfigDropdownLabel(
            config,
            input.unnamedLabel,
            input.providerLabels,
          ),
        }))
      if (options.length === 0) return null
      return {
        label: input.categoryLabels?.[category] ?? CATEGORY_LABEL[category],
        options,
      }
    })
    .filter((group): group is ObsidianDropdownOptionGroup => group !== null)
}
