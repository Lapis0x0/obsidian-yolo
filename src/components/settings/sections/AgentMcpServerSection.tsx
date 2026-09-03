import { Copy } from 'lucide-react'
import { Notice, Platform } from 'obsidian'
import { useCallback, useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  type LocalMcpServerState,
  generateLocalMcpServerToken,
  getLocalMcpServerUrl,
} from '../../../core/mcp/localMcpServerConfig'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

const MIN_PORT = 1024
const MAX_PORT = 65535

export function AgentMcpServerSection() {
  const plugin = usePlugin()
  const { settings, updateSettings } = useSettings()
  const { t } = useLanguage()
  const localServer = settings.mcp.localServer
  const [serverState, setServerState] = useState<LocalMcpServerState>(() =>
    plugin.getLocalMcpServerState(),
  )
  const [portInput, setPortInput] = useState(String(localServer.port))

  useEffect(() => {
    setPortInput(String(localServer.port))
  }, [localServer.port])

  useEffect(() => plugin.subscribeLocalMcpServerState(setServerState), [plugin])

  // The toggle and the port field can be committed back to back (typing a port
  // then clicking the toggle blurs first), so both go through the serialized
  // updater and read the local server off the settings it hands them.
  const updateLocalServer = useCallback(
    (updates: (current: typeof localServer) => Partial<typeof localServer>) =>
      updateSettings((current) => ({
        ...current,
        mcp: {
          ...current.mcp,
          localServer: {
            ...current.mcp.localServer,
            ...updates(current.mcp.localServer),
          },
        },
      })),
    [updateSettings],
  )

  const handleEnabledChange = useCallback(
    (enabled: boolean) => {
      void updateLocalServer((current) => ({
        enabled,
        token:
          enabled && !current.token
            ? generateLocalMcpServerToken()
            : current.token,
      }))
    },
    [updateLocalServer],
  )

  const commitPort = useCallback(
    (value: string) => {
      // A number input also accepts `1e4` and decimals, which `parseInt` would
      // read as 1 — parse the whole value, then take the integer part.
      const parsed = Number(value.trim())
      if (value.trim() === '' || !Number.isFinite(parsed)) {
        setPortInput(String(localServer.port))
        return
      }
      const clamped = Math.max(MIN_PORT, Math.min(MAX_PORT, Math.trunc(parsed)))
      setPortInput(String(clamped))
      if (clamped === localServer.port) {
        return
      }
      void updateLocalServer(() => ({ port: clamped })).then((saved) => {
        if (!saved) {
          setPortInput(String(localServer.port))
        }
      })
    },
    [localServer.port, updateLocalServer],
  )

  const config = JSON.stringify(
    {
      transport: 'http',
      url: getLocalMcpServerUrl(localServer.port),
      headers: {
        Authorization: `Bearer ${localServer.token}`,
      },
    },
    null,
    2,
  )

  const copyConfig = useCallback(() => {
    void navigator.clipboard.writeText(config).then(
      () => new Notice(t('settings.agent.mcpServerConfigCopied')),
      () => new Notice(t('settings.agent.mcpServerCopyFailed')),
    )
  }, [config, t])

  // The port is the one thing a user can act on, and the raw Node message
  // (`listen EADDRINUSE: address already in use 127.0.0.1:28124`) says nothing
  // about that — another plugin in this same Obsidian process is a common
  // holder. Keep the original text for reporting, lead with what to do.
  const portInUse = serverState.error?.includes('EADDRINUSE') ?? false
  const errorText =
    serverState.status === 'error'
      ? `${t('settings.agent.mcpServerError')}: ${serverState.error ?? ''}`
      : null
  const portInUseHint = portInUse
    ? t('settings.agent.mcpServerPortInUse').replace(
        '{port}',
        String(localServer.port),
      )
    : null

  return (
    <>
      <ObsidianSetting
        name={t('settings.agent.mcpServerEnabled')}
        desc={
          Platform.isDesktop
            ? t('settings.agent.mcpServerDesc')
            : t('settings.agent.mcpServerDesktopOnly')
        }
        className="yolo-settings-card"
      >
        <ObsidianToggle
          value={localServer.enabled}
          onChange={handleEnabledChange}
          disabled={!Platform.isDesktop}
        />
      </ObsidianSetting>

      {Platform.isDesktop && localServer.enabled && (
        <>
          <ObsidianSetting
            name={t('settings.agent.mcpServerPort')}
            desc={t('settings.agent.mcpServerPortDesc')}
            className="yolo-settings-card"
          >
            <ObsidianTextInput
              value={portInput}
              type="number"
              onChange={setPortInput}
              onBlur={commitPort}
            />
          </ObsidianSetting>

          <div className="setting-item yolo-settings-card yolo-agent-mcp-config-card">
            <div className="setting-item-name yolo-agent-mcp-config-title">
              {t('settings.agent.mcpServerClientConfig')}
            </div>
            {portInUseHint && (
              <div className="setting-item-description">{portInUseHint}</div>
            )}
            {errorText && (
              <div className="setting-item-description">{errorText}</div>
            )}
            <div className="yolo-agent-mcp-config-json-wrap">
              <pre className="yolo-agent-mcp-config-json">
                <code>{config}</code>
              </pre>
              <button
                type="button"
                className="clickable-icon yolo-agent-mcp-config-copy"
                aria-label={t('settings.agent.mcpServerCopyConfig')}
                title={t('settings.agent.mcpServerCopyConfig')}
                onClick={copyConfig}
                disabled={!localServer.token}
              >
                <Copy size={16} />
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
