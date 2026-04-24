import { Settings } from 'lucide-react'
import { App } from 'obsidian'
import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import {
  BUILTIN_TOOL_CATEGORY_I18N,
  BUILTIN_TOOL_CATEGORY_ORDER,
  BuiltinToolCategory,
  FILE_OPS_GROUP_TOOL_NAME,
  MEMORY_OPS_GROUP_TOOL_NAME,
  WEB_OPS_GROUP_TOOL_NAME,
  WEB_OPS_SPLIT_ACTION_TOOL_NAMES,
  getBuiltinToolCategory,
  getBuiltinToolUiMeta,
} from '../../../core/agent/builtinToolUiMeta'
import {
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  getLocalFileTools,
} from '../../../core/mcp/localFileTools'
import SmartComposerPlugin from '../../../main'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'
import { McpSection } from '../sections/McpSection'
import { WebSearchSettingsModal } from './WebSearchSettingsModal'

type AgentToolsModalProps = {
  app: App
  plugin: SmartComposerPlugin
}

const SPLIT_FS_TOOL_NAME_SET = new Set<string>(LOCAL_FS_SPLIT_ACTION_TOOL_NAMES)
const SPLIT_MEMORY_TOOL_NAME_SET = new Set<string>(
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
)
const SPLIT_WEB_TOOL_NAME_SET = new Set<string>(WEB_OPS_SPLIT_ACTION_TOOL_NAMES)

export class AgentToolsModal extends ReactModal<AgentToolsModalProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app,
      Component: AgentToolsModalWrapper,
      props: { app, plugin },
      options: {
        title: plugin.t('settings.agent.manageTools'),
      },
      plugin,
    })
    this.modalEl.classList.add('smtcmp-modal--wide')
  }
}

function AgentToolsModalWrapper({
  app,
  plugin,
  onClose: _onClose,
}: AgentToolsModalProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <AgentToolsModalContent app={app} plugin={plugin} />
    </SettingsProvider>
  )
}

