import { App, Notice } from 'obsidian'
import { useState } from 'react'

import SmartComposerPlugin from '../../../../main'
import { ChatModel, chatModelSchema } from '../../../../types/chat-model.types'
import { ObsidianButton } from '../../../common/ObsidianButton'
import { ObsidianDropdown } from '../../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../../common/ObsidianToggle'
import { ReactModal } from '../../../common/ReactModal'

type SettingsComponentProps = {
  model: ChatModel
  plugin: SmartComposerPlugin
}

export class ChatModelSettingsModal extends ReactModal<SettingsComponentProps> {
  constructor(model: ChatModel, app: App, plugin: SmartComposerPlugin) {
    const modelSettings = getModelSettings(model)
    super({
      app: app,
      Component: modelSettings
        ? modelSettings.SettingsComponent
        : () => <div>No settings available for this model</div>,
      props: { model, plugin },
      options: {
        title: `Edit Chat Model: ${model.id}`,
      },
    })
  }
}

type ModelSettingsRegistry = {
  check: (model: ChatModel) => boolean
  SettingsComponent: React.FC<SettingsComponentProps & { onClose: () => void }>
}

/**
 * Registry of available model settings.
 *
 * The check function is used to determine if the model settings should be displayed.
 * The SettingsComponent is the component that will be displayed when the model settings are opened.
 */
const MODEL_SETTINGS_REGISTRY: ModelSettingsRegistry[] = [
  /**
   * Claude model settings
   *
   * For extended thinking, see:
   * @see https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
   */
  {
    check: (model) => typeof model.thinking?.budget_tokens === 'number',
    SettingsComponent: (props) => {
      const DEFAULT_THINKING_BUDGET_TOKENS = 8192

      const { model, plugin, onClose } = props
      const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(
        model.thinking?.enabled ?? false,
      )
      const [budgetTokens, setBudgetTokens] = useState(
        (
          model.thinking?.budget_tokens ?? DEFAULT_THINKING_BUDGET_TOKENS
        ).toString(),
      )

      const handleSubmit = async () => {
        const parsedTokens = parseInt(budgetTokens, 10)
        if (isNaN(parsedTokens)) {
          new Notice('Please enter a valid number')
          return
        }

        if (parsedTokens < 1024) {
          new Notice('Budget tokens must be at least 1024')
          return
        }

        const updatedModel = {
          ...model,
          thinking: {
            enabled: thinkingEnabled,
            budget_tokens: parsedTokens,
          },
        }

        const validationResult = chatModelSchema.safeParse(updatedModel)
        if (!validationResult.success) {
          new Notice(
            validationResult.error.issues.map((v) => v.message).join('\n'),
          )
          return
        }

        await plugin.setSettings({
          ...plugin.settings,
          chatModels: plugin.settings.chatModels.map((m) =>
            m.id === model.id ? updatedModel : m,
          ),
        })
        onClose()
      }

      return (
        <>
          <ObsidianSetting
            name="Extended Thinking"
            desc="Enable extended thinking for Claude. Available for Claude Sonnet 3.7+ and Claude Opus 4.0+."
          >
            <ObsidianToggle
              value={thinkingEnabled}
              onChange={(value: boolean) => setThinkingEnabled(value)}
            />
          </ObsidianSetting>
          {thinkingEnabled && (
            <ObsidianSetting
              name="Budget Tokens"
              desc="The maximum number of tokens that Claude can use for thinking. Must be at least 1024."
              className="smtcmp-setting-item--nested"
              required
            >
              <ObsidianTextInput
                value={budgetTokens}
                placeholder="Number of tokens"
                onChange={(value: string) => setBudgetTokens(value)}
                type="number"
              />
            </ObsidianSetting>
          )}

          <ObsidianSetting>
            <ObsidianButton
              text="Save"
              onClick={() => {
                handleSubmit().catch((error) => {
                  console.error(
                    'Failed to save anthropic model settings',
                    error,
                  )
                })
              }}
              cta
            />
            <ObsidianButton text="Cancel" onClick={onClose} />
          </ObsidianSetting>
        </>
      )
    },
  },

  // Perplexity settings
  {
    check: (model) =>
      [
        'sonar',
        'sonar-pro',
        'sonar-deep-research',
        'sonar-reasoning',
        'sonar-reasoning-pro',
      ].includes(model.model),

    SettingsComponent: (props) => {
      const { model, plugin, onClose } = props
      const [searchContextSize, setSearchContextSize] = useState(
        model.web_search_options?.search_context_size ?? 'low',
      )

      const handleSubmit = async () => {
        if (!['low', 'medium', 'high'].includes(searchContextSize)) {
          new Notice(
            'Search context size must be one of "low", "medium", "high"',
          )
          return
        }

        const updatedModel = {
          ...model,
          web_search_options: {
            ...model.web_search_options,
            search_context_size: searchContextSize,
          },
        }
        await plugin.setSettings({
          ...plugin.settings,
          chatModels: plugin.settings.chatModels.map((m) =>
            m.id === model.id ? updatedModel : m,
          ),
        })
        onClose()
      }

      return (
        <>
          <ObsidianSetting
            name="Search Context Size"
            desc={`Determines how much search context is retrieved for the model. Choose "low" for minimal context and lower costs, "medium" for a balanced approach, or "high" for maximum context at higher cost. Default is "low".`}
          >
            <ObsidianDropdown
              value={searchContextSize}
              options={{
                low: 'low',
                medium: 'medium',
                high: 'high',
              }}
              onChange={(value: string) => setSearchContextSize(value)}
            />
          </ObsidianSetting>

          <ObsidianSetting>
            <ObsidianButton
              text="Save"
              onClick={() => {
                handleSubmit().catch((error) => {
                  console.error(
                    'Failed to save perplexity model settings',
                    error,
                  )
                })
              }}
              cta
            />
            <ObsidianButton text="Cancel" onClick={onClose} />
          </ObsidianSetting>
        </>
      )
    },
  },
]

function getModelSettings(model: ChatModel): ModelSettingsRegistry | undefined {
  return MODEL_SETTINGS_REGISTRY.find((registry) => registry.check(model))
}

export function hasChatModelSettings(model: ChatModel): boolean {
  return !!getModelSettings(model)
}
