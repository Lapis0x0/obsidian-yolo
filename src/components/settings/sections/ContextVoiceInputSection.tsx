import { useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { isAsrConfigured } from '../../../core/asr/manager'
import type { ContextVoiceInputOptions } from '../../../settings/schema/setting.types'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

export function ContextVoiceInputSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const voice = settings.contextVoiceInputOptions
  const asrReady = isAsrConfigured(voice)

  const [numberInputs, setNumberInputs] = useState({
    contextRangeChars: String(voice.contextRangeChars),
    maxAfterContextChars: String(voice.maxAfterContextChars),
    maxRecordingSeconds: String(voice.maxRecordingSeconds),
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
              'settings.contextVoiceInput.systemPromptMode',
              'System prompt',
            )}
            desc={t(
              'settings.contextVoiceInput.systemPromptModeDesc',
              'The default prompt handles ASR cleanup and the "directive vs natural writing" split. Switch to custom if you want translation / expansion / formatting variants.',
            )}
            className="yolo-models-select-card"
          >
            <ObsidianDropdown
              value={voice.systemPromptMode}
              options={{
                default: t(
                  'settings.contextVoiceInput.systemPromptModeDefault',
                  'Default (voice cleanup)',
                ),
                custom: t(
                  'settings.contextVoiceInput.systemPromptModeCustom',
                  'Custom',
                ),
              }}
              onChange={(value) =>
                updateVoice(
                  {
                    systemPromptMode: value === 'custom' ? 'custom' : 'default',
                  },
                  'systemPromptMode',
                )
              }
            />
          </ObsidianSetting>

          {voice.systemPromptMode === 'custom' && (
            <ObsidianSetting
              name={t(
                'settings.contextVoiceInput.customSystemPrompt',
                'Custom system prompt',
              )}
              desc={t(
                'settings.contextVoiceInput.customSystemPromptDesc',
                'Must keep the strict JSON output contract: { action, text }. See the design doc for the schema.',
              )}
              className="yolo-settings-card"
            >
              <ObsidianTextArea
                value={voice.customSystemPrompt}
                onChange={(value) =>
                  updateVoice(
                    { customSystemPrompt: value },
                    'customSystemPrompt',
                  )
                }
                placeholder="Polish the spoken transcript into JSON: { action, text }"
              />
            </ObsidianSetting>
          )}

          <ObsidianSetting
            name={t(
              'settings.contextVoiceInput.pauseTabCompletion',
              'Pause Tab Completion while listening',
            )}
            desc={t(
              'settings.contextVoiceInput.pauseTabCompletionDesc',
              'Recommended — keeps Tab ghost text from competing for the cursor while voice input owns it.',
            )}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={voice.pauseTabCompletionWhileListening}
              onChange={(value) =>
                updateVoice(
                  { pauseTabCompletionWhileListening: value },
                  'pauseTabCompletionWhileListening',
                )
              }
            />
          </ObsidianSetting>

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
              'After-cursor budget (characters)',
            )}
            desc={t(
              'settings.contextVoiceInput.maxAfterContextCharsDesc',
              'Cap for the post-cursor slice of the context window. Helps the model decide whether to extend or interrupt the next sentence.',
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
        </div>
      </section>
    </div>
  )
}
