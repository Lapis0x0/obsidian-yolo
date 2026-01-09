import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleMinus,
  Edit,
  Loader2,
  Trash2,
  X,
} from 'lucide-react'
import { App, Notice } from 'obsidian'
import { useCallback, useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { McpManager } from '../../../core/mcp/mcpManager'
import SmartComposerPlugin from '../../../main'
import {
  McpServerState,
  McpServerStatus,
  McpTool,
} from '../../../types/mcp.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ConfirmModal } from '../../modals/ConfirmModal'
import {
  AddMcpServerModal,
  EditMcpServerModal,
} from '../modals/McpServerFormModal'

type McpSectionProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function McpSection({ app, plugin }: McpSectionProps) {
  const { t } = useLanguage()
  const [mcpManager, setMcpManager] = useState<McpManager | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerState[]>([])

  useEffect(() => {
    let isMounted = true
    void plugin
      .getMcpManager()
      .then((manager) => {
        if (!isMounted) {
          return
        }
        setMcpManager(manager)
        setMcpServers(manager.getServers())
      })
      .catch((error) => {
        console.error('Failed to initialize MCP manager', error)
      })
    return () => {
      isMounted = false
    }
  }, [plugin])

  useEffect(() => {
    if (mcpManager) {
      const unsubscribe = mcpManager.subscribeServersChange((servers) => {
        setMcpServers(servers)
      })
      return () => {
        unsubscribe()
      }
    }
  }, [mcpManager])

  return (
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-header">{t('settings.mcp.title')}</div>

      <div className="smtcmp-settings-desc smtcmp-settings-callout">
        <strong>Warning:</strong> {t('settings.mcp.warning')}
      </div>

      {mcpManager?.disabled ? (
        <div className="smtcmp-settings-sub-header-container">
          <div className="smtcmp-settings-sub-header">
            {t('settings.mcp.notSupportedOnMobile')}
          </div>
        </div>
      ) : (
        <>
          <div className="smtcmp-settings-sub-header-container">
            <div className="smtcmp-settings-sub-header">
              {t('settings.mcp.mcpServers')}
            </div>
            <ObsidianButton
              text={t('settings.mcp.addServer')}
              onClick={() => new AddMcpServerModal(app, plugin).open()}
            />
          </div>

          <div className="smtcmp-mcp-servers-container">
            <div className="smtcmp-mcp-servers-header">
              <div>{t('settings.mcp.server')}</div>
              <div>{t('settings.mcp.status')}</div>
              <div>{t('settings.mcp.enabled')}</div>
              <div>{t('settings.mcp.actions')}</div>
            </div>
            {mcpServers.length > 0 ? (
              mcpServers.map((server) => (
                <McpServerComponent
                  key={server.name}
                  server={server}
                  app={app}
                  plugin={plugin}
                />
              ))
            ) : (
              <div className="smtcmp-mcp-servers-empty">
                {t('settings.mcp.noServersFound')}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function McpServerComponent({
  server,
  app,
  plugin,
}: {
  server: McpServerState
  app: App
  plugin: SmartComposerPlugin
}) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)

  const handleEdit = useCallback(() => {
    new EditMcpServerModal(app, plugin, server.name).open()
  }, [server.name, app, plugin])

  const handleDelete = useCallback(() => {
    const message = `${t('settings.mcp.deleteServerConfirm')} "${server.name}"?`
    const deleteServer = async () => {
      try {
        await setSettings({
          ...settings,
          mcp: {
            ...settings.mcp,
            servers: settings.mcp.servers.filter((s) => s.id !== server.name),
          },
        })
      } catch (error: unknown) {
        console.error('Failed to delete MCP server', error)
        new Notice(
          t('settings.mcp.failedToDeleteServer', 'Failed to delete server.'),
        )
      }
    }
    new ConfirmModal(app, {
      title: t('settings.mcp.deleteServer'),
      message: message,
      ctaText: t('settings.mcp.delete'),
      onConfirm: () => {
        void deleteServer()
      },
    }).open()
  }, [server.name, settings, setSettings, app, t])

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      try {
        await setSettings({
          ...settings,
          mcp: {
            ...settings.mcp,
            servers: settings.mcp.servers.map((s) =>
              s.id === server.name ? { ...s, enabled } : s,
            ),
          },
        })
      } catch (error: unknown) {
        console.error('Failed to toggle MCP server', error)
      }
    },
    [settings, setSettings, server.name],
  )

  return (
    <div className="smtcmp-mcp-server">
      <div className="smtcmp-mcp-server-row">
        <div className="smtcmp-mcp-server-name">{server.name}</div>
        <div className="smtcmp-mcp-server-status">
          <McpServerStatusBadge status={server.status} />
        </div>
        <div className="smtcmp-mcp-server-toggle">
          <ObsidianToggle
            value={server.config.enabled}
            onChange={(enabled) => void handleToggleEnabled(enabled)}
          />
        </div>
        <div className="smtcmp-mcp-server-actions">
          <button
            onClick={handleEdit}
            className="clickable-icon"
            aria-label={t('settings.mcp.edit')}
          >
            <Edit size={16} />
          </button>
          <button
            onClick={handleDelete}
            className="clickable-icon"
            aria-label={t('settings.mcp.delete')}
          >
            <Trash2 size={16} />
          </button>
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="clickable-icon"
            aria-label={
              isOpen ? t('settings.mcp.collapse') : t('settings.mcp.expand')
            }
          >
            {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>
      {isOpen && <ExpandedServerInfo server={server} />}
    </div>
  )
}

function ExpandedServerInfo({ server }: { server: McpServerState }) {
  const { t } = useLanguage()

  if (
    server.status === McpServerStatus.Disconnected ||
    server.status === McpServerStatus.Connecting
  ) {
    return null
  }

  return (
    <div className="smtcmp-server-expanded-info">
      {server.status === McpServerStatus.Connected && (
        <div>
          <div className="smtcmp-server-expanded-info-header">
            {t('settings.mcp.tools')}
          </div>
          <div className="smtcmp-server-tools-container">
            {server.tools.map((tool) => (
              <McpToolComponent key={tool.name} tool={tool} server={server} />
            ))}
          </div>
        </div>
      )}
      {server.status === McpServerStatus.Error && (
        <div>
          <div className="smtcmp-server-expanded-info-header">
            {t('settings.mcp.error')}
          </div>
          <div className="smtcmp-server-error-message">
            {server.error.message}
          </div>
        </div>
      )}
    </div>
  )
}

function McpServerStatusBadge({ status }: { status: McpServerStatus }) {
  const { t } = useLanguage()
  const statusConfig = {
    [McpServerStatus.Connected]: {
      icon: <Check size={16} />,
      label: t('settings.mcp.connected'),
      statusClass: 'smtcmp-mcp-server-status-badge--connected',
    },
    [McpServerStatus.Connecting]: {
      icon: <Loader2 size={16} className="smtcmp-spinner" />,
      label: t('settings.mcp.connecting'),
      statusClass: 'smtcmp-mcp-server-status-badge--connecting',
    },
    [McpServerStatus.Error]: {
      icon: <X size={16} />,
      label: t('settings.mcp.error'),
      statusClass: 'smtcmp-mcp-server-status-badge--error',
    },
    [McpServerStatus.Disconnected]: {
      icon: <CircleMinus size={16} />,
      label: t('settings.mcp.disconnected'),
      statusClass: 'smtcmp-mcp-server-status-badge--disconnected',
    },
  }

  const { icon, label, statusClass } = statusConfig[status]

  return (
    <div className={`smtcmp-mcp-server-status-badge ${statusClass}`}>
      {icon}
      <div className="smtcmp-mcp-server-status-badge-label">{label}</div>
    </div>
  )
}

function McpToolComponent({
  tool,
  server,
}: {
  tool: McpTool
  server: McpServerState
}) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const toolOption = server.config.toolOptions[tool.name]
  const disabled = toolOption?.disabled ?? false
  const allowAutoExecution = toolOption?.allowAutoExecution ?? false

  const handleToggleEnabled = (enabled: boolean) => {
    const toolOptions = {
      ...server.config.toolOptions,
      [tool.name]: {
        disabled: !enabled,
        allowAutoExecution,
      },
    }
    Promise.resolve(
      setSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          servers: settings.mcp.servers.map((s) =>
            s.id === server.name
              ? {
                  ...s,
                  toolOptions,
                }
              : s,
          ),
        },
      }),
    ).catch((error: unknown) => {
      console.error('Failed to toggle MCP tool enabled state', error)
    })
  }

  const handleToggleAutoExecution = (autoExecution: boolean) => {
    const toolOptions = { ...server.config.toolOptions }
    toolOptions[tool.name] = {
      ...toolOptions[tool.name],
      allowAutoExecution: autoExecution,
    }
    Promise.resolve(
      setSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          servers: settings.mcp.servers.map((s) =>
            s.id === server.name
              ? {
                  ...s,
                  toolOptions,
                }
              : s,
          ),
        },
      }),
    ).catch((error: unknown) => {
      console.error('Failed to toggle MCP tool auto execution', error)
    })
  }

  return (
    <div className="smtcmp-mcp-tool">
      <div className="smtcmp-mcp-tool-info">
        <div className="smtcmp-mcp-tool-name">{tool.name}</div>
        <div className="smtcmp-mcp-tool-description">{tool.description}</div>
      </div>
      <div className="smtcmp-mcp-tool-toggle">
        <span className="smtcmp-mcp-tool-toggle-label">
          {t('settings.mcp.enabled')}
        </span>
        <ObsidianToggle
          value={!disabled}
          onChange={(value) => handleToggleEnabled(value)}
        />
      </div>
      <div className="smtcmp-mcp-tool-toggle">
        <span className="smtcmp-mcp-tool-toggle-label">
          {t('settings.mcp.autoExecute')}
        </span>
        <ObsidianToggle
          value={allowAutoExecution}
          onChange={(value) => handleToggleAutoExecution(value)}
        />
      </div>
    </div>
  )
}
