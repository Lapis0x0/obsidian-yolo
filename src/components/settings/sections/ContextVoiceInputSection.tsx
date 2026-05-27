import { useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { isAsrConfigured } from '../../../core/asr/manager'
import type {
  ContextVoiceInputOptions,
  VoicePolishPromptMode,
} from '../../../settings/schema/setting.types'
import {
  DEFAULT_VOICE_INPUT_SYSTEM_PROMPT,
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

// Translation-key suffixes for the polish-prompt dropdown. Picking any
// non-custom mode applies the matching prompt from VOICE_POLISH_PROMPT_PRESETS
// (in setting.types.ts) at request time — no textarea step required. The
// English fallbacks are the source of truth; localised labels live in zh.ts.
const PROMPT_MODE_LABEL_FALLBACK: Record<VoicePolishPromptMode, string> = {
  default: 'Default (cleanup)',
  translate: 'Translate (zh ⇆ en)',
  expand: 'Expand (outline → paragraph)',
  list: 'Format as list',
  custom: 'Custom',
}

export function ContextVoiceInputSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const voice = settings.contextVoiceInputOptions
  const asrReady = isAsrConfigured(voice)

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
  })

  const updateVoice = useCallback(
    (patch: Partial<ContextVoiceInputOptions>, context: string) => {
      void (async () => {
        try {
          await setSettings({
            ...settings,
            contextVoiceInputOptions: {
              ...voice,
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
    [settings, setSettings, voice],
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
              'Trigger via the command palette (Start / Stop context-aware voice input), an Obsidian hotkey, or the status-bar mic icon.',
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
              'settings.contextVoiceInput.polishTemperature',
              'Voice polish temperature override',
            )}
            desc={t(
              'settings.contextVoiceInput.polishTemperatureDesc',
              'Leave blank to use the selected model/provider default. Set 0-2 only when this voice input flow needs its own temperature.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianTextInput
              value={numberInputs.polishTemperature}
              onChange={(value) => {
                setNumberInputs((s) => ({ ...s, polishTemperature: value }))
                if (value.trim().length === 0) {
                  updateVoice(
                    { polishTemperature: undefined },
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
                'Use model default',
              )}
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

          <div className="yolo-voice-settings-note">
            {t(
              'settings.contextVoiceInput.tabCompletionAlwaysPaused',
              'Tab completion is always paused while voice input is active, so Tab only accepts the voice draft.',
            )}
          </div>

          <ObsidianSetting
            name={t(
              'settings.contextVoiceInput.contextRangeChars',
              'Context range (characters)',
            )}
            desc={t(
              'settings.contextVoiceInput.contextRangeCharsDesc',
              'Total before+after window sent to the polish model. Split roughly 4:1 toward the before-cursor text.',
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
              'settings.contextVoiceInput.maxAfterContextChars',
              'Text after cursor to include',
            )}
            desc={t(
              'settings.contextVoiceInput.maxAfterContextCharsDesc',
              'How many characters after the cursor are sent as reference, so the model can avoid repeating or colliding with existing text. This does not limit how much text voice input can insert.',
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

          <ObsidianSetting
            name={t(
              'settings.contextVoiceInput.maxRecordingSeconds',
              'Max recording (seconds)',
            )}
            desc={t(
              'settings.contextVoiceInput.maxRecordingSecondsDesc',
              'Auto-stops a forgotten recording so it does not waste ASR quota.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianTextInput
              value={numberInputs.maxRecordingSeconds}
              onChange={(value) => {
                setNumberInputs((s) => ({ ...s, maxRecordingSeconds: value }))
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
              onChange={(value) => {
                setNumberInputs((s) => ({
                  ...s,
                  vadSpeechStartDecibels: value,
                }))
                const parsed = parseNumber(value)
                if (parsed !== null && parsed >= -90 && parsed <= 0) {
                  updateVoice(
                    { vadSpeechStartDecibels: parsed },
                    'vadSpeechStartDecibels',
                  )
                }
              }}
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
              onChange={(value) => {
                setNumberInputs((s) => ({ ...s, vadSilenceDecibels: value }))
                const parsed = parseNumber(value)
                if (parsed !== null && parsed >= -90 && parsed <= 0) {
                  updateVoice(
                    { vadSilenceDecibels: parsed },
                    'vadSilenceDecibels',
                  )
                }
              }}
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
              'How long point-and-click mode waits after speech tails off before it sends the segment to ASR. Default: 1200.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianTextInput
              value={numberInputs.vadSilenceHoldMs}
              onChange={(value) => {
                setNumberInputs((s) => ({ ...s, vadSilenceHoldMs: value }))
                const parsed = parseInteger(value)
                if (parsed !== null && parsed >= 300 && parsed <= 5000) {
                  updateVoice({ vadSilenceHoldMs: parsed }, 'vadSilenceHoldMs')
                }
              }}
              placeholder="1200"
            />
          </ObsidianSetting>
        </div>
      </section>
    </div>
  )
}
