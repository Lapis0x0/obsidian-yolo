import { App, Notice } from 'obsidian'
import { useCallback, useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type {
  CliConversationController,
  CliRuntimeId,
  CliRuntimeMcpServerStatus,
} from '../../../core/cli-runtime'
import type YoloPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'

export type McpServerStatusModalProps = {
  runtimeId: CliRuntimeId
  controller: CliConversationController | null
  isActive: () => boolean
}

export class McpServerStatusModal extends ReactModal<McpServerStatusModalProps> {
  constructor(app: App, plugin: YoloPlugin, props: McpServerStatusModalProps) {
    super({
      app,
      Component: McpServerStatusModalContent,
      props,
      options: {
        title: plugin.t('chat.mcpServers.title', 'MCP 服务器'),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

type LoadErrorKind = 'no-session' | 'codex-unsupported' | 'generic'
type RowAction = 'toggle' | 'reconnect'

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const STATUS_ORDER: CliRuntimeMcpServerStatus['status'][] = [
  'failed',
  'needs-auth',
  'pending',
  'connected',
  'disabled',
  'unknown',
]

function statusLabel(
  status: CliRuntimeMcpServerStatus['status'],
  t: (keyPath: string, fallback?: string) => string,
): string {
  switch (status) {
    case 'connected':
      return t('chat.mcpServers.statusConnected', '已连接')
    case 'failed':
      return t('chat.mcpServers.statusFailed', '连接失败')
    case 'needs-auth':
      return t('chat.mcpServers.statusNeedsAuth', '需要登录')
    case 'pending':
      return t('chat.mcpServers.statusPending', '连接中')
    case 'disabled':
      return t('chat.mcpServers.statusDisabled', '已禁用')
    case 'unknown':
      return t('chat.mcpServers.statusUnknown', '状态未知')
  }
}

function McpServerStatusModalContent({
  runtimeId,
  controller,
  isActive,
}: McpServerStatusModalProps & { onClose: () => void }) {
  const { t } = useLanguage()

  const [loading, setLoading] = useState(true)
  const [loadErrorKind, setLoadErrorKind] = useState<LoadErrorKind | null>(null)
  const [servers, setServers] = useState<CliRuntimeMcpServerStatus[]>([])
  const [rowBusy, setRowBusy] = useState<Record<string, RowAction>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadErrorKind(null)
    if (!controller) {
      setServers([])
      setLoadErrorKind('no-session')
      setLoading(false)
      return
    }
    try {
      const statuses = await controller.mcpServerStatus()
      setServers([...statuses])
    } catch (error) {
      let kind: LoadErrorKind = 'generic'
      if (runtimeId === 'codex') {
        const { CodexMcpServerStatusUnsupportedError } = await import(
          '../../../core/cli-runtime/codex/protocol'
        )
        if (error instanceof CodexMcpServerStatusUnsupportedError) {
          kind = 'codex-unsupported'
        }
      }
      console.warn('[YOLO] Failed to load MCP server status', error)
      setServers([])
      setLoadErrorKind(kind)
    } finally {
      setLoading(false)
    }
  }, [controller, runtimeId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const clearRowError = useCallback((name: string) => {
    setRowError((prev) => {
      const { [name]: _removed, ...rest } = prev
      return rest
    })
  }, [])

  const runRowAction = useCallback(
    async (name: string, action: RowAction, run: () => Promise<void>) => {
      if (!isActive()) {
        new Notice(
          t('chat.mcpServers.runtimeSwitched', '运行时已切换，此操作已取消。'),
        )
        return
      }
      setRowBusy((prev) => ({ ...prev, [name]: action }))
      clearRowError(name)
      try {
        await run()
        await refresh()
      } catch (error) {
        const message = getErrorMessage(error)
        console.warn(`[YOLO] MCP server ${action} failed`, error)
        setRowError((prev) => ({ ...prev, [name]: message }))
        new Notice(
          t('chat.mcpServers.actionError', '操作失败：{error}').replace(
            '{error}',
            message,
          ),
        )
      } finally {
        setRowBusy((prev) => {
          const { [name]: _removed, ...rest } = prev
          return rest
        })
      }
    },
    [clearRowError, isActive, refresh, t],
  )

  const handleToggle = useCallback(
    (server: CliRuntimeMcpServerStatus, enabled: boolean) => {
      void runRowAction(server.name, 'toggle', async () => {
        if (!controller) throw new Error('No active CLI session.')
        await controller.toggleMcpServer(server.name, enabled)
      })
    },
    [controller, runRowAction],
  )

  const handleReconnect = useCallback(
    (server: CliRuntimeMcpServerStatus) => {
      void runRowAction(server.name, 'reconnect', async () => {
        if (!controller) throw new Error('No active CLI session.')
        await controller.reconnectMcpServer(server.name)
      })
    },
    [controller, runRowAction],
  )

  const sortedServers = [...servers].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  )

  return (
    <div className="yolo-mcp-status-modal">
      <div className="yolo-mcp-status-toolbar">
        {runtimeId === 'codex' && (
          <div className="yolo-mcp-status-readonly-note">
            {t(
              'chat.mcpServers.codexReadOnlyNote',
              'Codex 的 MCP 服务器状态为只读展示，如需开关或重连请在终端中操作。',
            )}
          </div>
        )}
        <ObsidianButton
          text={t('chat.mcpServers.refresh', '刷新')}
          disabled={loading}
          onClick={() => void refresh()}
        />
      </div>

      {loading ? (
        <div className="yolo-cli-native-modal-placeholder">
          {t('chat.mcpServers.placeholder', '正在加载 MCP 服务器状态…')}
        </div>
      ) : loadErrorKind ? (
        <div className="yolo-mcp-status-empty">
          {loadErrorKind === 'no-session'
            ? t(
                'chat.mcpServers.noActiveSession',
                '当前没有活跃的会话，请先发送一条消息以启动 CLI 会话。',
              )
            : loadErrorKind === 'codex-unsupported'
              ? t(
                  'chat.mcpServers.codexUnsupportedVersion',
                  '当前 Codex CLI 版本不支持查询 MCP 服务器状态，请升级 Codex CLI 后重试。',
                )
              : t('chat.mcpServers.loadError', '无法加载 MCP 服务器状态。')}
        </div>
      ) : sortedServers.length === 0 ? (
        <div className="yolo-mcp-status-empty">
          {t('chat.mcpServers.empty', '当前会话没有配置任何 MCP 服务器。')}
        </div>
      ) : (
        <div className="yolo-mcp-status-list">
          {sortedServers.map((server) => {
            const busy = rowBusy[server.name]
            const error = rowError[server.name]
            const canReconnect =
              !server.readOnly &&
              (server.status === 'failed' ||
                server.status === 'pending' ||
                server.status === 'needs-auth')
            return (
              <div
                key={server.name}
                className={`yolo-mcp-status-row ${busy ? 'is-busy' : ''}`}
              >
                <div className="yolo-mcp-status-row-main">
                  <div className="yolo-mcp-status-row-title">
                    {server.name}
                    <span
                      className={`yolo-mcp-status-badge is-${server.status}`}
                    >
                      {statusLabel(server.status, t)}
                    </span>
                    {server.toolCount !== undefined && (
                      <span className="yolo-mcp-status-meta">
                        {t(
                          'chat.mcpServers.toolCount',
                          '{count} 个工具',
                        ).replace('{count}', String(server.toolCount))}
                      </span>
                    )}
                    {server.scope && (
                      <span className="yolo-mcp-status-meta">
                        {server.scope}
                      </span>
                    )}
                  </div>
                  {(server.errorMessage || error) && (
                    <div className="yolo-mcp-status-row-error">
                      {error ?? server.errorMessage}
                    </div>
                  )}
                </div>
                {!server.readOnly && (
                  <div className="yolo-mcp-status-row-actions">
                    {canReconnect && (
                      <ObsidianButton
                        text={t('chat.mcpServers.reconnect', '重连')}
                        disabled={!!busy}
                        onClick={() => handleReconnect(server)}
                      />
                    )}
                    <ObsidianToggle
                      value={server.status !== 'disabled'}
                      disabled={!!busy}
                      onChange={(value) => handleToggle(server, value)}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
