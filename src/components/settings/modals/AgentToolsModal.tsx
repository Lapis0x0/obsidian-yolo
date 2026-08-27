import { Settings } from 'lucide-react'
import { App } from 'obsidian'
import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import type { BuiltinCapabilityId } from '../../../core/tools/registry'
import type YoloPlugin from '../../../main'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'
import { CollapsibleToolDescription } from '../common/CollapsibleToolDescription'
import {
  buildBuiltinCapabilityRows,
  groupCapabilityRowsByCategory,
} from '../sections/builtinCapabilityRows'
import { McpSection } from '../sections/McpSection'

import { CAPABILITY_SETTINGS_LAUNCHERS } from './capabilitySettingsLaunchers'

type AgentToolsModalProps = {
  app: App
  plugin: YoloPlugin
}

/**
 * aria-label text for the settings-button of each capability that declares
 * `hasSettings: true`. Kept local to this modal (its only consumer) rather
 * than folded into `CAPABILITY_SETTINGS_LAUNCHERS` — that table's job is
 * "which modal opens", a behavior concern; this is presentation text for a
 * single button in a single view.
 */
const CAPABILITY_SETTINGS_BUTTON_ARIA_LABEL: Partial<
  Record<BuiltinCapabilityId, { key: string; fallback: string }>
> = {
  web_access: {
    key: 'settings.webSearch.openSettings',
    fallback: 'Configure web search providers',
  },
  js_sandbox: {
    key: 'settings.jsSandbox.openSettings',
    fallback: 'Configure analysis sandbox',
  },
  terminal: {
    key: 'settings.terminalCommand.openSettings',
    fallback: 'Configure terminal command',
  },
  subagent_delegation: {
    key: 'settings.subagent.openSettings',
    fallback: 'Configure subagent models',
  },
}

export class AgentToolsModal extends ReactModal<AgentToolsModalProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: AgentToolsModalWrapper,
      props: { app, plugin },
      options: {
        title: plugin.t('settings.agent.manageTools'),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
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
  plugin: YoloPlugin
}) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()

  const builtinToolGroups = useMemo(() => {
    // Every registered capability is listed unconditionally: this page shows
    // what the user has *authorized*, which is independent of whether a
    // capability's tools happen to be runnable right now (master.md decision
    // 18 + its D7 ruling). Pre-D7 this list was derived from
    // `getLocalFileTools()`, so disabling the `bash-engine` runtime component
    // also made the Vault Shell row disappear — while the equivalent gates on
    // `web_search` / `terminal_command` (which live downstream in
    // `McpManager.isLocalToolEnabled`) always left their rows visible. That
    // asymmetry is resolved here in favor of always showing the row; the
    // capability's toggle and approval tier stay persisted either way, and
    // only the tool's presence in the model-facing catalog changes.
    const rows = buildBuiltinCapabilityRows({
      toolOptions: settings.mcp.builtinCapabilityOptions,
      t,
    })
    return groupCapabilityRowsByCategory(rows, t)
  }, [settings.mcp.builtinCapabilityOptions, t])

  const handleToggleBuiltinTool = (
    capabilityId: BuiltinCapabilityId,
    enabled: boolean,
  ) => {
    void setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        builtinCapabilityOptions: {
          ...settings.mcp.builtinCapabilityOptions,
          [capabilityId]: {
            ...settings.mcp.builtinCapabilityOptions[capabilityId],
            disabled: !enabled,
          },
        },
      },
    })
  }

  return (
    <div className="yolo-settings-section">
      <div className="yolo-settings-desc yolo-settings-callout">
        {t(
          'settings.agent.desc',
          'Manage global capabilities and configure your agents.',
        )}
      </div>

      {builtinToolGroups.map((group) => (
        <div key={group.category}>
          <div className="yolo-settings-sub-header">
            <span className="yolo-agent-tools-section-title">
              <span>{group.title}</span>
            </span>
          </div>
          <div className="yolo-mcp-servers-container yolo-builtin-tools-table">
            <div className="yolo-mcp-servers-header yolo-builtin-tools-table-header">
              <div>{t('settings.mcp.tools', 'Tools')}</div>
              <div>{t('settings.agent.descriptionColumn', 'Description')}</div>
              <div />
              <div>{t('settings.mcp.enabled', 'Enabled')}</div>
            </div>
            <div className="yolo-mcp-server yolo-builtin-tools-table-body">
              {group.rows.map((row) => {
                const ariaLabel = CAPABILITY_SETTINGS_BUTTON_ARIA_LABEL[row.id]
                const launcher = CAPABILITY_SETTINGS_LAUNCHERS[row.id]
                return (
                  <div
                    key={row.id}
                    className="yolo-mcp-server-row yolo-builtin-tools-table-row"
                  >
                    <div className="yolo-mcp-server-name">{row.label}</div>
                    <div className="yolo-mcp-server-status yolo-builtin-tools-table-description">
                      <CollapsibleToolDescription
                        description={row.description}
                      />
                    </div>
                    <div />
                    <div className="yolo-builtin-tools-table-control">
                      {row.hasSettings && launcher ? (
                        <button
                          type="button"
                          className="clickable-icon"
                          aria-label={
                            ariaLabel
                              ? t(ariaLabel.key, ariaLabel.fallback)
                              : ''
                          }
                          onClick={() =>
                            launcher({ app, settings, setSettings, t, plugin })
                          }
                        >
                          <Settings size={16} />
                        </button>
                      ) : null}
                      <ObsidianToggle
                        value={row.enabled}
                        onChange={(enabled) =>
                          handleToggleBuiltinTool(row.id, enabled)
                        }
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ))}

      <McpSection app={app} plugin={plugin} embedded />
    </div>
  )
}
