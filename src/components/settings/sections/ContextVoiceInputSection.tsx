import { useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { hasConfiguredAsrConfig } from '../../../core/asr/configStatus'
import type {
  ContextVoiceInputOptions,
  DocumentSummaryRefreshMode,
  VoicePolishPromptMode,
} from '../../../settings/schema/setting.types'
import {
  DEFAULT_VOICE_INPUT_SYSTEM_PROMPT,
  DOCUMENT_SUMMARY_REFRESH_MODES,
  VOICE_POLISH_PROMPT_MODES,
  VOICE_POLISH_PROMPT_PRESETS,
} from '../../../settings/schema/setting.types'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

import {
  DECIBEL_CHART_CEILING,
  DECIBEL_CHART_FLOOR,
  VoiceDecibelMeter,
} from './ContextVoiceDecibelMeter'

// Translation-key suffixes for the polish-prompt dropdown. Picking any
// non-custom mode applies the matching prompt from VOICE_POLISH_PROMPT_PRESETS
// (in setting.types.ts) at request time — no textarea step required.
const PROMPT_MODE_LABEL_FALLBACK: Record<VoicePolishPromptMode, string> = {
  default: 'Default (cleanup only, stay faithful)',
  translate: 'Translate (zh ⇆ en)',
  expand: 'Expand (outline → paragraph)',
  polish: 'Polish (formal / academic / literary)',
  custom: 'Custom',
}

const SUMMARY_REFRESH_LABEL_FALLBACK: Record<
  DocumentSummaryRefreshMode,
  string
> = {
  smart: 'Smart refresh',
  session: 'Do not refresh this session',
  '15min': 'Every 15 minutes',
  '1hour': 'Every 1 hour',
}

export function ContextVoiceInputSection() {
  const { settings, setSettings } = useSettings()
  const plugin = usePlugin()
  const { t } = useLanguage()
  const voice = settings.contextVoiceInputOptions
  const asrReady = hasConfiguredAsrConfig(voice)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [numberInputs, setNumberInputs] = useState({
    contextRangeChars: String(voice.contextRangeChars),
    maxAfterContextChars: String(voice.maxAfterContextChars),
    maxRecordingSeconds: String(voice.maxRecordingSeconds),
    polishTemperature:
      typeof voice.polishTemperature === 'number'
        ? String(voice.polishTemperature)
        : '',
    vadSpeechStartDecibels: String(voice.vadSpeechStartDecibels),
    vadSilenceDecibels: String(voice.vadSilenceDecibels),
    vadSilenceHoldMs: String(voice.vadSilenceHoldMs),
    floatingIslandBottomOffsetVh: String(voice.floatingIslandBottomOffsetVh),
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
            `Failed to update voice input settings: ${context}`,
            error,
          )
        }
      })()
    },
    [plugin, setSettings],
  )

  const enabledChatModels = useMemo(
    () => settings.chatModels.filter(({ enable }) => enable ?? true),
    [settings.chatModels],
  )

  const polishModelOptions = useMemo<ObsidianDropdownOptionGroup[]>(() => {
    const providerOrder = settings.providers.map((p) => p.id)
    const providersInUse = Array.from(
      new Set(enabledChatModels.map((m) => m.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providersInUse.includes(id)),
      ...providersInUse.filter((id) => !providerOrder.includes(id)),
    ]
    return orderedProviderIds
      .map<ObsidianDropdownOptionGroup | null>((providerId) => {
        const groupModels = enabledChatModels.filter(
          (model) => model.providerId === providerId,
        )
        if (groupModels.length === 0) return null
        return {
          label: providerId,
          options: groupModels.map((model) => ({
            value: model.id,
            label: model.name || model.model || model.id,
          })),
        }
      })
      .filter((group): group is ObsidianDropdownOptionGroup => group !== null)
  }, [enabledChatModels, settings.providers])

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
      asrConfigs.map((c) => [
        c.id,
        `${c.name || '(unnamed)'} · ${c.model || c.format}`,
      ]),
    )
  }, [asrConfigs, t])

  const activeAsrConfigId =
    voice.activeAsrConfigId &&
    asrConfigs.some((c) => c.id === voice.activeAsrConfigId)
      ? voice.activeAsrConfigId
      : (asrConfigs[0]?.id ?? '')

  const parseInteger = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^-?\d+$/.test(trimmed)) return null
    return parseInt(trimmed, 10)
  }

  const parseNumber = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  const parseVisibleDecibel = (value: string, fallback: number): number => {
    const parsed = parseNumber(value)
    return parsed !== null &&
      parsed >= DECIBEL_CHART_FLOOR &&
      parsed <= DECIBEL_CHART_CEILING
      ? parsed
      : fallback
  }

  const visibleSpeechStartDecibels = parseVisibleDecibel(
    numberInputs.vadSpeechStartDecibels,
    voice.vadSpeechStartDecibels,
  )
  const visibleSilenceDecibels = parseVisibleDecibel(
    numberInputs.vadSilenceDecibels,
    voice.vadSilenceDecibels,
  )

  const updateSpeechStartDecibelsInput = (value: string) => {
    setNumberInputs((s) => ({
      ...s,
      vadSpeechStartDecibels: value,
    }))
    const parsed = parseNumber(value)
    if (
      parsed !== null &&
      parsed >= DECIBEL_CHART_FLOOR &&
      parsed <= DECIBEL_CHART_CEILING
    ) {
      updateVoice({ vadSpeechStartDecibels: parsed }, 'vadSpeechStartDecibels')
    }
  }

  const updateSilenceDecibelsInput = (value: string) => {
    setNumberInputs((s) => ({
      ...s,
      vadSilenceDecibels: value,
    }))
    const parsed = parseNumber(value)
    if (
      parsed !== null &&
      parsed >= DECIBEL_CHART_FLOOR &&
      parsed <= DECIBEL_CHART_CEILING
    ) {
      updateVoice({ vadSilenceDecibels: parsed }, 'vadSilenceDecibels')
    }
  }

  const selectedPromptBody =
    voice.systemPromptMode === 'custom'
      ? voice.customSystemPrompt
      : (VOICE_POLISH_PROMPT_PRESETS[voice.systemPromptMode] ??
        DEFAULT_VOICE_INPUT_SYSTEM_PROMPT)

  return (
    <div className="yolo-settings-section yolo-settings-section--tight">
      <section className="yolo-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t(
                'settings.contextVoiceInput.title',
                'Context-aware voice input',
              )}
            </div>
            <div className="yolo-settings-desc yolo-settings-block-desc">
              {t(
                'settings.contextVoiceInput.description',
                'Hold the mic to speak, get text inserted at your cursor. Polish uses the current file title, the text around the cursor, and any active selection.',
              )}
            </div>
          </div>
        </div>

        <div className="yolo-settings-block-content">
          {!asrReady && (
            <div
              className="yolo-settings-card"
              style={{ borderColor: 'var(--text-warning)' }}
            >
              {t(
                'settings.contextVoiceInput.asrRequiredHint',
                'Configure an ASR provider under the Models tab → Voice recognition first. The toggle below stays disabled until that profile has a baseURL and model.',
              )}
            </div>
          )}

          <ObsidianSetting
            name={t('settings.contextVoiceInput.enable', 'Enable voice input')}
            desc={t(
              'settings.contextVoiceInput.enableDesc',
              'Trigger via the command palette (Start / Stop context-aware voice input), an Obsidian hotkey, or the floating mic.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={voice.enabled && asrReady}
              disabled={!asrReady}
              onChange={(value) => updateVoice({ enabled: value }, 'enabled')}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.contextVoiceInput.asrProvider', 'ASR provider')}
            desc={t(
              'settings.contextVoiceInput.asrProviderDesc',
              'Pick which of your configured ASR endpoints handles this voice input session.',
            )}
            className="yolo-models-select-card"
          >
            <ObsidianDropdown
              value={activeAsrConfigId}
              options={asrProviderOptions}
              onChange={(value) =>
                updateVoice({ activeAsrConfigId: value }, 'activeAsrConfigId')
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.contextVoiceInput.polishModel', 'Polish model')}
            desc={t(
              'settings.contextVoiceInput.polishModelDesc',
              'Rewrites the raw transcript with the surrounding editor context. Falls back to the default chat model when unset.',
            )}
            className="yolo-models-select-card"
          >
            <ObsidianDropdown
              value={voice.polishModelId}
              groupedOptions={polishModelOptions}
              onChange={(value) =>
                updateVoice({ polishModelId: value }, 'polishModelId')
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t(
              'settings.contextVoiceInput.systemPromptMode',
              'Prompt style',
            )}
            desc={t(
              'settings.contextVoiceInput.systemPromptModeDesc',
              'Pick a built-in preset or switch to custom to write your own.',
            )}
            className="yolo-models-select-card"
          >
            <ObsidianDropdown
              value={voice.systemPromptMode}
              options={Object.fromEntries(
                VOICE_POLISH_PROMPT_MODES.map((m) => [
                  m,
                  t(
                    `settings.contextVoiceInput.promptMode.${m}`,
                    PROMPT_MODE_LABEL_FALLBACK[m],
                  ),
                ]),
              )}
              onChange={(value) =>
                updateVoice(
                  {
                    systemPromptMode: value as VoicePolishPromptMode,
                  },
                  'systemPromptMode',
                )
              }
            />
          </ObsidianSetting>

          <div className="yolo-settings-card yolo-voice-prompt-card">
            <div className="yolo-voice-prompt-card__head">
              <div className="yolo-voice-prompt-card__name">
                {voice.systemPromptMode === 'custom'
                  ? t(
                      'settings.contextVoiceInput.customSystemPrompt',
                      'Custom system prompt',
                    )
                  : t(
                      'settings.contextVoiceInput.builtinSystemPrompt',
                      'Built-in system prompt',
                    )}
              </div>
              <div className="yolo-voice-prompt-card__desc">
                {voice.systemPromptMode === 'custom'
                  ? t(
                      'settings.contextVoiceInput.customSystemPromptDesc',
                      'Must still emit { action, text } JSON.',
                    )
                  : t(
                      'settings.contextVoiceInput.builtinSystemPromptDesc',
                      'Shown for review. Built-in presets are locked; switch to Custom to edit your own prompt.',
                    )}
              </div>
            </div>
            <ObsidianTextArea
              value={selectedPromptBody}
              disabled={voice.systemPromptMode !== 'custom'}
              onChange={(value) =>
                updateVoice({ customSystemPrompt: value }, 'customSystemPrompt')
              }
              placeholder='Polish the transcript into { "action": "insert_at_cursor", "text": "..." }'
              containerClassName="yolo-voice-prompt-textarea"
              inputClassName="yolo-voice-prompt-textarea-input"
            />
          </div>

          <ObsidianSetting
            name={t(
              'settings.contextVoiceInput.autoRestartAfterAccept',
              'Keep listening after Tab accept',
            )}
            desc={t(
              'settings.contextVoiceInput.autoRestartAfterAcceptDesc',
              'Click-toggle mode only. After Tab accepts a polished draft, automatically start the next recording segment without clicking the mic again.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={!!voice.autoRestartAfterAccept}
              onChange={(value) =>
                updateVoice(
                  { autoRestartAfterAccept: value },
                  'autoRestartAfterAccept',
                )
              }
            />
          </ObsidianSetting>

          <div className="yolo-voice-settings-note">
            {t(
              'settings.contextVoiceInput.tabCompletionAlwaysPaused',
              'Tab completion is always paused while voice input is active, so Tab only accepts the voice draft.',
            )}
          </div>

          <ObsidianSetting
            name={t(
              'settings.contextVoiceInput.beforeWindowChars',
              'Initial before-cursor window (characters)',
            )}
            desc={t(
              'settings.contextVoiceInput.beforeWindowCharsDesc',
              'Initial characters of editor text BEFORE the cursor sent to the polish model. During continuous dictation, the anchored prefix grows as you accept/write text. Independent from the after-cursor window below.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianTextInput
              value={numberInputs.contextRangeChars}
              onChange={(value) => {
                setNumberInputs((s) => ({ ...s, contextRangeChars: value }))
                const parsed = parseInteger(value)
                if (parsed !== null && parsed >= 0) {
                  updateVoice(
                    { contextRangeChars: parsed },
                    'contextRangeChars',
                  )
                }
              }}
              placeholder="2000"
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t(
              'settings.contextVoiceInput.afterWindowChars',
              'After-cursor window (characters)',
            )}
            desc={t(
              'settings.contextVoiceInput.afterWindowCharsDesc',
              'Characters of editor text AFTER the cursor sent to the polish model. Helps the model avoid repeating text that already follows the cursor. Does not limit how much text voice input can insert.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianTextInput
              value={numberInputs.maxAfterContextChars}
              onChange={(value) => {
                setNumberInputs((s) => ({ ...s, maxAfterContextChars: value }))
                const parsed = parseInteger(value)
                if (parsed !== null && parsed >= 0) {
                  updateVoice(
                    { maxAfterContextChars: parsed },
                    'maxAfterContextChars',
                  )
                }
              }}
              placeholder="600"
            />
          </ObsidianSetting>

          {/* Advanced options collapse — summary cost knobs, temperature, VAD
              thresholds, and max recording length live here so the primary panel stays short.
              Reuses the shared `yolo-settings-advanced-toggle` pattern
              (RAGSection / ContinuationSection / Composer all use it) for
              visual consistency with the rest of the settings UI. */}
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
            {t('settings.contextVoiceInput.advancedToggle', 'Advanced options')}
          </div>

          {advancedOpen && (
            <>
              <ObsidianSetting
                name={t(
                  'settings.contextVoiceInput.documentSummaryEnabled',
                  'Include document summary + hot words',
                )}
                desc={t(
                  'settings.contextVoiceInput.documentSummaryEnabledDesc',
                  'Attach an LLM-generated summary of the current file to each polish request so the model can match terminology and tone over long documents. Increases LLM cost. Summaries stay in memory only and are dropped when Obsidian closes.',
                )}
                className="yolo-settings-card"
              >
                <ObsidianToggle
                  value={!!voice.documentSummaryEnabled}
                  onChange={(value) =>
                    updateVoice(
                      { documentSummaryEnabled: value },
                      'documentSummaryEnabled',
                    )
                  }
                />
              </ObsidianSetting>

              {voice.documentSummaryEnabled && (
                <ObsidianSetting
                  name={t(
                    'settings.contextVoiceInput.documentSummaryRefresh',
                    'Summary refresh',
                  )}
                  desc={t(
                    'settings.contextVoiceInput.documentSummaryRefreshDesc',
                    'A full-document summary is generated automatically on first voice input; this controls when it is regenerated.',
                  )}
                  className="yolo-models-select-card"
                >
                  <ObsidianDropdown
                    value={voice.documentSummaryRefreshMode}
                    options={Object.fromEntries(
                      DOCUMENT_SUMMARY_REFRESH_MODES.map((mode) => [
                        mode,
                        t(
                          `settings.contextVoiceInput.documentSummaryRefresh_${mode}`,
                          SUMMARY_REFRESH_LABEL_FALLBACK[mode],
                        ),
                      ]),
                    )}
                    onChange={(value) =>
                      updateVoice(
                        {
                          documentSummaryRefreshMode:
                            value as DocumentSummaryRefreshMode,
                        },
                        'documentSummaryRefreshMode',
                      )
                    }
                  />
                </ObsidianSetting>
              )}

              <ObsidianSetting
                name={t(
                  'settings.contextVoiceInput.polishTemperature',
                  'Polish call temperature',
                )}
                desc={t(
                  'settings.contextVoiceInput.polishTemperatureDesc',
                  "Default: 0.2. Leave blank to use the selected polish model's configured temperature.",
                )}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={numberInputs.polishTemperature}
                  onChange={(value) => {
                    setNumberInputs((s) => ({
                      ...s,
                      polishTemperature: value,
                    }))
                    if (value.trim().length === 0) {
                      updateVoice(
                        { polishTemperature: null },
                        'polishTemperature',
                      )
                      return
                    }
                    const parsed = parseNumber(value)
                    if (parsed !== null && parsed >= 0 && parsed <= 2) {
                      updateVoice(
                        { polishTemperature: parsed },
                        'polishTemperature',
                      )
                    }
                  }}
                  placeholder={t(
                    'settings.contextVoiceInput.polishTemperaturePlaceholder',
                    'Use model temperature',
                  )}
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t(
                  'settings.contextVoiceInput.maxRecordingSeconds',
                  'Max recording (seconds)',
                )}
                desc={t(
                  'settings.contextVoiceInput.maxRecordingSecondsDesc',
                  'Auto-stops a forgotten recording so it does not waste ASR calls.',
                )}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={numberInputs.maxRecordingSeconds}
                  onChange={(value) => {
                    setNumberInputs((s) => ({
                      ...s,
                      maxRecordingSeconds: value,
                    }))
                    const parsed = parseInteger(value)
                    if (parsed !== null && parsed >= 5 && parsed <= 900) {
                      updateVoice(
                        { maxRecordingSeconds: parsed },
                        'maxRecordingSeconds',
                      )
                    }
                  }}
                  placeholder="120"
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t(
                  'settings.contextVoiceInput.floatingIslandBottomOffsetVh',
                  'Floating mic bottom offset (vh)',
                )}
                desc={t(
                  'settings.contextVoiceInput.floatingIslandBottomOffsetVhDesc',
                  'Distance from the editor bottom to the floating mic, in viewport-height percent. Default: 9.',
                )}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={numberInputs.floatingIslandBottomOffsetVh}
                  onChange={(value) => {
                    setNumberInputs((s) => ({
                      ...s,
                      floatingIslandBottomOffsetVh: value,
                    }))
                    const parsed = parseNumber(value)
                    if (parsed !== null && parsed >= 0 && parsed <= 50) {
                      updateVoice(
                        { floatingIslandBottomOffsetVh: parsed },
                        'floatingIslandBottomOffsetVh',
                      )
                    }
                  }}
                  placeholder="9"
                />
              </ObsidianSetting>

              <div className="yolo-voice-decibel-card">
                <div className="setting-item-info yolo-voice-decibel-card__head">
                  <div className="setting-item-name">
                    {t(
                      'settings.contextVoiceInput.decibelMeter',
                      'Microphone level meter',
                    )}
                  </div>
                  <div className="setting-item-description">
                    {t(
                      'settings.contextVoiceInput.decibelMeterDesc',
                      'Listen locally and show the current microphone level so you can tune the speech and silence thresholds below. Audio is not recorded or sent.',
                    )}
                  </div>
                </div>
                <VoiceDecibelMeter
                  t={t}
                  deviceId={voice.microphoneDeviceId ?? ''}
                  speechStartDecibels={visibleSpeechStartDecibels}
                  silenceDecibels={visibleSilenceDecibels}
                  silenceHoldMs={voice.vadSilenceHoldMs}
                />
              </div>

              <ObsidianSetting
                name={t(
                  'settings.contextVoiceInput.vadSpeechStartDecibels',
                  'Speech start threshold (dB)',
                )}
                desc={t(
                  'settings.contextVoiceInput.vadSpeechStartDecibelsDesc',
                  'More negative catches quieter speech; less negative ignores more background noise. Default: -42.',
                )}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={numberInputs.vadSpeechStartDecibels}
                  type="number"
                  inputMode="decimal"
                  min={DECIBEL_CHART_FLOOR}
                  max={DECIBEL_CHART_CEILING}
                  step={1}
                  onChange={updateSpeechStartDecibelsInput}
                  placeholder="-42"
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t(
                  'settings.contextVoiceInput.vadSilenceDecibels',
                  'Silence threshold after speech (dB)',
                )}
                desc={t(
                  'settings.contextVoiceInput.vadSilenceDecibelsDesc',
                  'After speech has started, audio below this level counts as silence. Default: -38.',
                )}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={numberInputs.vadSilenceDecibels}
                  type="number"
                  inputMode="decimal"
                  min={DECIBEL_CHART_FLOOR}
                  max={DECIBEL_CHART_CEILING}
                  step={1}
                  onChange={updateSilenceDecibelsInput}
                  placeholder="-38"
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t(
                  'settings.contextVoiceInput.vadSilenceHoldMs',
                  'Silence duration to stop (ms)',
                )}
                desc={t(
                  'settings.contextVoiceInput.vadSilenceHoldMsDesc',
                  'How long click-toggle mode waits after speech tails off before it sends the segment to ASR. Default: 1200.',
                )}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={numberInputs.vadSilenceHoldMs}
                  onChange={(value) => {
                    setNumberInputs((s) => ({
                      ...s,
                      vadSilenceHoldMs: value,
                    }))
                    const parsed = parseInteger(value)
                    if (parsed !== null && parsed >= 300 && parsed <= 5000) {
                      updateVoice(
                        { vadSilenceHoldMs: parsed },
                        'vadSilenceHoldMs',
                      )
                    }
                  }}
                  placeholder="1200"
                />
              </ObsidianSetting>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
