import { useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { hasConfiguredAsrConfig } from '../../../core/asr/configStatus'
import type {
  AudioFileChunkHeaderMode,
  AudioFileOutputMetadataMode,
  ContextVoiceInputOptions,
} from '../../../settings/schema/setting.types'
import {
  AUDIO_FILE_CHUNK_HEADER_MODES,
  AUDIO_FILE_OUTPUT_METADATA_MODES,
} from '../../../settings/schema/setting.types'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

const AUDIO_FILE_CHUNK_HEADER_LABEL_FALLBACK: Record<
  AudioFileChunkHeaderMode,
  string
> = {
  none: 'No chunk headers',
  'local-start-time': 'Local start time',
}

const AUDIO_FILE_METADATA_LABEL_FALLBACK: Record<
  AudioFileOutputMetadataMode,
  string
> = {
  none: 'Body only',
  title: 'Title',
  full: 'Full metadata',
}

export function AudioFileTranscriptionSection() {
  const { settings, setSettings } = useSettings()
  const plugin = usePlugin()
  const { t } = useLanguage()
  const voice = settings.contextVoiceInputOptions
  const asrReady = hasConfiguredAsrConfig(voice)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [numberInputs, setNumberInputs] = useState({
    audioFileChunkTargetDurationSec: String(
      voice.audioFileChunkTargetDurationSec,
    ),
    audioFileMaxConcurrentChunks: String(voice.audioFileMaxConcurrentChunks),
    audioFileChunkStartStaggerMs: String(voice.audioFileChunkStartStaggerMs),
    audioFileChunkOverlapMs: String(voice.audioFileChunkOverlapMs),
  })

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
            `Failed to update audio file transcription settings: ${context}`,
            error,
          )
        }
      })()
    },
    [plugin, setSettings],
  )

  const asrConfigs = voice.asrConfigs ?? []
  const asrProviderOptions = useMemo<Record<string, string>>(() => {
    if (asrConfigs.length === 0) {
      return {
        '': t(
          'settings.contextVoiceInput.asrProviderNone',
          '(none — add one under Models → Voice recognition)',
        ),
      }
    }
    return Object.fromEntries(
      asrConfigs.map((config) => [
        config.id,
        `${config.name || '(unnamed)'} · ${config.model || config.format}`,
      ]),
    )
  }, [asrConfigs, t])

  const activeAsrConfigId =
    voice.activeAsrConfigId &&
    asrConfigs.some((config) => config.id === voice.activeAsrConfigId)
      ? voice.activeAsrConfigId
      : (asrConfigs[0]?.id ?? '')

  const activeAudioFileAsrConfigId =
    voice.activeAudioFileAsrConfigId &&
    asrConfigs.some((config) => config.id === voice.activeAudioFileAsrConfigId)
      ? voice.activeAudioFileAsrConfigId
      : activeAsrConfigId

  const parseInteger = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^-?\d+$/.test(trimmed)) return null
    return parseInt(trimmed, 10)
  }

  return (
    <div className="yolo-settings-section yolo-settings-section--tight">
      <section className="yolo-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t(
                'settings.audioFileTranscription.title',
                'Audio file transcription',
              )}
            </div>
            <div className="yolo-settings-desc yolo-settings-block-desc">
              {t(
                'settings.audioFileTranscription.description',
                'Transcribe dropped or selected audio files through ASR and insert the transcript into the editor.',
              )}
            </div>
          </div>
        </div>

        <div className="yolo-settings-block-content">
          {!voice.enabled && (
            <div
              className="yolo-settings-card"
              style={{ borderColor: 'var(--text-warning)' }}
            >
              {t(
                'settings.audioFileTranscription.voiceRequiredHint',
                'Enable voice input above to show the floating island used for choosing or dropping audio files.',
              )}
            </div>
          )}

          {!asrReady && (
            <div
              className="yolo-settings-card"
              style={{ borderColor: 'var(--text-warning)' }}
            >
              {t(
                'settings.audioFileTranscription.asrRequiredHint',
                'Configure an ASR provider under the Models tab → Voice recognition first.',
              )}
            </div>
          )}

          <ObsidianSetting
            name={t(
              'settings.audioFileTranscription.enable',
              'Enable audio file transcription',
            )}
            desc={t(
              'settings.audioFileTranscription.enableDesc',
              'Adds an audio-file mode to the floating voice island. File transcription only runs ASR and does not use context-aware polishing.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={
                !!voice.audioFileTranscriptionEnabled &&
                !!voice.enabled &&
                asrReady
              }
              disabled={!voice.enabled || !asrReady}
              onChange={(value) =>
                updateVoice(
                  { audioFileTranscriptionEnabled: value },
                  'audioFileTranscriptionEnabled',
                )
              }
            />
          </ObsidianSetting>

          {voice.audioFileTranscriptionEnabled && (
            <>
              <ObsidianSetting
                name={t(
                  'settings.audioFileTranscription.asrProvider',
                  'Audio file ASR provider',
                )}
                desc={t(
                  'settings.audioFileTranscription.asrProviderDesc',
                  'Defaults to the voice input ASR provider, but can be set separately for longer local audio files.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianDropdown
                  value={activeAudioFileAsrConfigId}
                  options={asrProviderOptions}
                  onChange={(value) =>
                    updateVoice(
                      { activeAudioFileAsrConfigId: value },
                      'activeAudioFileAsrConfigId',
                    )
                  }
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t(
                  'settings.audioFileTranscription.chunkHeaderMode',
                  'Chunk header',
                )}
                desc={t(
                  'settings.audioFileTranscription.chunkHeaderModeDesc',
                  'For HTTP chunked transcription, optionally insert the local chunk start time before each chunk.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianDropdown
                  value={voice.audioFileChunkHeaderMode}
                  options={Object.fromEntries(
                    AUDIO_FILE_CHUNK_HEADER_MODES.map((mode) => [
                      mode,
                      t(
                        `settings.audioFileTranscription.chunkHeaderMode_${mode}`,
                        AUDIO_FILE_CHUNK_HEADER_LABEL_FALLBACK[mode],
                      ),
                    ]),
                  )}
                  onChange={(value) =>
                    updateVoice(
                      {
                        audioFileChunkHeaderMode:
                          value as AudioFileChunkHeaderMode,
                      },
                      'audioFileChunkHeaderMode',
                    )
                  }
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t(
                  'settings.audioFileTranscription.outputMetadataMode',
                  'Output metadata',
                )}
                desc={t(
                  'settings.audioFileTranscription.outputMetadataModeDesc',
                  'Inline insertion defaults to body-only; fallback notes automatically include full metadata when this is body-only.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianDropdown
                  value={voice.audioFileOutputMetadataMode}
                  options={Object.fromEntries(
                    AUDIO_FILE_OUTPUT_METADATA_MODES.map((mode) => [
                      mode,
                      t(
                        `settings.audioFileTranscription.outputMetadataMode_${mode}`,
                        AUDIO_FILE_METADATA_LABEL_FALLBACK[mode],
                      ),
                    ]),
                  )}
                  onChange={(value) =>
                    updateVoice(
                      {
                        audioFileOutputMetadataMode:
                          value as AudioFileOutputMetadataMode,
                      },
                      'audioFileOutputMetadataMode',
                    )
                  }
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t(
                  'settings.audioFileTranscription.fallbackNotePathTemplate',
                  'Fallback note path',
                )}
                desc={t(
                  'settings.audioFileTranscription.fallbackNotePathTemplateDesc',
                  'Used when the original insertion anchor is unavailable. Supports {{date}}, {{time}}, {{basename}}, and {{filename}}.',
                )}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={voice.audioFileFallbackNotePathTemplate}
                  onChange={(value) =>
                    updateVoice(
                      { audioFileFallbackNotePathTemplate: value },
                      'audioFileFallbackNotePathTemplate',
                    )
                  }
                  placeholder="Transcriptions/{{date}} {{time}} {{basename}}.md"
                />
              </ObsidianSetting>

              <div
                className={`yolo-settings-advanced-toggle yolo-clickable${
                  advancedOpen ? ' is-expanded' : ''
                }`}
                onClick={() => setAdvancedOpen((prev) => !prev)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setAdvancedOpen((prev) => !prev)
                  }
                }}
              >
                <span className="yolo-settings-advanced-toggle-icon">▶</span>
                {t(
                  'settings.audioFileTranscription.advancedToggle',
                  'Advanced options',
                )}
              </div>

              {advancedOpen && (
                <>
                  <ObsidianSetting
                    name={t(
                      'settings.audioFileTranscription.chunkTargetDurationSec',
                      'Audio file chunk duration (seconds)',
                    )}
                    desc={t(
                      'settings.audioFileTranscription.chunkTargetDurationSecDesc',
                      'HTTP file transcription target chunk length. Actual chunks are shortened when the provider request limit requires it. Range: 60-600.',
                    )}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={numberInputs.audioFileChunkTargetDurationSec}
                      onChange={(value) => {
                        setNumberInputs((state) => ({
                          ...state,
                          audioFileChunkTargetDurationSec: value,
                        }))
                        const parsed = parseInteger(value)
                        if (parsed !== null && parsed >= 60 && parsed <= 600) {
                          updateVoice(
                            { audioFileChunkTargetDurationSec: parsed },
                            'audioFileChunkTargetDurationSec',
                          )
                        }
                      }}
                      placeholder="120"
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t(
                      'settings.audioFileTranscription.maxConcurrentChunks',
                      'Max concurrent chunks',
                    )}
                    desc={t(
                      'settings.audioFileTranscription.maxConcurrentChunksDesc',
                      'Maximum HTTP chunks in flight at once. Range: 1-5.',
                    )}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={numberInputs.audioFileMaxConcurrentChunks}
                      onChange={(value) => {
                        setNumberInputs((state) => ({
                          ...state,
                          audioFileMaxConcurrentChunks: value,
                        }))
                        const parsed = parseInteger(value)
                        if (parsed !== null && parsed >= 1 && parsed <= 5) {
                          updateVoice(
                            { audioFileMaxConcurrentChunks: parsed },
                            'audioFileMaxConcurrentChunks',
                          )
                        }
                      }}
                      placeholder="5"
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t(
                      'settings.audioFileTranscription.chunkStartStaggerMs',
                      'Chunk start stagger (ms)',
                    )}
                    desc={t(
                      'settings.audioFileTranscription.chunkStartStaggerMsDesc',
                      'Delay between starting chunk uploads, reducing rate-limit spikes. Range: 1000-3000.',
                    )}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={numberInputs.audioFileChunkStartStaggerMs}
                      onChange={(value) => {
                        setNumberInputs((state) => ({
                          ...state,
                          audioFileChunkStartStaggerMs: value,
                        }))
                        const parsed = parseInteger(value)
                        if (
                          parsed !== null &&
                          parsed >= 1000 &&
                          parsed <= 3000
                        ) {
                          updateVoice(
                            { audioFileChunkStartStaggerMs: parsed },
                            'audioFileChunkStartStaggerMs',
                          )
                        }
                      }}
                      placeholder="1500"
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t(
                      'settings.audioFileTranscription.chunkOverlapMs',
                      'Chunk overlap (ms)',
                    )}
                    desc={t(
                      'settings.audioFileTranscription.chunkOverlapMsDesc',
                      'Small overlap around chunk boundaries to reduce missed words. Range: 0-1500.',
                    )}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={numberInputs.audioFileChunkOverlapMs}
                      onChange={(value) => {
                        setNumberInputs((state) => ({
                          ...state,
                          audioFileChunkOverlapMs: value,
                        }))
                        const parsed = parseInteger(value)
                        if (parsed !== null && parsed >= 0 && parsed <= 1500) {
                          updateVoice(
                            { audioFileChunkOverlapMs: parsed },
                            'audioFileChunkOverlapMs',
                          )
                        }
                      }}
                      placeholder="500"
                    />
                  </ObsidianSetting>
                </>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  )
}
