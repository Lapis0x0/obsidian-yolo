import { Settings } from 'lucide-react'
import { App } from 'obsidian'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import { getBuiltinToolUiMeta } from '../../../core/agent/builtinToolUiMeta'
import {
  getAssistantToolApprovalMode,
  isAssistantToolEnabled,
} from '../../../core/agent/tool-preferences'
import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { MODEL_TASK_SOURCE_TOOL_NAME_LIST } from '../../../core/mcp/modelTaskTool'
import { getToolName, parseToolName } from '../../../core/mcp/tool-name-utils'
import YoloPlugin from '../../../main'
import type { Assistant } from '../../../types/assistant.types'
import type { McpTool } from '../../../types/mcp.types'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'
import { getChatModelDisplayLabel } from '../modelSelectOptions'

type AgentModelToolsSettingsModalProps = {
  app: App
  plugin: YoloPlugin
  assistant: Assistant
  availableTools: McpTool[]
  onChange: (assistant: Assistant) => void
}

export class AgentModelToolsSettingsModal extends ReactModal<AgentModelToolsSettingsModalProps> {
  constructor(
    app: App,
    plugin: YoloPlugin,
    props: Omit<AgentModelToolsSettingsModalProps, 'app' | 'plugin'>,
  ) {
    super({
      app,
      Component: Wrapper,
      props: { app, plugin, ...props },
      options: {
        title: plugin.t(
          'settings.agent.modelToolsAgentConfigure',
          'Agent sub-model task toolset',
        ),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function Wrapper({
  plugin,
  assistant,
  availableTools,
  onChange,
  onClose: _onClose,
}: AgentModelToolsSettingsModalProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(settings) => plugin.setSettings(settings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <Content
        assistant={assistant}
        availableTools={availableTools}
        onChange={onChange}
      />
    </SettingsProvider>
  )
}

function Content({
  assistant,
  availableTools,
  onChange,
}: {
  assistant: Assistant
  availableTools: McpTool[]
  onChange: (assistant: Assistant) => void
}) {
  const { t } = useLanguage()
  const { settings } = useSettings()
  const [draftAssistant, setDraftAssistant] = useState(assistant)
  const localServerName = getLocalFileToolServerName()
  const options = draftAssistant.modelToolOptions ?? {}
  const childToolsEnabled = options.childToolsEnabled ?? true
  const mcpSourceToolsEnabled = options.mcpSourceToolsEnabled ?? false

  const configuredModels = useMemo(() => {
    const modelById = new Map(
      settings.chatModels.map((model) => [model.id, model]),
    )
    const categoryById = new Map(
      settings.agentLlmTools.categories.map((category) => [
        category.id,
        category,
      ]),
    )
    return settings.agentLlmTools.modelTools.flatMap((modelTool) => {
      if (!modelTool.enabled) {
        return []
      }
      const model = modelById.get(modelTool.modelId)
      if (!model || !(model.enable ?? true)) {
        return []
      }
      const category = categoryById.get(modelTool.categoryId)
      return [
        {
          id: model.id,
          label: getChatModelDisplayLabel(model),
          categoryName: category?.name ?? modelTool.categoryId,
          categoryDescription: category?.description,
          meta: [
            model.providerId,
            model.model,
            model.maxContextTokens ? `ctx ${model.maxContextTokens}` : null,
            model.maxOutputTokens ? `out ${model.maxOutputTokens}` : null,
            model.modalities?.join(', '),
          ]
            .filter(Boolean)
            .join(' | '),
        },
      ]
    })
  }, [
    settings.agentLlmTools.categories,
    settings.agentLlmTools.modelTools,
    settings.chatModels,
  ])

  const allModelIds = configuredModels.map((model) => model.id)
  const enabledModelIds = new Set(options.allowedModelIds ?? allModelIds)

  const availableToolNames = new Set(availableTools.map((tool) => tool.name))
  const localSourceTools =
    draftAssistant.includeBuiltinTools === false
      ? []
      : MODEL_TASK_SOURCE_TOOL_NAME_LIST.flatMap((toolName) => {
          const fullName = getToolName(localServerName, toolName)
          if (!availableToolNames.has(fullName)) {
            return []
          }
          if (
            !isAssistantToolEnabled(draftAssistant, fullName) ||
            getAssistantToolApprovalMode(draftAssistant, fullName) !==
              'full_access'
          ) {
            return []
          }
          const meta = getBuiltinToolUiMeta(toolName)
          return [
            {
              id: toolName,
              label: meta ? t(meta.labelKey, meta.labelFallback) : toolName,
              description: meta
                ? t(meta.descKey ?? '', meta.descFallback)
                : toolName,
            },
          ]
        })
  const mcpSourceTools = mcpSourceToolsEnabled
    ? availableTools.flatMap((tool) => {
        let parsed: ReturnType<typeof parseToolName>
        try {
          parsed = parseToolName(tool.name)
        } catch {
          return []
        }
        if (parsed.serverName === localServerName) {
          return []
        }
        if (
          !isAssistantToolEnabled(draftAssistant, tool.name) ||
          getAssistantToolApprovalMode(draftAssistant, tool.name) !==
            'full_access'
        ) {
          return []
        }
        return [
          {
            id: tool.name,
            label: parsed.toolName,
            description:
              tool.description ??
              t(
                'settings.agent.modelToolsMcpSourceToolDesc',
                'MCP source tool. Only enable tools you trust to return read-only text.',
              ),
            serverName: parsed.serverName,
          },
        ]
      })
    : []
  const sourceTools = [...localSourceTools, ...mcpSourceTools]
  const allSourceToolNames = sourceTools.map((tool) => tool.id)
  const defaultEnabledSourceToolNames = localSourceTools.map((tool) => tool.id)
  const enabledSourceToolNames = new Set(
    options.enabledSourceToolNames ?? defaultEnabledSourceToolNames,
  )

  const updateOptions = (patch: NonNullable<Assistant['modelToolOptions']>) => {
    const nextAssistant = {
      ...draftAssistant,
      modelToolOptions: {
        ...options,
        ...patch,
      },
      modelToolModelId: undefined,
    }
    setDraftAssistant(nextAssistant)
    onChange(nextAssistant)
  }

  const setModelEnabled = (modelId: string, enabled: boolean) => {
    const next = new Set(enabledModelIds)
    if (enabled) {
      next.add(modelId)
    } else {
      next.delete(modelId)
    }
    const nextIds = allModelIds.filter((id) => next.has(id))
    updateOptions({
      allowedModelIds:
        nextIds.length === allModelIds.length ? undefined : nextIds,
    })
  }

  const setSourceToolEnabled = (toolName: string, enabled: boolean) => {
    const next = new Set(enabledSourceToolNames)
    if (enabled) {
      next.add(toolName)
    } else {
      next.delete(toolName)
    }
    const nextNames = allSourceToolNames.filter((name) => next.has(name))
    const matchesDefault =
      nextNames.length === defaultEnabledSourceToolNames.length &&
      defaultEnabledSourceToolNames.every((name) => next.has(name))
    updateOptions({
      enabledSourceToolNames: matchesDefault ? undefined : nextNames,
    })
  }

  const setMcpSourceToolsEnabled = (enabled: boolean) => {
    const currentNames = options.enabledSourceToolNames
    const nextNames = enabled
      ? currentNames
      : currentNames?.filter((toolName) => !toolName.includes('__'))
    const localDefault =
      nextNames !== undefined &&
      nextNames.length === defaultEnabledSourceToolNames.length &&
      defaultEnabledSourceToolNames.every((name) => nextNames.includes(name))
    updateOptions({
      mcpSourceToolsEnabled: enabled,
      enabledSourceToolNames: localDefault ? undefined : nextNames,
    })
  }

  return (
    <div className="yolo-agent-model-tools-modal">
      <div className="yolo-ws-intro">
        {t(
          'settings.agent.modelToolsAgentConfigureDesc',
          'Choose which models and read-only source tools this agent can use for delegated sub-model tasks.',
        )}
      </div>

      <section className="yolo-ws-section">
        <div className="yolo-ws-section-head">
          <div className="yolo-ws-section-label">
            {t('settings.agent.modelToolsAgentModels', 'Callable models')}
          </div>
        </div>
        {configuredModels.length === 0 ? (
          <div className="yolo-ws-empty">
            {t(
              'settings.agent.modelToolsEmpty',
              'Add a chat model to make it available through the sub-model task toolset.',
            )}
          </div>
        ) : (
          <div className="yolo-agent-model-tools-list">
            {configuredModels.map((model) => (
              <div key={model.id} className="yolo-agent-model-tools-row">
                <Settings size={16} className="yolo-agent-model-tools-icon" />
                <div className="yolo-agent-model-tools-main">
                  <div className="yolo-agent-model-tools-name">
                    <span>{model.label}</span>
                    <span
                      className="yolo-agent-model-tools-category"
                      title={model.categoryDescription}
                    >
                      {model.categoryName}
                    </span>
                  </div>
                  <div className="yolo-agent-model-tools-desc">
                    {model.meta}
                  </div>
                </div>
                <ObsidianToggle
                  value={enabledModelIds.has(model.id)}
                  onChange={(value) => setModelEnabled(model.id, value)}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="yolo-ws-section">
        <div className="yolo-agent-model-tools-toggle-row">
          <div className="yolo-agent-model-tools-toggle-main">
            <div className="yolo-ws-section-label">
              {t(
                'settings.agent.modelToolsChildToolsEnabled',
                'Allow source tools for sub-model tasks',
              )}
            </div>
            <div className="yolo-ws-field-hint">
              {t(
                'settings.agent.modelToolsChildToolsEnabledDesc',
                'When off, sub-model tasks can still run direct prompts, but cannot attach file or web source tool results.',
              )}
            </div>
          </div>
          <ObsidianToggle
            value={childToolsEnabled}
            onChange={(value) =>
              updateOptions({
                childToolsEnabled: value,
              })
            }
          />
        </div>
      </div>

      {childToolsEnabled && (
        <section className="yolo-ws-section">
          <div className="yolo-agent-model-tools-source-toggle yolo-agent-model-tools-toggle-row">
            <div className="yolo-agent-model-tools-toggle-main">
              <div className="yolo-ws-section-label">
                {t(
                  'settings.agent.modelToolsMcpSourceToolsEnabled',
                  'Allow MCP source tools',
                )}
              </div>
              <div className="yolo-ws-field-hint">
                {t(
                  'settings.agent.modelToolsMcpSourceToolsEnabledDesc',
                  'When enabled, sub-model tasks can call the MCP tools you select below as model input. Only tools already enabled and set to full access on the parent tool page can be selected. Do not select non-read-only tools.',
                )}
              </div>
            </div>
            <ObsidianToggle
              value={mcpSourceToolsEnabled}
              onChange={setMcpSourceToolsEnabled}
            />
          </div>
          <div className="yolo-ws-section-head yolo-agent-model-tools-source-heading">
            <div className="yolo-ws-section-label">
              {t(
                'settings.agent.modelToolsAgentSourceTools',
                'Source tools available to sub-model tasks',
              )}
            </div>
          </div>
          {sourceTools.length === 0 ? (
            <div className="yolo-ws-empty">
              {t(
                'settings.agent.modelToolsAgentNoSourceTools',
                'No read-only source tools are currently enabled with full access for this agent.',
              )}
            </div>
          ) : (
            <div className="yolo-agent-model-tools-list">
              {sourceTools.map((tool) => (
                <div key={tool.id} className="yolo-agent-model-tools-row">
                  <div className="yolo-agent-model-tools-main">
                    <div className="yolo-agent-model-tools-name">
                      <span>{tool.label}</span>
                      {'serverName' in tool && (
                        <span className="yolo-agent-model-tools-category">
                          {tool.serverName}
                        </span>
                      )}
                    </div>
                    <div className="yolo-agent-model-tools-desc">
                      {tool.description}
                    </div>
                  </div>
                  <ObsidianToggle
                    value={enabledSourceToolNames.has(tool.id)}
                    onChange={(value) => setSourceToolEnabled(tool.id, value)}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
