import { Plus, Trash2 } from 'lucide-react'
import { App } from 'obsidian'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import YoloPlugin from '../../../main'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'
import { SimpleSelect } from '../../common/SimpleSelect'
import {
  buildChatModelOptionGroups,
  getChatModelDisplayLabel,
} from '../modelSelectOptions'

type ModelToolsSettingsModalProps = {
  app: App
  plugin: YoloPlugin
}

export class ModelToolsSettingsModal extends ReactModal<ModelToolsSettingsModalProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: Wrapper,
      props: { app, plugin },
      options: {
        title: plugin.t(
          'settings.agent.modelToolsTitle',
          'Sub-model task toolset',
        ),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function Wrapper({
  plugin,
  onClose: _onClose,
}: ModelToolsSettingsModalProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(settings) => plugin.setSettings(settings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <Content />
    </SettingsProvider>
  )
}

function Content() {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const [selectedAddModelId, setSelectedAddModelId] = useState('')
  const agentLlmTools = settings.agentLlmTools
  const enabledChatModels = useMemo(
    () => settings.chatModels.filter((model) => model.enable ?? true),
    [settings.chatModels],
  )
  const configuredModelIds = useMemo(
    () => new Set(agentLlmTools.modelTools.map((tool) => tool.modelId)),
    [agentLlmTools.modelTools],
  )
  const addableModelGroups = useMemo(
    () =>
      buildChatModelOptionGroups({
        chatModels: enabledChatModels,
        providers: settings.providers,
        excludeModelIds: configuredModelIds,
      }),
    [enabledChatModels, configuredModelIds, settings.providers],
  )
  const addableModelIds = new Set(
    addableModelGroups.flatMap((group) =>
      group.options.map((option) => option.value),
    ),
  )
  const selectedAddModelValue = addableModelIds.has(selectedAddModelId)
    ? selectedAddModelId
    : (addableModelGroups[0]?.options[0]?.value ?? '')
  const categoryOptions = agentLlmTools.categories.map((category) => ({
    value: category.id,
    label: category.name,
  }))
  const modelById = new Map(
    settings.chatModels.map((model) => [model.id, model]),
  )
  const getModelMeta = (model: (typeof settings.chatModels)[number]) =>
    [
      model.providerId,
      model.model,
      model.maxContextTokens ? `ctx ${model.maxContextTokens}` : null,
      model.maxOutputTokens ? `out ${model.maxOutputTokens}` : null,
      model.modalities?.join(', '),
    ]
      .filter(Boolean)
      .join(' | ')

  const updateAgentLlmTools = (next: typeof settings.agentLlmTools): void => {
    void setSettings({
      ...settings,
      agentLlmTools: next,
    })
  }

  const handleAddModelTool = () => {
    if (!selectedAddModelValue) {
      return
    }
    updateAgentLlmTools({
      ...agentLlmTools,
      modelTools: [
        ...agentLlmTools.modelTools,
        {
          id: crypto.randomUUID(),
          modelId: selectedAddModelValue,
          categoryId: agentLlmTools.categories[0]?.id ?? 'economy',
          enabled: true,
        },
      ],
    })
    setSelectedAddModelId('')
  }

  const updateModelTool = (
    id: string,
    patch: Partial<(typeof agentLlmTools.modelTools)[number]>,
  ) => {
    updateAgentLlmTools({
      ...agentLlmTools,
      modelTools: agentLlmTools.modelTools.map((tool) =>
        tool.id === id ? { ...tool, ...patch } : tool,
      ),
    })
  }

  const removeModelTool = (id: string) => {
    updateAgentLlmTools({
      ...agentLlmTools,
      modelTools: agentLlmTools.modelTools.filter((tool) => tool.id !== id),
    })
  }

  const updateCategory = (
    id: string,
    patch: Partial<(typeof agentLlmTools.categories)[number]>,
  ) => {
    updateAgentLlmTools({
      ...agentLlmTools,
      categories: agentLlmTools.categories.map((category) =>
        category.id === id ? { ...category, ...patch } : category,
      ),
    })
  }

  return (
    <div className="yolo-model-tools">
      <div className="yolo-ws-intro">
        {t(
          'settings.agent.modelToolsDesc',
          'Configure models agents can call through the sub-model task toolset.',
        )}
      </div>

      <div className="yolo-model-tools-sections">
        <section className="yolo-ws-section yolo-model-tools-section">
          <div className="yolo-ws-section-head">
            <div className="yolo-ws-section-label">
              {t('settings.agent.modelToolsAddColumn', 'Add model')}
            </div>
          </div>
          <div className="yolo-model-tools-add">
            {addableModelGroups.length > 0 ? (
              <SimpleSelect
                value={selectedAddModelValue}
                groupedOptions={addableModelGroups}
                onChange={setSelectedAddModelId}
                align="start"
                contentClassName="yolo-agent-model-select-content"
              />
            ) : (
              <div className="yolo-model-tools-empty">
                {enabledChatModels.length === 0
                  ? t(
                      'settings.agent.modelToolsNoChatModels',
                      'No enabled chat models are available.',
                    )
                  : t(
                      'settings.agent.modelToolsAllAdded',
                      'All enabled chat models have been added.',
                    )}
              </div>
            )}
            <button
              type="button"
              className="yolo-ws-add-btn"
              disabled={!selectedAddModelValue}
              onClick={handleAddModelTool}
            >
              <Plus size={12} />
              {t('settings.agent.modelToolsAdd', 'Add model')}
            </button>
          </div>
        </section>

        <section className="yolo-ws-section yolo-model-tools-section">
          <div className="yolo-ws-section-head">
            <div className="yolo-ws-section-label">
              {t('settings.agent.modelToolsModelsColumn', 'Model settings')}
            </div>
          </div>
          <div className="yolo-model-tools-list">
            {agentLlmTools.modelTools.length === 0 ? (
              <div className="yolo-model-tools-empty">
                {t(
                  'settings.agent.modelToolsEmpty',
                  'Add a chat model to make it available to agents.',
                )}
              </div>
            ) : (
              agentLlmTools.modelTools.map((tool) => {
                const model = modelById.get(tool.modelId)
                const modelLabel = model
                  ? getChatModelDisplayLabel(model)
                  : tool.modelId
                return (
                  <div key={tool.id} className="yolo-model-tools-model-row">
                    <div className="yolo-model-tools-model-main">
                      <div className="yolo-model-tools-model-name">
                        {modelLabel}
                      </div>
                      <div className="yolo-model-tools-model-meta">
                        {model
                          ? getModelMeta(model)
                          : t(
                              'settings.agent.modelToolsMissingModel',
                              'Model no longer exists',
                            )}
                      </div>
                    </div>
                    <div className="yolo-model-tools-model-controls">
                      <SimpleSelect
                        value={tool.categoryId}
                        options={categoryOptions}
                        onChange={(categoryId) =>
                          updateModelTool(tool.id, { categoryId })
                        }
                        align="end"
                      />
                      <ObsidianToggle
                        value={tool.enabled}
                        onChange={(enabled) =>
                          updateModelTool(tool.id, { enabled })
                        }
                      />
                      <button
                        type="button"
                        className="yolo-ws-icon-btn"
                        aria-label={t('common.delete', 'Delete')}
                        onClick={() => removeModelTool(tool.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="yolo-ws-section yolo-model-tools-section">
          <div className="yolo-ws-section-head">
            <div className="yolo-ws-section-label">
              {t(
                'settings.agent.modelToolsCategoriesColumn',
                'Category prompts',
              )}
            </div>
          </div>
          <div className="yolo-model-tools-category-list">
            {agentLlmTools.categories.map((category) => (
              <div key={category.id} className="yolo-model-tools-category">
                <input
                  type="text"
                  value={category.name}
                  aria-label={t(
                    'settings.agent.modelToolCategoryName',
                    'Category',
                  )}
                  onChange={(event) => {
                    const name = event.currentTarget.value
                    if (name.trim().length > 0) {
                      updateCategory(category.id, { name })
                    }
                  }}
                />
                <textarea
                  value={category.description}
                  aria-label={t(
                    'settings.agent.modelToolCategoryDescription',
                    'Category description',
                  )}
                  onChange={(event) =>
                    updateCategory(category.id, {
                      description: event.currentTarget.value,
                    })
                  }
                />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
