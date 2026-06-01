import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  type AudioOutputDevice,
  applyAudioOutputDevice,
  createSpeakerTestToneUrl,
  enumerateAudioOutputDevices,
} from '../../../core/tts/audioOutput'
import { hasConfiguredTtsConfig } from '../../../core/tts/configStatus'
import type {
  ContextVoiceInputOptions,
  ReadAloudMarkdownMode,
  TtsConfig,
} from '../../../settings/schema/setting.types'
import {
  DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR,
  READ_ALOUD_MARKDOWN_MODES,
} from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

const MARKDOWN_MODE_LABEL: Record<ReadAloudMarkdownMode, string> = {
  readable: 'Readable',
  raw: 'Raw markdown',
}

export function VoiceReadAloudSection() {
  const { settings, setSettings } = useSettings()
  const plugin = usePlugin()
  const { t } = useLanguage()
  const voice = settings.contextVoiceInputOptions
  const ttsReady = hasConfiguredTtsConfig(voice)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const generatedAudioSaveDir =
    voice.readAloudGeneratedAudioSaveDir ||
    DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR
  const [numberInputs, setNumberInputs] = useState({
    readAloudChunkTargetChars: String(voice.readAloudChunkTargetChars),
    readAloudPreloadSegments: String(voice.readAloudPreloadSegments),
  })
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([])
  const [speakerTestRunning, setSpeakerTestRunning] = useState(false)
  const [speakerMessage, setSpeakerMessage] = useState('')
  const speakerTestUrlRef = useRef<string | null>(null)

  const updateVoice = useCallback(
    (patch: Partial<ContextVoiceInputOptions>, context: string) => {
      void (async () => {
        try {
          const latestSettings = plugin.settings
          await setSettings({
            ...latestSettings,
            contextVoiceInputOptions: {
              ...latestSettings.contextVoiceInputOptions,
              ...patch,
            },
          })
        } catch (error) {
          console.error(
            `Failed to update read-aloud settings: ${context}`,
            error,
          )
        }
      })()
    },
    [plugin, setSettings],
  )

  const revokeSpeakerTestUrl = useCallback(() => {
    if (speakerTestUrlRef.current) {
      URL.revokeObjectURL(speakerTestUrlRef.current)
      speakerTestUrlRef.current = null
    }
  }, [])

  const refreshAudioOutputDevices = useCallback(() => {
    void enumerateAudioOutputDevices()
      .then(setOutputDevices)
      .catch((error: unknown) => {
        console.warn('Failed to enumerate audio output devices:', error)
        setOutputDevices([])
      })
  }, [])

  useEffect(
    () => () => {
      revokeSpeakerTestUrl()
    },
    [revokeSpeakerTestUrl],
  )

  useEffect(() => {
    refreshAudioOutputDevices()
    const mediaDevices =
      typeof navigator === 'undefined' ? null : navigator.mediaDevices
    if (!mediaDevices?.addEventListener) return
    mediaDevices.addEventListener('devicechange', refreshAudioOutputDevices)
    return () => {
      mediaDevices.removeEventListener(
        'devicechange',
        refreshAudioOutputDevices,
      )
    }
  }, [refreshAudioOutputDevices])

  const providerOptions = useMemo<Record<string, string>>(() => {
    const configs = voice.ttsConfigs ?? []
    if (configs.length === 0) {
      return {
        '': t('settings.tts.none', '(none - add one in Models)'),
      }
    }
    return Object.fromEntries(
      configs.map((config: TtsConfig) => [
        config.id,
        config.name || config.model || config.id,
      ]),
    )
  }, [t, voice.ttsConfigs])

  const outputDeviceOptions = useMemo<Record<string, string>>(() => {
    const fallbackName = t('settings.readAloud.speakerFallbackName', 'Speaker')
    const entries: [string, string][] = [
      ['', t('settings.readAloud.speakerDefault', 'System default')],
    ]
    outputDevices.forEach((device, index) => {
      entries.push([
        device.deviceId,
        device.label || `${fallbackName} ${index + 1}`,
      ])
    })
    const selectedDeviceId = voice.ttsOutputDeviceId ?? ''
    if (
      selectedDeviceId &&
      !entries.some(([deviceId]) => deviceId === selectedDeviceId)
    ) {
      entries.push([
        selectedDeviceId,
        t('settings.readAloud.speakerCurrent', 'Selected speaker'),
      ])
    }
    return Object.fromEntries(entries)
  }, [outputDevices, t, voice.ttsOutputDeviceId])

  const activeTtsConfigId =
    voice.activeTtsConfigId &&
    (voice.ttsConfigs ?? []).some(
      (config) => config.id === voice.activeTtsConfigId,
    )
      ? voice.activeTtsConfigId
      : (voice.ttsConfigs?.[0]?.id ?? '')

  const parseInteger = (value: string) => {
    const trimmed = value.trim()
    if (!/^-?\d+$/.test(trimmed)) return null
    return Number.parseInt(trimmed, 10)
  }

  const runSpeakerTest = () => {
    void (async () => {
      setSpeakerTestRunning(true)
      setSpeakerMessage('')
      revokeSpeakerTestUrl()
      const url = createSpeakerTestToneUrl()
      speakerTestUrlRef.current = url
      try {
        const audio = new Audio(url)
        audio.addEventListener(
          'ended',
          () => {
            if (speakerTestUrlRef.current === url) revokeSpeakerTestUrl()
          },
          { once: true },
        )
        audio.addEventListener(
          'error',
          () => {
            if (speakerTestUrlRef.current === url) revokeSpeakerTestUrl()
          },
          { once: true },
        )
        let outputApplied = true
        try {
          outputApplied = await applyAudioOutputDevice(
            audio,
            voice.ttsOutputDeviceId ?? '',
          )
        } catch (error) {
          console.warn('Failed to apply TTS speaker test output:', error)
          outputApplied = false
        }
        await audio.play()
        setSpeakerMessage(
          outputApplied
            ? t(
                'settings.readAloud.speakerTestPlaying',
                'Playing speaker test.',
              )
            : t(
                'settings.readAloud.speakerUnsupported',
                'Speaker selection is not supported here; playing through the system default.',
              ),
        )
      } catch (error) {
        if (speakerTestUrlRef.current === url) revokeSpeakerTestUrl()
        console.error('TTS speaker test failed', error)
        setSpeakerMessage(
          error instanceof Error
            ? error.message
            : t('settings.readAloud.speakerTestFailed', 'Speaker test failed.'),
        )
      } finally {
        setSpeakerTestRunning(false)
      }
    })()
  }

  return (
    <div className="yolo-settings-section yolo-settings-section--tight">
      <section className="yolo-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t('settings.readAloud.title', 'Read aloud')}
            </div>
            <div className="yolo-settings-desc yolo-settings-block-desc">
              {t(
                'settings.readAloud.description',
                'Read the current selection or note through a configured TTS provider.',
              )}
            </div>
          </div>
        </div>

        <div className="yolo-settings-block-content">
          <ObsidianSetting
            name={t('settings.readAloud.enable', 'Enable read aloud')}
            desc={
              ttsReady
                ? t(
                    'settings.readAloud.enableDesc',
                    'Adds read aloud as a floating island mode and enables read-aloud commands.',
                  )
                : t(
                    'settings.readAloud.enableDescUnavailable',
                    'Add a TTS provider in Models before enabling read aloud.',
                  )
            }
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={!!voice.voiceReadAloudEnabled && ttsReady}
              disabled={!ttsReady}
              onChange={(value) =>
                updateVoice({ voiceReadAloudEnabled: value }, 'enabled')
              }
            />
          </ObsidianSetting>

          {voice.voiceReadAloudEnabled && ttsReady && (
            <>
              <ObsidianSetting
                name={t('settings.readAloud.ttsProvider', 'TTS provider')}
                desc={t(
                  'settings.readAloud.ttsProviderDesc',
                  'Used for floating island read aloud and command palette actions.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianDropdown
                  value={activeTtsConfigId}
                  options={providerOptions}
                  disabled={!ttsReady}
                  onChange={(value) =>
                    updateVoice(
                      { activeTtsConfigId: value },
                      'activeTtsConfigId',
                    )
                  }
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.readAloud.markdownMode', 'Markdown mode')}
                desc={t(
                  'settings.readAloud.markdownModeDesc',
                  'Readable skips frontmatter/code and reads links by label; raw keeps markdown syntax.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianDropdown
                  value={voice.readAloudMarkdownMode}
                  options={Object.fromEntries(
                    READ_ALOUD_MARKDOWN_MODES.map((mode) => [
                      mode,
                      t(
                        `settings.readAloud.markdownModeOption.${mode}`,
                        MARKDOWN_MODE_LABEL[mode],
                      ),
                    ]),
                  )}
                  onChange={(value) =>
                    updateVoice(
                      { readAloudMarkdownMode: value as ReadAloudMarkdownMode },
                      'readAloudMarkdownMode',
                    )
                  }
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t(
                  'settings.readAloud.autoSave',
                  'Auto-save generated audio',
                )}
                desc={t(
                  'settings.readAloud.autoSaveDesc',
                  'Saves generated audio to the folder below and enables drag-out.',
                )}
                className="yolo-settings-card"
              >
                <ObsidianToggle
                  value={
                    !!voice.readAloudGeneratedAudioAutoSaveEnabled &&
                    !!generatedAudioSaveDir.trim()
                  }
                  disabled={!generatedAudioSaveDir.trim()}
                  onChange={(value) =>
                    updateVoice(
                      { readAloudGeneratedAudioAutoSaveEnabled: value },
                      'readAloudGeneratedAudioAutoSaveEnabled',
                    )
                  }
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.readAloud.saveDir', 'Generated audio folder')}
                desc={t(
                  'settings.readAloud.saveDirDesc',
                  'Vault-relative folder. Absolute paths are not accepted.',
                )}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={generatedAudioSaveDir}
                  onChange={(value) =>
                    updateVoice(
                      { readAloudGeneratedAudioSaveDir: value },
                      'readAloudGeneratedAudioSaveDir',
                    )
                  }
                  placeholder={DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR}
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
                {t('settings.readAloud.advancedToggle', 'Advanced options')}
              </div>

              {advancedOpen && (
                <>
                  <ObsidianSetting
                    name={t('settings.readAloud.speaker', 'Speaker')}
                    desc={
                      speakerMessage ||
                      t(
                        'settings.readAloud.speakerDesc',
                        'Choose where read aloud and TTS tests are played.',
                      )
                    }
                    className="yolo-models-select-card"
                  >
                    <div className="yolo-tts-speaker-controls">
                      <ObsidianDropdown
                        value={voice.ttsOutputDeviceId ?? ''}
                        options={outputDeviceOptions}
                        onChange={(value) => {
                          setSpeakerMessage('')
                          updateVoice(
                            { ttsOutputDeviceId: value },
                            'ttsOutputDeviceId',
                          )
                        }}
                      />
                      <ObsidianButton
                        text={
                          speakerTestRunning
                            ? t(
                                'settings.readAloud.speakerTesting',
                                'Testing...',
                              )
                            : t(
                                'settings.readAloud.speakerTest',
                                'Test speaker',
                              )
                        }
                        disabled={speakerTestRunning}
                        onClick={runSpeakerTest}
                      />
                    </div>
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t(
                      'settings.readAloud.chunkTargetChars',
                      'Characters per segment limit',
                    )}
                    desc={t(
                      'settings.readAloud.chunkTargetCharsDesc',
                      'Long text is split up to this limit, preferring natural pauses; actual segments may be shorter. Range: 200-6000.',
                    )}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={numberInputs.readAloudChunkTargetChars}
                      onChange={(value) => {
                        setNumberInputs((state) => ({
                          ...state,
                          readAloudChunkTargetChars: value,
                        }))
                        const parsed = parseInteger(value)
                        if (
                          parsed !== null &&
                          parsed >= 200 &&
                          parsed <= 6000
                        ) {
                          updateVoice(
                            { readAloudChunkTargetChars: parsed },
                            'readAloudChunkTargetChars',
                          )
                        }
                      }}
                      placeholder="500"
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t(
                      'settings.readAloud.preloadSegments',
                      'Preload segments',
                    )}
                    desc={t(
                      'settings.readAloud.preloadSegmentsDesc',
                      'How many upcoming text segments to synthesize ahead of playback. Range: 0-3.',
                    )}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={numberInputs.readAloudPreloadSegments}
                      onChange={(value) => {
                        setNumberInputs((state) => ({
                          ...state,
                          readAloudPreloadSegments: value,
                        }))
                        const parsed = parseInteger(value)
                        if (parsed !== null && parsed >= 0 && parsed <= 3) {
                          updateVoice(
                            { readAloudPreloadSegments: parsed },
                            'readAloudPreloadSegments',
                          )
                        }
                      }}
                      placeholder="1"
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t('settings.readAloud.cacheEnabled', 'Memory cache')}
                    desc={t(
                      'settings.readAloud.cacheEnabledDesc',
                      'Reuse generated audio within this Obsidian session when text and TTS settings match.',
                    )}
                    className="yolo-settings-card"
                  >
                    <ObsidianToggle
                      value={!!voice.readAloudCacheEnabled}
                      onChange={(value) =>
                        updateVoice(
                          { readAloudCacheEnabled: value },
                          'readAloudCacheEnabled',
                        )
                      }
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
