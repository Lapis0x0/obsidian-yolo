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
import { GripVertical } from 'lucide-react'
import { type CSSProperties, useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  hasConfiguredAsrConfig,
  hasConfiguredAudioFileAsrConfig,
} from '../../../core/asr/configStatus'
import { hasConfiguredTtsConfig } from '../../../core/tts/configStatus'
import type {
  ContextVoiceInputOptions,
  VoiceFloatingModeId,
} from '../../../settings/schema/setting.types'
import { VOICE_FLOATING_MODE_IDS } from '../../../settings/schema/setting.types'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

type ModeAvailability = {
  ready: boolean
  reason: string
}

type VoiceModeOrderItemProps = {
  mode: VoiceFloatingModeId
  label: string
  description: string
  visible: boolean
  ready: boolean
  dragHandleLabel: string
  onToggleVisible: (visible: boolean) => void
}

const MODE_LABEL_FALLBACK: Record<VoiceFloatingModeId, string> = {
  'toggle-listen': 'Click to dictate',
  'hold-to-talk': 'Hold to dictate',
  'audio-file': 'Audio file',
  'read-aloud': 'Read aloud',
}

export function VoiceFloatingIslandSettingsSection() {
  const { settings, setSettings } = useSettings()
  const plugin = usePlugin()
  const { t } = useLanguage()
  const voice = settings.contextVoiceInputOptions
  const [numberInputs, setNumberInputs] = useState({
    floatingIslandBottomOffsetVh: String(voice.floatingIslandBottomOffsetVh),
  })
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  const updateVoice = useCallback(
    (patch: Partial<ContextVoiceInputOptions>, context: string) => {
      void (async () => {
        try {
          const latestSettings = plugin.settings
          const latestVoice = latestSettings.contextVoiceInputOptions
          await setSettings({
            ...latestSettings,
            contextVoiceInputOptions: {
              ...latestVoice,
              ...patch,
            },
          })
        } catch (error: unknown) {
          console.error(
            `Failed to update floating voice island: ${context}`,
            error,
          )
        }
      })()
    },
    [plugin, setSettings],
  )

  const modeOrder = useMemo(() => {
    const seen = new Set<VoiceFloatingModeId>()
    const ordered: VoiceFloatingModeId[] = []
    for (const mode of voice.floatingIslandModeOrder ?? []) {
      if (VOICE_FLOATING_MODE_IDS.includes(mode) && !seen.has(mode)) {
        seen.add(mode)
        ordered.push(mode)
      }
    }
    for (const mode of VOICE_FLOATING_MODE_IDS) {
      if (!seen.has(mode)) {
        ordered.push(mode)
      }
    }
    return ordered
  }, [voice.floatingIslandModeOrder])

  const hiddenModes = useMemo(
    () => new Set<VoiceFloatingModeId>(voice.floatingIslandHiddenModes ?? []),
    [voice.floatingIslandHiddenModes],
  )

  const availability = useMemo<
    Record<VoiceFloatingModeId, ModeAvailability>
  >(() => {
    const dictationReady = voice.enabled && hasConfiguredAsrConfig(voice)
    const audioFileReady =
      voice.audioFileTranscriptionEnabled &&
      hasConfiguredAudioFileAsrConfig(voice)
    const readAloudReady =
      voice.voiceReadAloudEnabled && hasConfiguredTtsConfig(voice)
    return {
      'toggle-listen': {
        ready: dictationReady,
        reason: dictationReady
          ? ''
          : t(
              'settings.voiceIsland.dictationUnavailable',
              'Enable voice input and configure ASR first.',
            ),
      },
      'hold-to-talk': {
        ready: dictationReady,
        reason: dictationReady
          ? ''
          : t(
              'settings.voiceIsland.dictationUnavailable',
              'Enable voice input and configure ASR first.',
            ),
      },
      'audio-file': {
        ready: audioFileReady,
        reason: audioFileReady
          ? ''
          : t(
              'settings.voiceIsland.audioFileUnavailable',
              'Enable audio file transcription and configure ASR first.',
            ),
      },
      'read-aloud': {
        ready: readAloudReady,
        reason: readAloudReady
          ? ''
          : t(
              'settings.voiceIsland.readAloudUnavailable',
              'Enable read aloud and configure TTS first.',
            ),
      },
    }
  }, [t, voice])

  const normalizeModeOrder = (nextIds: string[]) => {
    const nextOrder = nextIds.filter((mode): mode is VoiceFloatingModeId =>
      VOICE_FLOATING_MODE_IDS.includes(mode as VoiceFloatingModeId),
    )
    for (const mode of VOICE_FLOATING_MODE_IDS) {
      if (!nextOrder.includes(mode)) {
        nextOrder.push(mode)
      }
    }
    return nextOrder
  }

  const handleModeDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const ids = modeOrder.map((mode) => mode)
    const oldIndex = ids.indexOf(active.id as VoiceFloatingModeId)
    const newIndex = ids.indexOf(over.id as VoiceFloatingModeId)
    if (oldIndex < 0 || newIndex < 0) return
    updateVoice(
      {
        floatingIslandModeOrder: normalizeModeOrder(
          arrayMove(ids, oldIndex, newIndex),
        ),
      },
      'modeOrder',
    )
  }

  const toggleModeHidden = (mode: VoiceFloatingModeId, visible: boolean) => {
    if (!availability[mode].ready) return
    const nextHidden = new Set(hiddenModes)
    if (visible) {
      nextHidden.delete(mode)
    } else {
      nextHidden.add(mode)
    }
    updateVoice({ floatingIslandHiddenModes: [...nextHidden] }, 'hiddenModes')
  }

  const parseNumber = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  return (
    <div className="yolo-settings-section yolo-settings-section--tight">
      <section className="yolo-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t('settings.voiceIsland.title', 'Floating voice island')}
            </div>
            <div className="yolo-settings-desc yolo-settings-block-desc">
              {t(
                'settings.voiceIsland.description',
                'Choose which voice modes appear in the editor floating control and in what order.',
              )}
            </div>
          </div>
        </div>

        <div className="yolo-settings-block-content">
          <ObsidianSetting
            name={t(
              'settings.voiceIsland.enable',
              'Show floating voice island',
            )}
            desc={t(
              'settings.voiceIsland.enableDesc',
              'The island appears only when at least one visible voice mode is enabled and configured.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={voice.floatingIslandEnabled}
              onChange={(value) =>
                updateVoice({ floatingIslandEnabled: value }, 'enabled')
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t(
              'settings.voiceIsland.bottomOffset',
              'Floating island bottom distance',
            )}
            desc={t(
              'settings.voiceIsland.bottomOffsetDesc',
              'Distance as a percentage of the viewport height. Default: 9.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianTextInput
              value={numberInputs.floatingIslandBottomOffsetVh}
              onChange={(value) => {
                setNumberInputs((state) => ({
                  ...state,
                  floatingIslandBottomOffsetVh: value,
                }))
                const parsed = parseNumber(value)
                if (parsed !== null && parsed >= 0 && parsed <= 50) {
                  updateVoice(
                    { floatingIslandBottomOffsetVh: parsed },
                    'bottomOffset',
                  )
                }
              }}
              placeholder="9"
            />
          </ObsidianSetting>

          <div className="yolo-voice-mode-order-card">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleModeDragEnd}
            >
              <SortableContext
                items={modeOrder}
                strategy={verticalListSortingStrategy}
              >
                {modeOrder.map((mode) => {
                  const modeAvailability = availability[mode]
                  const visible =
                    modeAvailability.ready && !hiddenModes.has(mode)
                  return (
                    <VoiceModeOrderItem
                      key={mode}
                      mode={mode}
                      label={t(
                        `settings.voiceIsland.mode.${mode}`,
                        MODE_LABEL_FALLBACK[mode],
                      )}
                      description={modeAvailability.reason}
                      visible={visible}
                      ready={modeAvailability.ready}
                      dragHandleLabel={t(
                        'settings.voiceIsland.dragHandle',
                        'Drag to reorder',
                      )}
                      onToggleVisible={(value) => toggleModeHidden(mode, value)}
                    />
                  )
                })}
              </SortableContext>
            </DndContext>
          </div>
        </div>
      </section>
    </div>
  )
}

function VoiceModeOrderItem({
  mode,
  label,
  description,
  visible,
  ready,
  dragHandleLabel,
  onToggleVisible,
}: VoiceModeOrderItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: mode, disabled: !ready })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={[
        'yolo-provider-section',
        'yolo-voice-mode-section',
        ready ? '' : 'is-disabled',
        isDragging ? 'yolo-provider-dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-mode-id={mode}
      {...attributes}
    >
      <div className="yolo-provider-header yolo-voice-mode-section__header">
        <button
          type="button"
          className="yolo-provider-drag-handle"
          aria-label={dragHandleLabel}
          disabled={!ready}
          {...listeners}
        >
          <GripVertical />
        </button>

        <div
          className={[
            'yolo-provider-info',
            'yolo-voice-mode-section__info',
            description ? '' : 'is-title-only',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="yolo-provider-id yolo-voice-mode-section__name">
            {label}
          </span>
          {description && (
            <span className="yolo-provider-type yolo-voice-mode-section__desc">
              {description}
            </span>
          )}
        </div>

        <div
          className="yolo-voice-mode-section__toggle"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <ObsidianToggle
            value={visible}
            disabled={!ready}
            onChange={onToggleVisible}
          />
        </div>
      </div>
    </div>
  )
}
