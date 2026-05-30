import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Settings, Trash2 } from 'lucide-react'
import { App, Notice } from 'obsidian'
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import YoloPlugin from '../../../main'
import {
  ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
  type AsrApiFormat,
  type AsrConfig,
  type AsrConfigCategory,
  type AsrWebSocketProtocol,
} from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ConfirmModal } from '../../modals/ConfirmModal'
import {
  AddAsrConfigModal,
  EditAsrConfigModal,
} from '../modals/AsrConfigFormModal'

type AsrProvidersSectionProps = {
  app: App
  plugin: YoloPlugin
}

type MicDevice = { deviceId: string; label: string }
type Translator = ReturnType<typeof useLanguage>['t']

const CATEGORY_ORDER: AsrConfigCategory[] = [
  'http-short-audio',
  'http-long-audio',
  'websocket',
]

const FORMAT_LABEL: Record<AsrApiFormat, string> = {
  'openai-compatible-transcription': 'Transcription',
  'openai-compatible-chat-audio-asr': 'Chat audio ASR',
  'deepgram-compatible-websocket': 'WebSocket',
}

const WS_PROVIDER_LABEL: Record<AsrWebSocketProtocol, string> = {
  'deepgram-compatible': 'Deepgram',
  'whisperlivekit-native': 'WhisperLiveKit',
}

const LONG_PROVIDER_LABEL: Record<string, string> = {
  'funasr-local': 'FunASR local',
  'deepgram-prerecorded': 'Deepgram pre-recorded',
  'speechmatics-batch': 'Speechmatics Batch',
}

const isWebSocketConfig = (config: AsrConfig): boolean =>
  config.asrCategory === 'websocket' ||
  config.format === 'deepgram-compatible-websocket' ||
  config.webSocketProtocol === 'whisperlivekit-native' ||
  config.asrProvider === 'whisperlivekit-native'

const inferCategory = (config: AsrConfig): AsrConfigCategory => {
  if (isWebSocketConfig(config)) return 'websocket'
  if (config.asrCategory === 'http-long-audio') return 'http-long-audio'
  return config.asrCategory ?? 'http-short-audio'
}

const isSelectableAsrConfig = (config: AsrConfig): boolean =>
  inferCategory(config) !== 'http-long-audio'

const providerLabel = (config: AsrConfig): string => {
  const category = inferCategory(config)
  if (category === 'websocket') {
    return WS_PROVIDER_LABEL[config.webSocketProtocol] ?? config.asrProvider
  }
  if (category === 'http-long-audio') {
    return LONG_PROVIDER_LABEL[config.asrProvider] ?? config.asrProvider
  }
  return FORMAT_LABEL[config.format] ?? config.format
}

const summariseConfig = (config: AsrConfig): string => {
  const parts: string[] = [providerLabel(config)]
  if (config.model) parts.push(config.model)
  if (
    config.audioFormat === 'wav' &&
    config.format !== 'deepgram-compatible-websocket'
  ) {
    parts.push('wav')
  }
  return parts.filter(Boolean).join(' · ')
}

const groupConfigs = (
  configs: AsrConfig[],
): Record<AsrConfigCategory, AsrConfig[]> => ({
  'http-short-audio': configs.filter(
    (config) => inferCategory(config) === 'http-short-audio',
  ),
  'http-long-audio': configs.filter(
    (config) => inferCategory(config) === 'http-long-audio',
  ),
  websocket: configs.filter((config) => inferCategory(config) === 'websocket'),
})

const sectionTitle = (category: AsrConfigCategory): string => {
  switch (category) {
    case 'http-short-audio':
      return 'HTTP short audio'
    case 'http-long-audio':
      return 'HTTP long audio'
    case 'websocket':
      return 'WebSocket'
  }
}

const sectionEmptyText = (category: AsrConfigCategory): string => {
  switch (category) {
    case 'http-short-audio':
      return 'No short-audio HTTP provider configured.'
    case 'http-long-audio':
      return 'No long-audio HTTP provider configured.'
    case 'websocket':
      return 'No WebSocket provider configured.'
  }
}

const normalizeConfigForEdit = (config: AsrConfig): AsrConfig => {
  if (inferCategory(config) !== 'websocket') return config
  const webSocketProtocol: AsrWebSocketProtocol =
    config.webSocketProtocol === 'whisperlivekit-native' ||
    config.asrProvider === 'whisperlivekit-native'
      ? 'whisperlivekit-native'
      : (config.webSocketProtocol ?? 'deepgram-compatible')
  return {
    ...config,
    asrCategory: 'websocket',
    format: 'deepgram-compatible-websocket',
    webSocketProtocol,
    asrProvider:
      webSocketProtocol === 'whisperlivekit-native'
        ? 'whisperlivekit'
        : config.asrProvider || 'deepgram',
    webSocketFileStreamingRate:
      config.webSocketFileStreamingRate ??
      ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
    transportMode: 'browser',
  }
}

