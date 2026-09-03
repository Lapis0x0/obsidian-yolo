import {
  Check,
  ChevronDown,
  ChevronLeft,
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
import { pruneOrphanedAssistantToolPreferences } from '../../../core/agent/tool-preferences'
import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { McpManager } from '../../../core/mcp/mcpManager'
import type YoloPlugin from '../../../main'
import {
  McpServerState,
  McpServerStatus,
  McpTool,
} from '../../../types/mcp.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { CollapsibleToolDescription } from '../common/CollapsibleToolDescription'
import {
  AddMcpServerModal,
  EditMcpServerModal,
} from '../modals/McpServerFormModal'

type McpSectionProps = {
  app: App
  plugin: YoloPlugin
  embedded?: boolean
}

export function McpSection({ app, plugin, embedded = false }: McpSectionProps) {
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
    <div className="yolo-settings-section">
      {embedded ? (
        <div className="yolo-settings-sub-header">
          {t('settings.mcp.title')}
        </div>
      ) : (
        <div className="yolo-settings-header">{t('settings.mcp.title')}</div>
      )}

      <div className="yolo-settings-desc yolo-settings-callout">
        <strong>Warning:</strong> {t('settings.mcp.warning')}
      </div>

      {mcpManager?.remoteMcpDisabled ? (
        <div className="yolo-settings-sub-header-container">
          <div className="yolo-settings-sub-header">
            {t('settings.mcp.notSupportedOnMobile')}
          </div>
        </div>
      ) : (
        <>
          <div className="yolo-settings-sub-header-container">
            <div className="yolo-settings-sub-header">
              {t('settings.mcp.mcpServers')}
            </div>
            <ObsidianButton
              text={t('settings.mcp.addServer')}
              onClick={() => new AddMcpServerModal(app, plugin).open()}
            />
          </div>

          <div className="yolo-mcp-servers-container">
            <div className="yolo-mcp-servers-header">
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
              <div className="yolo-mcp-servers-empty">
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
  plugin: YoloPlugin
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
        const nextServers = settings.mcp.servers.filter(
          (s) => s.id !== server.name,
        )
        const knownServerNames = new Set<string>([
          getLocalFileToolServerName(),
          ...nextServers.map((s) => s.id),
        ])
        const nextAssistants = settings.assistants.map((assistant) =>
          pruneOrphanedAssistantToolPreferences(assistant, knownServerNames),
        )
        await setSettings({
          ...settings,
          mcp: {
            ...settings.mcp,
            servers: nextServers,
          },
          assistants: nextAssistants,
        })
        if (server.config.auth === 'oauth') {
          await (await plugin.getMcpManager()).clearOAuthCredential(server.name)
        }
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
    <div className="yolo-mcp-server">
      <div className="yolo-mcp-server-row">
        <div className="yolo-mcp-server-name">{server.name}</div>
        <div className="yolo-mcp-server-status">
          <McpServerStatusBadge status={server.status} />
        </div>
        <div className="yolo-mcp-server-toggle">
          <ObsidianToggle
            value={server.config.enabled}
            onChange={(enabled) => void handleToggleEnabled(enabled)}
          />
        </div>
        <div className="yolo-mcp-server-actions">
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
            {isOpen ? <ChevronDown size={16} /> : <ChevronLeft size={16} />}
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
    <div className="yolo-server-expanded-info">
      {server.status === McpServerStatus.Connected && (
        <div>
          <div className="yolo-server-expanded-info-header">
            {t('settings.mcp.tools')}
          </div>
          <div className="yolo-server-tools-container">
            {server.tools.map((tool) => (
              <McpToolComponent key={tool.name} tool={tool} server={server} />
            ))}
          </div>
        </div>
      )}
      {server.status === McpServerStatus.Error && (
        <div>
          <div className="yolo-server-expanded-info-header">
            {t('settings.mcp.error')}
          </div>
          <div className="yolo-server-error-message">
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
      statusClass: 'yolo-mcp-server-status-badge--connected',
    },
    [McpServerStatus.Connecting]: {
      icon: <Loader2 size={16} className="yolo-spinner" />,
      label: t('settings.mcp.connecting'),
      statusClass: 'yolo-mcp-server-status-badge--connecting',
    },
    [McpServerStatus.Error]: {
      icon: <X size={16} />,
      label: t('settings.mcp.error'),
      statusClass: 'yolo-mcp-server-status-badge--error',
    },
    [McpServerStatus.Disconnected]: {
      icon: <CircleMinus size={16} />,
      label: t('settings.mcp.disconnected'),
      statusClass: 'yolo-mcp-server-status-badge--disconnected',
    },
  }

  const { icon, label, statusClass } = statusConfig[status]

  return (
    <div className={`yolo-mcp-server-status-badge ${statusClass}`}>
      {icon}
      <div className="yolo-mcp-server-status-badge-label">{label}</div>
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

  const handleToggleEnabled = (enabled: boolean) => {
    const toolOptions = {
      ...server.config.toolOptions,
      [tool.name]: {
        disabled: !enabled,
        ...server.config.toolOptions[tool.name],
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

  return (
    <div className="yolo-mcp-tool">
      <div className="yolo-mcp-tool-info">
        <CollapsibleToolDescription
          name={tool.name}
          description={tool.description}
        />
      </div>
      <div className="yolo-mcp-tool-toggle">
        <span className="yolo-mcp-tool-toggle-label">
          {t('settings.mcp.enabled')}
        </span>
        <ObsidianToggle
          value={!disabled}
          onChange={(value) => handleToggleEnabled(value)}
        />
      </div>
    </div>
  )
}
