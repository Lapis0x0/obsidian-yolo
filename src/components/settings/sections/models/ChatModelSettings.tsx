import { App, Notice } from 'obsidian'
import { useState } from 'react'

import SmartComposerPlugin from '../../../../main'
import { ChatModel } from '../../../../types/chat-model.types'
import { ObsidianButton } from '../../../common/ObsidianButton'
import { ObsidianDropdown } from '../../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../../common/ObsidianSetting'
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
