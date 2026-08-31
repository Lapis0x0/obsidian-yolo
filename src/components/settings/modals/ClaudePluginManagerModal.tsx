import { App, Notice } from 'obsidian'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import type { CliConversationController } from '../../../core/cli-runtime'
import type {
  ClaudeAvailablePlugin,
  ClaudeInstalledPlugin,
  ClaudePluginCliResult,
  ClaudePluginScope,
} from '../../../core/cli-runtime/claude/plugin-cli'
import { getCliPathOverride } from '../../../core/cli-runtime/cli-path-override'
import type YoloPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'
import { ConfirmModal } from '../../modals/ConfirmModal'

export type ClaudePluginManagerModalProps = {
  controller: CliConversationController | null
  isActive: () => boolean
  refreshCliSkills?: () => void
}

export class ClaudePluginManagerModal extends ReactModal<ClaudePluginManagerModalProps> {
  constructor(
    app: App,
    plugin: YoloPlugin,
    props: ClaudePluginManagerModalProps,
  ) {
    super({
      app,
      Component: ClaudePluginManagerModalContent,
      props,
      options: {
        title: plugin.t('chat.claudePlugins.title', '插件管理'),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

type PluginManagerTab = 'installed' | 'browse'
type RowActionKind = 'enable' | 'disable' | 'uninstall' | 'install'

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Display id sans the `@marketplace` suffix the CLI appends to installed plugin ids. */
const stripMarketplaceSuffix = (id: string): string => id.split('@')[0] ?? id

/** CLI `pluginId` is already the full `name@marketplace` install id. */
const availablePluginKey = (item: ClaudeAvailablePlugin): string =>
  item.pluginId

function ClaudePluginManagerModalContent({
  controller,
  isActive,
  refreshCliSkills,
}: ClaudePluginManagerModalProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const plugin = usePlugin()
  const app = plugin.app

  const [tab, setTab] = useState<PluginManagerTab>('installed')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [installed, setInstalled] = useState<ClaudeInstalledPlugin[]>([])
  const [available, setAvailable] = useState<ClaudeAvailablePlugin[]>([])
  const [rowBusy, setRowBusy] = useState<Record<string, RowActionKind>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [installScopeByKey, setInstallScopeByKey] = useState<
    Record<string, ClaudePluginScope>
  >({})

  const configuredCliPath = getCliPathOverride(app, 'claude-code')

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const { listPlugins } = await import(
        '../../../core/cli-runtime/claude/plugin-cli'
      )
      const result = await listPlugins({ configuredCliPath })
      if (!result.ok) {
        console.warn('[YOLO] Failed to list Claude plugins', result.error)
        setLoadError(true)
        setInstalled([])
        setAvailable([])
        return
      }
      setInstalled(result.data.installed)
      setAvailable(result.data.available)
    } catch (error) {
      console.warn('[YOLO] Failed to list Claude plugins', error)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [configuredCliPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const showCliFallbackNotice = useCallback(() => {
    new Notice(
      t(
        'chat.claudePlugins.cliFallback',
        '插件操作失败，请在终端使用 claude plugin 管理。',
      ),
    )
  }, [t])

  const hotRefreshAfterMutation = useCallback(async () => {
    if (!controller || !isActive()) return
    try {
      await controller.reloadPlugins()
    } catch (error) {
      console.warn('[YOLO] Failed to hot-reload Claude plugins', error)
    }
    refreshCliSkills?.()
  }, [controller, isActive, refreshCliSkills])

  const runRowAction = useCallback(
    async (
      key: string,
      action: RowActionKind,
      run: () => Promise<ClaudePluginCliResult<string>>,
    ) => {
      setRowBusy((prev) => ({ ...prev, [key]: action }))
      setRowError((prev) => {
        const { [key]: _removed, ...rest } = prev
        return rest
      })
      try {
        const result = await run()
        if (!result.ok) {
          console.warn(`[YOLO] Claude plugin ${action} failed`, result.error)
          setRowError((prev) => ({ ...prev, [key]: result.error }))
          showCliFallbackNotice()
          return
        }
        await refresh()
        await hotRefreshAfterMutation()
      } catch (error) {
        console.warn(`[YOLO] Claude plugin ${action} failed`, error)
        setRowError((prev) => ({ ...prev, [key]: getErrorMessage(error) }))
        showCliFallbackNotice()
      } finally {
        setRowBusy((prev) => {
          const { [key]: _removed, ...rest } = prev
          return rest
        })
      }
    },
    [hotRefreshAfterMutation, refresh, showCliFallbackNotice, t],
  )

  const installedIds = useMemo(
    () => new Set(installed.map((item) => item.id)),
    [installed],
  )
  const isAvailablePluginInstalled = useCallback(
    (item: ClaudeAvailablePlugin) => installedIds.has(availablePluginKey(item)),
    [installedIds],
  )

  const filteredAvailable = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return available
    return available.filter((item) =>
      [item.name, item.pluginId, item.marketplaceName, item.description ?? '']
        .join(' ')
        .toLowerCase()
        .includes(query),
    )
  }, [available, searchQuery])

  const handleToggleInstalled = useCallback(
    (item: ClaudeInstalledPlugin, enabled: boolean) => {
      void runRowAction(item.id, enabled ? 'enable' : 'disable', async () => {
        const { enablePlugin, disablePlugin } = await import(
          '../../../core/cli-runtime/claude/plugin-cli'
        )
        const options = {
          scope: item.scope as ClaudePluginScope,
          configuredCliPath,
        }
        return enabled
          ? enablePlugin(item.id, options)
          : disablePlugin(item.id, options)
      })
    },
    [configuredCliPath, runRowAction],
  )

  const handleUninstallInstalled = useCallback(
    (item: ClaudeInstalledPlugin) => {
      const displayName = stripMarketplaceSuffix(item.id)
      const modal = new ConfirmModal(app, {
        title: t('chat.claudePlugins.uninstallConfirmTitle', '卸载插件'),
        message: t(
          'chat.claudePlugins.uninstallConfirmMessage',
          '确定要卸载插件 "{name}" 吗？此操作无法撤销。',
        ).replace('{name}', displayName),
        ctaText: t('chat.claudePlugins.uninstall', '卸载'),
        onConfirm: () => {
          void runRowAction(item.id, 'uninstall', async () => {
            const { uninstallPlugin } = await import(
              '../../../core/cli-runtime/claude/plugin-cli'
            )
            return uninstallPlugin(item.id, item.scope as ClaudePluginScope, {
              configuredCliPath,
            })
          })
        },
      })
      modal.open()
    },
    [app, configuredCliPath, runRowAction, t],
  )

  const handleInstallAvailable = useCallback(
    (item: ClaudeAvailablePlugin) => {
      const key = availablePluginKey(item)
      const scope = installScopeByKey[key] ?? 'user'
      void runRowAction(key, 'install', async () => {
        const { installPlugin } = await import(
          '../../../core/cli-runtime/claude/plugin-cli'
        )
        return installPlugin(key, scope, { configuredCliPath })
      })
    },
    [configuredCliPath, installScopeByKey, runRowAction],
  )

  const scopeOptions = {
    user: t('chat.claudePlugins.scopeUser', '用户'),
    project: t('chat.claudePlugins.scopeProject', '项目'),
    local: t('chat.claudePlugins.scopeLocal', '本地'),
  }

  return (
    <div className="yolo-claude-plugins-modal">
      <div className="yolo-claude-plugins-tabs">
        <button
          type="button"
          className={`yolo-claude-plugins-tab ${tab === 'installed' ? 'is-active' : ''}`}
          onClick={() => setTab('installed')}
        >
          {t('chat.claudePlugins.tabInstalled', '已安装')}
          <span className="yolo-claude-plugins-tab-count">
            {installed.length}
          </span>
        </button>
        <button
          type="button"
          className={`yolo-claude-plugins-tab ${tab === 'browse' ? 'is-active' : ''}`}
          onClick={() => setTab('browse')}
        >
          {t('chat.claudePlugins.tabBrowse', '浏览安装')}
        </button>
      </div>

      {loading ? (
        <div className="yolo-cli-native-modal-placeholder">
          {t('chat.claudePlugins.placeholder', '正在加载插件信息…')}
        </div>
      ) : loadError ? (
        <div className="yolo-claude-plugins-empty">
          <div>{t('chat.claudePlugins.loadError', '无法加载插件信息。')}</div>
          <div className="yolo-claude-plugins-empty-hint">
            {t(
              'chat.claudePlugins.cliFallback',
              '插件操作失败，请在终端使用 claude plugin 管理。',
            )}
          </div>
        </div>
      ) : tab === 'installed' ? (
        installed.length === 0 ? (
          <div className="yolo-claude-plugins-empty">
            {t('chat.claudePlugins.installedEmpty', '还没有安装任何插件。')}
          </div>
        ) : (
          <div className="yolo-claude-plugins-list">
            {installed.map((item) => {
              const busy = rowBusy[item.id]
              const error = rowError[item.id]
              const displayName = stripMarketplaceSuffix(item.id)
              return (
                <div
                  key={item.id}
                  className={`yolo-claude-plugins-row ${busy ? 'is-busy' : ''}`}
                >
                  <div className="yolo-claude-plugins-row-main">
                    <div className="yolo-claude-plugins-row-title">
                      {displayName}
                      {item.version !== 'unknown' && (
                        <span className="yolo-claude-plugins-row-version">
                          v{item.version}
                        </span>
                      )}
                      <span className="yolo-claude-plugins-row-scope">
                        {item.scope}
                      </span>
                    </div>
                    {error && (
                      <div className="yolo-claude-plugins-row-error">
                        {error}
                      </div>
                    )}
                  </div>
                  <div className="yolo-claude-plugins-row-actions">
                    <ObsidianToggle
                      value={item.enabled}
                      disabled={!!busy}
                      onChange={(value) => handleToggleInstalled(item, value)}
                    />
                    <ObsidianButton
                      text={t('chat.claudePlugins.uninstall', '卸载')}
                      warning
                      disabled={!!busy}
                      onClick={() => handleUninstallInstalled(item)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : (
        <div className="yolo-claude-plugins-browse">
          <div className="yolo-claude-plugins-search">
            <ObsidianTextInput
              value={searchQuery}
              placeholder={t(
                'chat.claudePlugins.searchPlaceholder',
                '搜索插件…',
              )}
              onChange={setSearchQuery}
            />
          </div>
          {filteredAvailable.length === 0 ? (
            <div className="yolo-claude-plugins-empty">
              {t('chat.claudePlugins.browseEmpty', '没有找到匹配的插件。')}
            </div>
          ) : (
            <div className="yolo-claude-plugins-list">
              {filteredAvailable.map((item) => {
                const key = availablePluginKey(item)
                const busy = rowBusy[key]
                const error = rowError[key]
                const alreadyInstalled = isAvailablePluginInstalled(item)
                const scope = installScopeByKey[key] ?? 'user'
                return (
                  <div
                    key={key}
                    className={`yolo-claude-plugins-row ${busy ? 'is-busy' : ''}`}
                  >
                    <div className="yolo-claude-plugins-row-main">
                      <div className="yolo-claude-plugins-row-title">
                        {item.name}
                        <span className="yolo-claude-plugins-row-scope">
                          {item.marketplaceName}
                        </span>
                        {alreadyInstalled && (
                          <span className="yolo-claude-plugins-row-installed-badge">
                            {t('chat.claudePlugins.installedBadge', '已安装')}
                          </span>
                        )}
                      </div>
                      {item.description && (
                        <div className="yolo-claude-plugins-row-desc">
                          {item.description}
                        </div>
                      )}
                      {item.installCount !== undefined && (
                        <div className="yolo-claude-plugins-row-meta">
                          {t(
                            'chat.claudePlugins.installCount',
                            '{count} 次安装',
                          ).replace('{count}', String(item.installCount))}
                        </div>
                      )}
                      {error && (
                        <div className="yolo-claude-plugins-row-error">
                          {error}
                        </div>
                      )}
                    </div>
                    <div className="yolo-claude-plugins-row-actions">
                      <ObsidianDropdown
                        value={scope}
                        options={scopeOptions}
                        disabled={!!busy || alreadyInstalled}
                        onChange={(value) =>
                          setInstallScopeByKey((prev) => ({
                            ...prev,
                            [key]: value as ClaudePluginScope,
                          }))
                        }
                      />
                      <ObsidianButton
                        text={t('chat.claudePlugins.install', '安装')}
                        cta
                        disabled={!!busy || alreadyInstalled}
                        onClick={() => handleInstallAvailable(item)}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
