import { GripVertical, Settings, Trash2 } from 'lucide-react'
import { App, Notice } from 'obsidian'
import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import YoloPlugin from '../../../main'
import type {
  AsrApiFormat,
  AsrConfig,
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

const FORMAT_LABEL: Record<AsrApiFormat, string> = {
  'openai-compatible-transcription': 'Transcription',
  'openai-compatible-chat-audio-asr': 'Chat audio ASR',
}

const summariseConfig = (config: AsrConfig): string => {
  const parts: string[] = []
  parts.push(FORMAT_LABEL[config.format] ?? config.format)
  if (config.model) parts.push(config.model)
  if (config.audioFormat === 'wav') parts.push('wav')
  return parts.join(' · ')
}

export function AsrProvidersSection({ app, plugin }: AsrProvidersSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const voice = settings.contextVoiceInputOptions
  const configs: AsrConfig[] = voice.asrConfigs ?? []
  // Active selection is picked under Editor → Voice input now. We still
  // resolve it here so persistConfigs can keep the id valid when entries
  // get reordered or removed.
  const activeId =
    voice.activeAsrConfigId &&
    configs.some((c) => c.id === voice.activeAsrConfigId)
      ? voice.activeAsrConfigId
      : (configs[0]?.id ?? '')

  const dragIndexRef = useRef<number | null>(null)
  const dragOverRowRef = useRef<HTMLTableRowElement | null>(null)
  const lastDropPosRef = useRef<'before' | 'after' | null>(null)
  const lastInsertIndexRef = useRef<number | null>(null)
  const [micDevices, setMicDevices] = useState<MicDevice[]>([])
  const [micEnumerationLabelsBlocked, setMicEnumerationLabelsBlocked] =
    useState(false)

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
      const label = device.label || `Microphone ${index + 1}`
      out[device.deviceId] = label
    })
    return out
  }, [micDevices, t])

  const persistConfigs = useCallback(
    async (
      nextConfigs: AsrConfig[],
      nextActiveId: string = activeId,
    ): Promise<void> => {
      await setSettings({
        ...settings,
        contextVoiceInputOptions: {
          ...voice,
          asrConfigs: nextConfigs,
          activeAsrConfigId:
            nextActiveId && nextConfigs.some((c) => c.id === nextActiveId)
              ? nextActiveId
              : (nextConfigs[0]?.id ?? ''),
        },
      })
    },
    [settings, setSettings, voice, activeId],
  )

  const handleDelete = (config: AsrConfig) => {
    const message = `Delete "${config.name || config.id}"?`
    new ConfirmModal(app, {
      title: 'Delete ASR configuration',
      message,
      ctaText: 'Delete',
      onConfirm: () => {
        void (async () => {
          try {
            const next = configs.filter((c) => c.id !== config.id)
            await persistConfigs(next)
          } catch (error: unknown) {
            console.error('Failed to delete ASR config', error)
            new Notice('Failed to delete ASR config.')
          }
        })()
      },
    }).open()
  }

  const handleEdit = (config: AsrConfig) => {
    new EditAsrConfigModal(app, plugin, config).open()
  }

  const handleAdd = () => {
    new AddAsrConfigModal(app, plugin).open()
  }

  const handleMicChange = (value: string) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          contextVoiceInputOptions: {
            ...voice,
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

  const clearDragOverIndicator = () => {
    if (dragOverRowRef.current) {
      dragOverRowRef.current.classList.remove(
        'yolo-row-drag-over-before',
        'yolo-row-drag-over-after',
      )
      dragOverRowRef.current = null
    }
  }

  const handleDragStart = (
    event: DragEvent<HTMLTableRowElement>,
    index: number,
  ) => {
    dragIndexRef.current = index
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', configs[index]?.id ?? '')
      event.dataTransfer.effectAllowed = 'move'
    }
    event.currentTarget.classList.add('yolo-row-dragging')
    const handle = event.currentTarget.querySelector('.yolo-drag-handle')
    if (handle) handle.classList.add('yolo-drag-handle--active')
  }

  const handleDragOver = (
    event: DragEvent<HTMLTableRowElement>,
    targetIndex: number,
  ) => {
    // preventDefault + matching dropEffect together are what actually arm the
    // row as a drop target. Dropping `dropEffect = 'move'` here was the bug
    // that made reordering look non-functional.
    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move'
    }
    if (dragIndexRef.current === null) return

    const row = event.currentTarget
    const rect = row.getBoundingClientRect()
    const rel = (event.clientY - rect.top) / rect.height

    if (dragIndexRef.current === targetIndex) {
      row.classList.remove(
        'yolo-row-drag-over-before',
        'yolo-row-drag-over-after',
      )
      if (dragOverRowRef.current && dragOverRowRef.current !== row) {
        dragOverRowRef.current.classList.remove(
          'yolo-row-drag-over-before',
          'yolo-row-drag-over-after',
        )
      }
      dragOverRowRef.current = row
      lastDropPosRef.current = null
      lastInsertIndexRef.current = null
      return
    }

    const hysteresis = 0.05
    let dropAfter: boolean
    if (lastDropPosRef.current) {
      if (rel > 0.5 + hysteresis) dropAfter = true
      else if (rel < 0.5 - hysteresis) dropAfter = false
      else dropAfter = lastDropPosRef.current === 'after'
    } else {
      dropAfter = rel > 0.5
    }

    const sourceIndex = dragIndexRef.current
    let insertIndex = targetIndex + (dropAfter ? 1 : 0)
    if (sourceIndex < targetIndex) insertIndex -= 1
    if (lastInsertIndexRef.current === insertIndex) return

    if (dragOverRowRef.current) {
      dragOverRowRef.current.classList.remove(
        'yolo-row-drag-over-before',
        'yolo-row-drag-over-after',
      )
    }

    row.classList.remove(
      'yolo-row-drag-over-before',
      'yolo-row-drag-over-after',
    )
    row.classList.add(
      dropAfter ? 'yolo-row-drag-over-after' : 'yolo-row-drag-over-before',
    )
    dragOverRowRef.current = row
    lastDropPosRef.current = dropAfter ? 'after' : 'before'
    lastInsertIndexRef.current = insertIndex
  }

  const handleDragEnd = () => {
    dragIndexRef.current = null
    clearDragOverIndicator()
    lastDropPosRef.current = null
    lastInsertIndexRef.current = null
    const dragging = document.querySelector('tr.yolo-row-dragging')
    if (dragging) dragging.classList.remove('yolo-row-dragging')
    const activeHandle = document.querySelector(
      '.yolo-drag-handle.yolo-drag-handle--active',
    )
    if (activeHandle) activeHandle.classList.remove('yolo-drag-handle--active')
  }

  const handleDrop = (
    event: DragEvent<HTMLTableRowElement>,
    targetIndex: number,
  ) => {
    event.preventDefault()
    const sourceIndex = dragIndexRef.current
    dragIndexRef.current = null
    clearDragOverIndicator()
    if (sourceIndex === null || sourceIndex === targetIndex) return

    const rect = event.currentTarget.getBoundingClientRect()
    const dropAfter = event.clientY - rect.top > rect.height / 2

    void (async () => {
      try {
        const next = [...configs]
        const [moved] = next.splice(sourceIndex, 1)
        if (!moved) return
        let insertIndex = targetIndex + (dropAfter ? 1 : 0)
        if (sourceIndex < insertIndex) insertIndex -= 1
        if (insertIndex < 0) insertIndex = 0
        if (insertIndex > next.length) insertIndex = next.length
        next.splice(insertIndex, 0, moved)
        await persistConfigs(next)
        triggerDropSuccess(moved.id)
      } catch (error: unknown) {
        console.error('Failed to reorder ASR configs', error)
      } finally {
        handleDragEnd()
      }
    })()
  }

  return (
    <div className="yolo-settings-section yolo-settings-section--tight">
      <section className="yolo-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t('settings.asr.title', 'Voice recognition (ASR)')}
            </div>
            <div className="yolo-settings-desc yolo-settings-block-desc">
              {t(
                'settings.asr.descriptionV2',
                'Each entry is one ASR endpoint. The radio button picks which one is used at runtime; click the gear to edit fields, drag the handle to reorder. The polish LLM is selected separately under Editor → Voice input.',
              )}
            </div>
          </div>
          <div className="yolo-settings-block-action">
            <ObsidianButton
              text={t('settings.asr.addConfig', 'Add ASR configuration')}
              onClick={handleAdd}
              cta
            />
          </div>
        </div>

        <div className="yolo-settings-block-content">
          <div className="yolo-settings-table-container">
            <table className="yolo-settings-table">
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
                {configs.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ color: 'var(--text-muted)' }}>
                      {t(
                        'settings.asr.emptyHint',
                        'No ASR endpoint configured yet. Use the add button above.',
                      )}
                    </td>
                  </tr>
                )}
                {configs.map((config, index) => (
                  <tr
                    key={config.id}
                    data-config-id={config.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDrop={(e) => handleDrop(e, index)}
                    onDragEnd={handleDragEnd}
                  >
                    <td>
                      <span
                        className="yolo-drag-handle"
                        aria-label="Drag to reorder"
                      >
                        <GripVertical />
                      </span>
                    </td>
                    <td>
                      {config.name || '(unnamed)'}
                      {config.id === activeId && (
                        <span
                          className="yolo-asr-active-pill"
                          title={t(
                            'settings.asr.activePill',
                            'Currently used by voice input',
                          )}
                        >
                          {t('settings.asr.activePillLabel', 'in use')}
                        </span>
                      )}
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>
                      {summariseConfig(config)}
                    </td>
                    <td>
                      <div className="yolo-settings-actions">
                        <button
                          type="button"
                          className="clickable-icon"
                          onClick={() => handleEdit(config)}
                          aria-label="Edit configuration"
                        >
                          <Settings />
                        </button>
                        <button
                          type="button"
                          className="clickable-icon"
                          onClick={() => handleDelete(config)}
                          aria-label="Delete configuration"
                        >
                          <Trash2 />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
