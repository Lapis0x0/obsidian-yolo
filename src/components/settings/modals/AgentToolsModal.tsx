import { App } from 'obsidian'
import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import { getLocalFileTools } from '../../../core/mcp/localFileTools'
import SmartComposerPlugin from '../../../main'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'
import { McpSection } from '../sections/McpSection'

type AgentToolsModalProps = {
  app: App
  plugin: SmartComposerPlugin
}

const BUILTIN_TOOL_I18N_KEYS: Record<
  string,
  {
    labelKey: string
    descKey: string
    labelFallback: string
    descFallback: string
  }
> = {
  fs_list: {
    labelKey: 'settings.agent.builtinFsListLabel',
    descKey: 'settings.agent.builtinFsListDesc',
    labelFallback: 'Read Vault',
    descFallback:
      'List directory structure under a vault path. Useful for workspace orientation.',
  },
  fs_search: {
    labelKey: 'settings.agent.builtinFsSearchLabel',
    descKey: 'settings.agent.builtinFsSearchDesc',
    labelFallback: 'Search Vault',
    descFallback: 'Search files, folders, or markdown content in vault.',
  },
  fs_read: {
    labelKey: 'settings.agent.builtinFsReadLabel',
    descKey: 'settings.agent.builtinFsReadDesc',
    labelFallback: 'Read File',
    descFallback: 'Read line ranges from multiple vault files by path.',
  },
  fs_edit: {
    labelKey: 'settings.agent.builtinFsEditLabel',
    descKey: 'settings.agent.builtinFsEditDesc',
    labelFallback: 'Text Editing',
    descFallback:
      'Apply text edit operations within a single existing file, including replace, insert_after, and append.',
  },
  fs_file_ops: {
    labelKey: 'settings.agent.builtinFsFileOpsLabel',
    descKey: 'settings.agent.builtinFsFileOpsDesc',
    labelFallback: 'File Operations',
    descFallback: 'Create, move, and delete files or folders in the vault.',
  },
  open_skill: {
    labelKey: 'settings.agent.builtinOpenSkillLabel',
    descKey: 'settings.agent.builtinOpenSkillDesc',
    labelFallback: 'Open Skill',
    descFallback: 'Load a skill markdown file by id or name.',
  },
}

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

  const builtinTools = useMemo(
    () =>
      getLocalFileTools().map((tool) => {
        const meta = BUILTIN_TOOL_I18N_KEYS[tool.name]
        return {
          id: tool.name,
          label: meta ? t(meta.labelKey, meta.labelFallback) : tool.name,
          description: meta
            ? t(meta.descKey, meta.descFallback)
            : tool.description,
          enabled: !(
            settings.mcp.builtinToolOptions[tool.name]?.disabled ?? false
          ),
        }
      }),
    [settings.mcp.builtinToolOptions, t],
  )

  const handleToggleBuiltinTool = (toolName: string, enabled: boolean) => {
    void setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        builtinToolOptions: {
          ...settings.mcp.builtinToolOptions,
          [toolName]: {
            ...settings.mcp.builtinToolOptions[toolName],
            disabled: !enabled,
          },
        },
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

      <div className="smtcmp-settings-sub-header">
        <span className="smtcmp-agent-tools-section-title">
          <span>{t('settings.agent.toolSourceBuiltin', 'Built-in')}</span>
        </span>
      </div>
      <div className="smtcmp-mcp-servers-container smtcmp-builtin-tools-table">
        <div className="smtcmp-mcp-servers-header smtcmp-builtin-tools-table-header">
          <div>{t('settings.mcp.tools', 'Tools')}</div>
          <div>{t('settings.agent.descriptionColumn', 'Description')}</div>
          <div>{t('settings.mcp.enabled', 'Enabled')}</div>
        </div>
        <div className="smtcmp-mcp-server smtcmp-builtin-tools-table-body">
          {builtinTools.map((tool) => (
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
            </div>
          ))}
        </div>
      </div>

      <McpSection app={app} plugin={plugin} embedded />
    </div>
  )
}
