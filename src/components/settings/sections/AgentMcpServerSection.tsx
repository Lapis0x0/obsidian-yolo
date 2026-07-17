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
import { ObsidianToggle } from '../../common/ObsidianToggle'

export function AgentMcpServerSection() {
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const localServer = settings.mcp.localServer
  const [serverState, setServerState] = useState<LocalMcpServerState>(() =>
    plugin.getLocalMcpServerState(),
  )

  useEffect(() => plugin.subscribeLocalMcpServerState(setServerState), [plugin])

  const updateLocalServer = useCallback(
    async (updates: Partial<typeof localServer>) => {
      await setSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          localServer: {
            ...localServer,
            ...updates,
          },
        },
      })
    },
    [localServer, setSettings, settings],
  )

  const handleEnabledChange = useCallback(
    (enabled: boolean) => {
      void updateLocalServer({
        enabled,
        token:
          enabled && !localServer.token
            ? generateLocalMcpServerToken()
            : localServer.token,
      })
    },
    [localServer.token, updateLocalServer],
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

  const errorText =
    serverState.status === 'error'
      ? `${t('settings.agent.mcpServerError')}: ${serverState.error ?? ''}`
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
        <div className="setting-item yolo-settings-card yolo-agent-mcp-config-card">
          <div className="setting-item-name yolo-agent-mcp-config-title">
            {t('settings.agent.mcpServerClientConfig')}
          </div>
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
      )}
    </>
  )
}
