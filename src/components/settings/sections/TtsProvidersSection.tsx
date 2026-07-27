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
import type { CSSProperties } from 'react'
import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import YoloPlugin from '../../../main'
import type {
  TtsApiFormat,
  TtsConfig,
} from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ConfirmModal } from '../../modals/ConfirmModal'
import {
  AddTtsConfigModal,
  EditTtsConfigModal,
} from '../modals/TtsConfigFormModal'

type TtsProvidersSectionProps = {
  app: App
  plugin: YoloPlugin
}

type Translator = ReturnType<typeof useLanguage>['t']

const FORMAT_LABEL: Record<TtsApiFormat, string> = {
  'openai-compatible-speech': 'OpenAI-compatible',
  'mimo-chat-audio-tts': 'MiMo',
  'dashscope-cosyvoice': 'DashScope CosyVoice',
  'volcengine-tts-http': 'Volcengine TTS',
}

function summariseConfig(config: TtsConfig): string {
  return [
    FORMAT_LABEL[config.format] ?? config.format,
    config.model,
    config.voice,
    config.outputFormat,
  ]
    .filter(Boolean)
    .join(' · ')
}

function TtsConfigRow({
  config,
  activeId,
  t,
  onEdit,
  onDelete,
}: {
  config: TtsConfig
  activeId: string
  t: Translator
  onEdit: (config: TtsConfig) => void
  onDelete: (config: TtsConfig) => void
}) {
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
          aria-label={t('settings.tts.dragHandle', 'Drag to reorder')}
        >
          <GripVertical />
        </button>
      </td>
      <td>
        {config.name || t('settings.tts.unnamedConfig', '(unnamed)')}
        {config.id === activeId && (
          <span className="yolo-asr-active-pill">
            {t('settings.tts.activePillLabel', 'read aloud')}
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
            aria-label={t('settings.tts.editConfigAria', 'Edit configuration')}
          >
            <Settings />
          </button>
          <button
            type="button"
            className="clickable-icon"
            onClick={() => onDelete(config)}
            aria-label={t(
              'settings.tts.deleteConfigAria',
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

export function TtsProvidersSection({ app, plugin }: TtsProvidersSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const voice = settings.contextVoiceInputOptions
  const configs = useMemo(() => voice.ttsConfigs ?? [], [voice.ttsConfigs])
  const activeId =
    voice.activeTtsConfigId &&
    configs.some((config) => config.id === voice.activeTtsConfigId)
      ? voice.activeTtsConfigId
      : (configs[0]?.id ?? '')
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  const persistConfigs = async (
    nextConfigs: TtsConfig[],
    preferredActiveId = activeId,
  ): Promise<void> => {
    const nextActiveId =
      preferredActiveId &&
      nextConfigs.some((config) => config.id === preferredActiveId)
        ? preferredActiveId
        : (nextConfigs[0]?.id ?? '')
    await setSettings({
      ...plugin.settings,
      contextVoiceInputOptions: {
        ...plugin.settings.contextVoiceInputOptions,
        ttsConfigs: nextConfigs,
        activeTtsConfigId: nextActiveId,
      },
    })
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const oldIndex = configs.findIndex((config) => config.id === active.id)
    const newIndex = configs.findIndex((config) => config.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    void persistConfigs(arrayMove(configs, oldIndex, newIndex)).catch(
      (error) => {
        console.error('Failed to reorder TTS configs', error)
        new Notice(
          t('settings.tts.reorderFailed', 'Failed to reorder TTS configs.'),
        )
      },
    )
  }

  const handleDelete = (config: TtsConfig) => {
    new ConfirmModal(app, {
      title: t('settings.tts.deleteConfigTitle', 'Delete TTS configuration'),
      message: `${t('settings.tts.deleteConfigMessagePrefix', 'Delete')} "${config.name || config.id}"?`,
      ctaText: t('common.delete', 'Delete'),
      onConfirm: () => {
        void persistConfigs(
          configs.filter((item) => item.id !== config.id),
          activeId,
        ).catch((error) => {
          console.error('Failed to delete TTS config', error)
          new Notice(
            t('settings.tts.deleteFailed', 'Failed to delete TTS config.'),
          )
        })
      },
    }).open()
  }

  return (
    <div className="yolo-settings-section yolo-settings-section--tight">
      <section className="yolo-settings-block yolo-asr-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t('settings.tts.title', 'Speech generation (TTS)')}
            </div>
            <div className="yolo-settings-desc yolo-settings-block-desc">
              {t(
                'settings.tts.description',
                'Configure text-to-speech endpoints used by read aloud.',
              )}
            </div>
          </div>
          <div className="yolo-settings-block-action">
            <ObsidianButton
              text={t('settings.tts.addConfig', 'Add TTS')}
              onClick={() => new AddTtsConfigModal(app, plugin).open()}
              cta
            />
          </div>
        </div>

        <div className="yolo-settings-block-content">
          <div className="yolo-asr-route-block yolo-tts-route-block">
            {configs.length > 0 ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={(event) => handleDragEnd(event)}
              >
                <SortableContext
                  items={configs.map((config) => config.id)}
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
                        <th>{t('settings.tts.colName', 'Name')}</th>
                        <th>
                          {t('settings.tts.colSummary', 'Format · voice')}
                        </th>
                        <th>{t('settings.tts.colActions', 'Actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {configs.map((config) => (
                        <TtsConfigRow
                          key={config.id}
                          config={config}
                          activeId={activeId}
                          t={t}
                          onEdit={(item) =>
                            new EditTtsConfigModal(app, plugin, item).open()
                          }
                          onDelete={handleDelete}
                        />
                      ))}
                    </tbody>
                  </table>
                </SortableContext>
              </DndContext>
            ) : (
              <div className="yolo-no-models">
                {t('settings.tts.empty', 'No TTS provider configured.')}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