type AsrConfigRowProps = {
  config: AsrConfig
  activeId: string
  activeAudioFileId: string
  t: Translator
  onEdit: (config: AsrConfig) => void
  onDelete: (config: AsrConfig) => void
}

function AsrConfigRow({
  config,
  activeId,
  activeAudioFileId,
  t,
  onEdit,
  onDelete,
}: AsrConfigRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: config.id })

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={isDragging ? 'yolo-row-dragging' : ''}
      data-config-id={config.id}
      {...attributes}
      {...listeners}
    >
      <td>
        <button
          type="button"
          className="yolo-drag-handle"
          aria-label={t('settings.asr.dragHandle', 'Drag to reorder')}
        >
          <GripVertical />
        </button>
      </td>
      <td>
        {config.name || t('settings.asr.unnamedConfig', '(unnamed)')}
        {config.id === activeId && (
          <span
            className="yolo-asr-active-pill"
            title={t('settings.asr.activePill', 'Selected for voice input')}
          >
            {t('settings.asr.activePillLabel', 'voice')}
          </span>
        )}
        {config.id === activeAudioFileId && (
          <span
            className="yolo-asr-active-pill"
            title={t(
              'settings.asr.audioFileActivePill',
              'Selected for audio file transcription',
            )}
          >
            {t('settings.asr.audioFileActivePillLabel', 'audio file')}
          </span>
        )}
      </td>
      <td style={{ color: 'var(--text-muted)' }}>{summariseConfig(config)}</td>
      <td onPointerDown={(event) => event.stopPropagation()}>
        <div className="yolo-settings-actions">
          <button
            type="button"
            className="clickable-icon"
            onClick={() => onEdit(config)}
            aria-label={t('settings.asr.editConfigAria', 'Edit configuration')}
          >
            <Settings />
          </button>
          <button
            type="button"
            className="clickable-icon"
            onClick={() => onDelete(config)}
            aria-label={t(
              'settings.asr.deleteConfigAria',
              'Delete configuration',
            )}
          >
            <Trash2 />
          </button>
        </div>
      </td>
    </tr>
  )
}