function AgentToolsModalContent({
  app,
  plugin,
}: {
  app: App
  plugin: SmartComposerPlugin
}) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()

  const builtinToolGroups = useMemo(() => {
    const toolOptions = settings.mcp.builtinToolOptions
    const tools = getLocalFileTools()
      .filter(
        (tool) =>
          !SPLIT_FS_TOOL_NAME_SET.has(tool.name) &&
          !SPLIT_MEMORY_TOOL_NAME_SET.has(tool.name) &&
          !SPLIT_WEB_TOOL_NAME_SET.has(tool.name),
      )
      .map((tool) => {
        const meta = getBuiltinToolUiMeta(tool.name)
        return {
          id: tool.name,
          label: meta ? t(meta.labelKey, meta.labelFallback) : tool.name,
          description: meta
            ? t(meta.descKey ?? '', meta.descFallback)
            : tool.description,
          enabled: !(toolOptions[tool.name]?.disabled ?? false),
          hasSettings: false,
        }
      })

    const splitToolEnabled = LOCAL_FS_SPLIT_ACTION_TOOL_NAMES.every(
      (toolName) =>
        !(toolOptions[toolName]?.disabled ?? false) &&
        !(toolOptions[FILE_OPS_GROUP_TOOL_NAME]?.disabled ?? false),
    )
    const fileOpsMeta = getBuiltinToolUiMeta(FILE_OPS_GROUP_TOOL_NAME)
    if (!fileOpsMeta) {
      throw new Error('Missing built-in tool UI metadata for fs_file_ops')
    }
    const fileOpsTool = {
      id: FILE_OPS_GROUP_TOOL_NAME,
      label: t(fileOpsMeta.labelKey, fileOpsMeta.labelFallback),
      description: t(fileOpsMeta.descKey ?? '', fileOpsMeta.descFallback),
      enabled: splitToolEnabled,
      hasSettings: false,
    }

    const memorySplitToolEnabled = LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES.every(
      (toolName) =>
        !(toolOptions[toolName]?.disabled ?? false) &&
        !(toolOptions[MEMORY_OPS_GROUP_TOOL_NAME]?.disabled ?? false),
    )
    const memoryOpsMeta = getBuiltinToolUiMeta(MEMORY_OPS_GROUP_TOOL_NAME)
    if (!memoryOpsMeta) {
      throw new Error('Missing built-in tool UI metadata for memory_ops')
    }
    const memoryOpsTool = {
      id: MEMORY_OPS_GROUP_TOOL_NAME,
      label: t(memoryOpsMeta.labelKey, memoryOpsMeta.labelFallback),
      description: t(memoryOpsMeta.descKey ?? '', memoryOpsMeta.descFallback),
      enabled: memorySplitToolEnabled,
      hasSettings: false,
    }

    const webSplitToolEnabled = WEB_OPS_SPLIT_ACTION_TOOL_NAMES.every(
      (toolName) =>
        !(toolOptions[toolName]?.disabled ?? false) &&
        !(toolOptions[WEB_OPS_GROUP_TOOL_NAME]?.disabled ?? false),
    )
    const webOpsMeta = getBuiltinToolUiMeta(WEB_OPS_GROUP_TOOL_NAME)
    if (!webOpsMeta) {
      throw new Error('Missing built-in tool UI metadata for web_ops')
    }
    const webOpsTool = {
      id: WEB_OPS_GROUP_TOOL_NAME,
      label: t(webOpsMeta.labelKey, webOpsMeta.labelFallback),
      description: t(webOpsMeta.descKey ?? '', webOpsMeta.descFallback),
      enabled: webSplitToolEnabled,
      hasSettings: true,
    }

    const allTools = [...tools, fileOpsTool, memoryOpsTool, webOpsTool]

    const byCategory = new Map<BuiltinToolCategory, typeof allTools>()
    for (const category of BUILTIN_TOOL_CATEGORY_ORDER) {
      byCategory.set(category, [])
    }
    for (const tool of allTools) {
      const category = getBuiltinToolCategory(tool.id) ?? 'vault'
      byCategory.get(category)!.push(tool)
    }

    return BUILTIN_TOOL_CATEGORY_ORDER.map((category) => ({
      category,
      title: t(
        BUILTIN_TOOL_CATEGORY_I18N[category].key,
        BUILTIN_TOOL_CATEGORY_I18N[category].fallback,
      ),
      tools: byCategory.get(category) ?? [],
    })).filter((group) => group.tools.length > 0)
  }, [settings.mcp.builtinToolOptions, t])

  const handleToggleBuiltinTool = (toolName: string, enabled: boolean) => {
    const targets =
      toolName === FILE_OPS_GROUP_TOOL_NAME
        ? [FILE_OPS_GROUP_TOOL_NAME, ...LOCAL_FS_SPLIT_ACTION_TOOL_NAMES]
        : toolName === MEMORY_OPS_GROUP_TOOL_NAME
          ? [
              MEMORY_OPS_GROUP_TOOL_NAME,
              ...LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
            ]
          : toolName === WEB_OPS_GROUP_TOOL_NAME
            ? [WEB_OPS_GROUP_TOOL_NAME, ...WEB_OPS_SPLIT_ACTION_TOOL_NAMES]
            : [toolName]
    const nextBuiltinToolOptions = { ...settings.mcp.builtinToolOptions }
    for (const target of targets) {
      nextBuiltinToolOptions[target] = {
        ...settings.mcp.builtinToolOptions[target],
        disabled: !enabled,
      }
    }

    void setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        builtinToolOptions: nextBuiltinToolOptions,
      },
    })
  }

  return (
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-desc smtcmp-settings-callout">
        {t(
          'settings.agent.desc',
          'Manage global capabilities and configure your agents.',
        )}
      </div>

      {builtinToolGroups.map((group) => (
        <div key={group.category}>
          <div className="smtcmp-settings-sub-header">
            <span className="smtcmp-agent-tools-section-title">
              <span>{group.title}</span>
            </span>
          </div>
          <div className="smtcmp-mcp-servers-container smtcmp-builtin-tools-table">
            <div className="smtcmp-mcp-servers-header smtcmp-builtin-tools-table-header">
              <div>{t('settings.mcp.tools', 'Tools')}</div>
              <div>{t('settings.agent.descriptionColumn', 'Description')}</div>
              <div>{t('settings.mcp.enabled', 'Enabled')}</div>
              <div />
            </div>
            <div className="smtcmp-mcp-server smtcmp-builtin-tools-table-body">
              {group.tools.map((tool) => (
                <div
                  key={tool.id}
                  className="smtcmp-mcp-server-row smtcmp-builtin-tools-table-row"
                >
                  <div className="smtcmp-mcp-server-name">{tool.label}</div>
                  <div className="smtcmp-mcp-server-status smtcmp-builtin-tools-table-description">
                    <div className="smtcmp-mcp-tool-description">
                      {tool.description}
                    </div>
                  </div>
                  <div className="smtcmp-mcp-server-toggle">
                    <ObsidianToggle
                      value={tool.enabled}
                      onChange={(enabled) =>
                        handleToggleBuiltinTool(tool.id, enabled)
                      }
                    />
                  </div>
                  <div className="smtcmp-builtin-tools-table-action">
                    {tool.hasSettings ? (
                      <button
                        type="button"
                        className="clickable-icon"
                        aria-label={t(
                          'settings.webSearch.openSettings',
                          'Configure web search providers',
                        )}
                        onClick={() =>
                          new WebSearchSettingsModal(app, plugin).open()
                        }
                      >
                        <Settings size={16} />
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}

      <McpSection app={app} plugin={plugin} embedded />
    </div>
  )
}