export function AsrProvidersSection({ app, plugin }: AsrProvidersSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const voice = settings.contextVoiceInputOptions
  const configs: AsrConfig[] = voice.asrConfigs ?? []
  const selectableConfigs = configs.filter(isSelectableAsrConfig)
  // Long-audio configs are displayed here for the upcoming native adapters,
  // but they should not become the active short/streaming ASR by accident.
  const activeId =
    voice.activeAsrConfigId &&
    selectableConfigs.some((c) => c.id === voice.activeAsrConfigId)
      ? voice.activeAsrConfigId
      : (selectableConfigs[0]?.id ?? '')
  const activeAudioFileId =
    voice.activeAudioFileAsrConfigId &&
    configs.some((c) => c.id === voice.activeAudioFileAsrConfigId)
      ? voice.activeAudioFileAsrConfigId
      : (configs[0]?.id ?? activeId)

  const [micDevices, setMicDevices] = useState<MicDevice[]>([])
  const [micEnumerationLabelsBlocked, setMicEnumerationLabelsBlocked] =
    useState(false)
  const configSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  const groupedConfigs = useMemo(() => groupConfigs(configs), [configs])

  const refreshMicDevices = useCallback(async () => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.enumerateDevices !== 'function'
    ) {
      return
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const mics = devices
        .filter((d) => d.kind === 'audioinput')
        .map<MicDevice>((d) => ({
          deviceId: d.deviceId,
          label: d.label || '',
        }))
      setMicDevices(mics)
      setMicEnumerationLabelsBlocked(
        mics.length > 0 && mics.every((m) => m.label.length === 0),
      )
    } catch (error) {
      console.error('Failed to enumerate microphones', error)
    }
  }, [])

  useEffect(() => {
    void refreshMicDevices()
    if (
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.addEventListener === 'function'
    ) {
      const handler = () => void refreshMicDevices()
      navigator.mediaDevices.addEventListener('devicechange', handler)
      return () => {
        navigator.mediaDevices?.removeEventListener?.('devicechange', handler)
      }
    }
  }, [refreshMicDevices])

  const unlockMicLabels = useCallback(async () => {
    if (!navigator?.mediaDevices?.getUserMedia) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      await refreshMicDevices()
    } catch (error) {
      console.error('Mic permission grant failed', error)
    }
  }, [refreshMicDevices])

  const micOptions = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {
      '': t('settings.asr.micDefault', 'System default'),
    }
    micDevices.forEach((device, index) => {
      const label =
        device.label ||
        `${t('settings.asr.microphoneFallbackName', 'Microphone')} ${index + 1}`
      out[device.deviceId] = label
    })
    return out
  }, [micDevices, t])

  const persistConfigs = useCallback(
    async (nextConfigs: AsrConfig[]): Promise<void> => {
      const latestSettings = plugin.settings
      const latestVoice = latestSettings.contextVoiceInputOptions
      const latestConfigs = latestVoice.asrConfigs ?? []
      const visibleIds = new Set(configs.map((config) => config.id))
      const latestById = new Map(
        latestConfigs.map((config) => [config.id, config]),
      )
      const rehydratedConfigs = nextConfigs.map(
        (config) => latestById.get(config.id) ?? config,
      )
      const nextIds = new Set(rehydratedConfigs.map((config) => config.id))
      const concurrentConfigs = latestConfigs.filter(
        (config) => !visibleIds.has(config.id) && !nextIds.has(config.id),
      )
      const mergedConfigs = [...rehydratedConfigs, ...concurrentConfigs]
      const selectable = mergedConfigs.filter(isSelectableAsrConfig)
      const preferredActiveId = latestVoice.activeAsrConfigId || activeId
      const nextActiveId =
        preferredActiveId &&
        selectable.some((config) => config.id === preferredActiveId)
          ? preferredActiveId
          : (selectable[0]?.id ?? '')
      const preferredAudioFileId =
        latestVoice.activeAudioFileAsrConfigId || activeAudioFileId
      const nextAudioFileId =
        preferredAudioFileId &&
        mergedConfigs.some((config) => config.id === preferredAudioFileId)
          ? preferredAudioFileId
          : (mergedConfigs[0]?.id ?? nextActiveId)

      await setSettings({
        ...latestSettings,
        contextVoiceInputOptions: {
          ...latestVoice,
          asrConfigs: mergedConfigs,
          activeAsrConfigId: nextActiveId,
          activeAudioFileAsrConfigId: nextAudioFileId,
        },
      })
    },
    [activeAudioFileId, activeId, configs, plugin, setSettings],
  )

  const handleDelete = (config: AsrConfig) => {
    const message = `${t(
      'settings.asr.deleteConfigMessagePrefix',
      'Delete',
    )} "${config.name || config.id}"?`
    new ConfirmModal(app, {
      title: t('settings.asr.deleteConfigTitle', 'Delete ASR configuration'),
      message,
      ctaText: t('common.delete', 'Delete'),
      onConfirm: () => {
        void (async () => {
          try {
            const next = configs.filter((c) => c.id !== config.id)
            await persistConfigs(next)
          } catch (error: unknown) {
            console.error('Failed to delete ASR config', error)
            new Notice(
              t('settings.asr.deleteConfigFailed', 'Failed to delete ASR.'),
            )
          }
        })()
      },
    }).open()
  }

  const handleEdit = (config: AsrConfig) => {
    new EditAsrConfigModal(app, plugin, normalizeConfigForEdit(config)).open()
  }

  const handleAdd = (category: AsrConfigCategory) => {
    new AddAsrConfigModal(app, plugin, category).open()
  }

  const handleMicChange = (value: string) => {
    void (async () => {
      try {
        const latestSettings = plugin.settings
        const latestVoice = latestSettings.contextVoiceInputOptions
        await setSettings({
          ...latestSettings,
          contextVoiceInputOptions: {
            ...latestVoice,
            microphoneDeviceId: value,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to update microphone device', error)
      }
    })()
  }

  const triggerDropSuccess = (movedId: string) => {
    const escapedId = window.CSS?.escape
      ? window.CSS.escape(movedId)
      : movedId.replace(/"/g, '\\"')
    const tryFind = (attempt = 0) => {
      const movedRow = document.querySelector(
        `tr[data-config-id="${escapedId}"]`,
      )
      if (movedRow) {
        movedRow.classList.add('yolo-row-drop-success')
        window.setTimeout(() => {
          movedRow.classList.remove('yolo-row-drop-success')
        }, 700)
      } else if (attempt < 8) {
        window.setTimeout(() => tryFind(attempt + 1), 50)
      }
    }
    requestAnimationFrame(() => tryFind())
  }

  const handleConfigDragEnd = async (
    category: AsrConfigCategory,
    { active, over }: DragEndEvent,
  ) => {
    if (!over || active.id === over.id) return

    const activeConfigId = String(active.id)
    const overConfigId = String(over.id)
    const rows = groupedConfigs[category]
    const oldIndex = rows.findIndex((config) => config.id === activeConfigId)
    const newIndex = rows.findIndex((config) => config.id === overConfigId)
    if (oldIndex < 0 || newIndex < 0) return

    try {
      const nextGrouped = {
        ...groupedConfigs,
        [category]: arrayMove(rows, oldIndex, newIndex),
      }
      await persistConfigs(
        CATEGORY_ORDER.flatMap((section) => nextGrouped[section]),
      )
      triggerDropSuccess(activeConfigId)
    } catch (error: unknown) {
      console.error('Failed to reorder ASR configs', error)
      new Notice(
        t('settings.asr.reorderConfigFailed', 'Failed to reorder ASR.'),
      )
    }
  }

  const renderProviderGroup = (category: AsrConfigCategory) => {
    const rows = groupedConfigs[category]
    const items = rows.map((config) => config.id)

    return (
      <div className="yolo-asr-route-block" key={category}>
        <div className="yolo-models-subsection-header">
          <span>
            {t(`settings.asr.sectionTitle.${category}`, sectionTitle(category))}
          </span>
          <button
            type="button"
            className="yolo-add-model-btn"
            onClick={() => handleAdd(category)}
          >
            {t('settings.asr.addConfigShort', '+ Add')}
          </button>
        </div>

        <div>
          {rows.length > 0 ? (
            <DndContext
              sensors={configSensors}
              collisionDetection={closestCenter}
              onDragEnd={(event) => void handleConfigDragEnd(category, event)}
            >
              <SortableContext
                items={items}
                strategy={verticalListSortingStrategy}
              >
                <table className="yolo-models-table yolo-asr-configs-table">
                  <colgroup>
                    <col width={16} />
                    <col />
                    <col />
                    <col width={90} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th></th>
                      <th>{t('settings.asr.colName', 'Name')}</th>
                      <th>{t('settings.asr.colSummary', 'Format · model')}</th>
                      <th>{t('settings.asr.colActions', 'Actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((config) => (
                      <AsrConfigRow
                        key={config.id}
                        config={config}
                        activeId={activeId}
                        activeAudioFileId={activeAudioFileId}
                        t={t}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                      />
                    ))}
                  </tbody>
                </table>
              </SortableContext>
            </DndContext>
          ) : (
            <div className="yolo-no-models">
              {t(
                `settings.asr.sectionEmpty.${category}`,
                sectionEmptyText(category),
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="yolo-settings-section yolo-settings-section--tight">
      <section className="yolo-settings-block yolo-asr-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t('settings.asr.title', 'Voice recognition (ASR)')}
            </div>
            <div className="yolo-settings-desc yolo-settings-block-desc">
              {t(
                'settings.asr.descriptionV3',
                'Voice providers are grouped by short HTTP, long HTTP, and WebSocket routes. Choose active providers under Editor → Voice input and Editor → Audio file transcription.',
              )}
            </div>
          </div>
        </div>

        <div className="yolo-settings-block-content">
          {CATEGORY_ORDER.map(renderProviderGroup)}

          <ObsidianSetting
            name={t('settings.asr.microphone', 'Microphone')}
            desc={t(
              'settings.asr.microphoneDesc',
              'Pick a specific input device. Labels appear after granting microphone permission once — use the unlock button if they show as "Microphone 1/2/...".',
            )}
            className="yolo-models-select-card"
          >
            <ObsidianDropdown
              value={voice.microphoneDeviceId ?? ''}
              options={micOptions}
              onChange={handleMicChange}
            />
          </ObsidianSetting>

          {micEnumerationLabelsBlocked && (
            <ObsidianSetting
              name={t(
                'settings.asr.microphoneUnlock',
                'Unlock microphone labels',
              )}
              desc={t(
                'settings.asr.microphoneUnlockDesc',
                'Grants the mic permission once so the device names become visible. Audio is not recorded.',
              )}
              className="yolo-models-select-card"
            >
              <ObsidianButton
                text={t('settings.asr.microphoneUnlockButton', 'Grant')}
                onClick={() => void unlockMicLabels()}
              />
            </ObsidianSetting>
          )}
        </div>
      </section>
    </div>
  )
}
