import { Check, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { App, Notice, Platform } from 'obsidian'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { useLanguage } from '../../../../contexts/language-context'
import { useSettings } from '../../../../contexts/settings-context'
import {
  LOCAL_EMBEDDING_CATALOG,
  LocalEmbeddingCatalogEntry,
  getLocalEmbeddingCatalogEntry,
} from '../../../../core/rag/local-embedding/catalog'
import {
  DEFAULT_LOCAL_EMBEDDING_ENDPOINT,
  HF_MIRROR_LOCAL_EMBEDDING_ENDPOINT,
  LOCAL_EMBEDDING_PROVIDER_ID,
} from '../../../../core/rag/local-embedding/constants'
import type { LocalEmbeddingModelState } from '../../../../core/rag/local-embedding/manager'
import YoloPlugin from '../../../../main'
import { EmbeddingModel } from '../../../../types/embedding-model.types'
import {
  ensureUniqueModelId,
  generateModelId,
} from '../../../../utils/model-id-utils'
import { ObsidianButton } from '../../../common/ObsidianButton'
import { ObsidianDropdown } from '../../../common/ObsidianDropdown'
import { ObsidianTextInput } from '../../../common/ObsidianTextInput'
import { ConfirmModal } from '../../../modals/ConfirmModal'

const CUSTOM_ENDPOINT_SENTINEL = '__custom__'

/** `str` with every `{{key}}` in `vars` substituted — the interpolation
 * scheme every i18n string in this file uses. */
function format(str: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.split(`{{${key}}}`).join(String(value)),
    str,
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

export type LocalEmbeddingEngineIssue = Readonly<{
  kind: 'non-desktop' | 'not-downloaded' | 'component-disabled'
  entry: LocalEmbeddingCatalogEntry
}>

/**
 * Detects the 3 states where the *currently selected* embedding model is a
 * local one that can't actually run right now — used by `RAGSection`'s
 * status bar to take over its one status line instead of adding a second,
 * per docs/plans/08-22-local-embedding/00-plan.md §3.6 ("运行环境异常" is the
 * only scenario where engine info appears in the status bar). Returns `null`
 * whenever the current model isn't local, or is local and healthy.
 */
export function useLocalEmbeddingEngineIssue(
  plugin: YoloPlugin,
  currentModel: EmbeddingModel | undefined,
): LocalEmbeddingEngineIssue | null {
  const manager = useMemo(
    () => plugin.getLocalEmbeddingModelManager(),
    [plugin],
  )
  const runtimeComponents = useMemo(
    () => plugin.getRuntimeComponentService(),
    [plugin],
  )
  const modelSnapshot = useSyncExternalStore(
    (listener) => manager.subscribe(listener),
    () => manager.getSnapshot(),
    () => manager.getSnapshot(),
  )
  const runtimeSnapshot = useSyncExternalStore(
    runtimeComponents.subscribe,
    runtimeComponents.getSnapshot,
    runtimeComponents.getSnapshot,
  )

  return useMemo(() => {
    if (
      !currentModel ||
      currentModel.providerId !== LOCAL_EMBEDDING_PROVIDER_ID
    ) {
      return null
    }
    const entry = getLocalEmbeddingCatalogEntry(currentModel.model)
    if (!entry) return null
    if (!Platform.isDesktop) return { kind: 'non-desktop', entry }
    const record = runtimeSnapshot.find(
      (r) => r.descriptor.id === 'embedding-engine',
    )
    if (record && !record.enabled) return { kind: 'component-disabled', entry }
    const state = modelSnapshot.get(entry.id)
    if (
      !state ||
      state.status === 'not-installed' ||
      state.status === 'failed'
    ) {
      return { kind: 'not-downloaded', entry }
    }
    return null
  }, [currentModel, modelSnapshot, runtimeSnapshot])
}

type LocalEmbeddingShelfProps = {
  app: App
  plugin: YoloPlugin
}

/**
 * The "本地" (on-device) embedding-model shelf inside the Knowledge Base
 * tab's embedding-model section — a curated download list with per-model
 * lifecycle (download / cancel / retry / delete / set-as-current), source
 * detail disclosure, and a shared endpoint picker. See
 * docs/plans/08-22-local-embedding/00-plan.md §3.6/§3.7. Deliberately not a
 * normal Provider entry — local embedding models have no API key/base URL,
 * they're backed by the `embedding-engine` runtime component.
 */
export function LocalEmbeddingShelf({ app, plugin }: LocalEmbeddingShelfProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const applySettingsUpdate = (
    nextSettings: typeof settings,
    errorMessage?: string,
  ) => {
    void (async () => {
      try {
        await setSettings(nextSettings)
      } catch (error: unknown) {
        const message =
          errorMessage ?? t('notices.settingsUpdateFailed', '设置更新失败')
        console.error('[YOLO] ' + message, error)
        new Notice(message)
      }
    })()
  }

  const manager = useMemo(
    () => plugin.getLocalEmbeddingModelManager(),
    [plugin],
  )
  const modelSnapshot = useSyncExternalStore(
    (listener) => manager.subscribe(listener),
    () => manager.getSnapshot(),
    () => manager.getSnapshot(),
  )

  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const currentModel = settings.embeddingModels.find(
    (m) => m.id === settings.embeddingModelId,
  )
  const isCurrent = (entry: LocalEmbeddingCatalogEntry) =>
    currentModel?.providerId === LOCAL_EMBEDDING_PROVIDER_ID &&
    currentModel?.model === entry.id

  const tr = (
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ) => {
    const raw = t(`settings.knowledgeBases.localEmbedding.${key}`, fallback)
    return vars ? format(raw, vars) : raw
  }

  const handleSetCurrent = (entry: LocalEmbeddingCatalogEntry) => {
    const baseId = generateModelId(LOCAL_EMBEDDING_PROVIDER_ID, entry.id)
    const existing = settings.embeddingModels.find(
      (m) =>
        m.providerId === LOCAL_EMBEDDING_PROVIDER_ID && m.model === entry.id,
    )
    if (existing) {
      applySettingsUpdate({ ...settings, embeddingModelId: existing.id })
      return
    }
    const id = ensureUniqueModelId(
      settings.embeddingModels.map((m) => m.id),
      baseId,
    )
    const record: EmbeddingModel = {
      providerId: LOCAL_EMBEDDING_PROVIDER_ID,
      id,
      model: entry.id,
      name: entry.displayName,
      dimension: entry.dimension,
    }
    applySettingsUpdate({
      ...settings,
      embeddingModels: [...settings.embeddingModels, record],
      embeddingModelId: id,
    })
  }

  const handleDownload = (entry: LocalEmbeddingCatalogEntry) => {
    manager.download(entry).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      console.error('[YOLO] Local embedding model download failed:', error)
      new Notice(
        tr('failedLine', '下载失败：{{error}}', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    })
  }

  const handleDelete = (entry: LocalEmbeddingCatalogEntry) => {
    const doDelete = () => {
      manager.remove(entry.id).catch((error: unknown) => {
        console.error('[YOLO] Failed to remove local embedding model:', error)
      })
    }
    if (isCurrent(entry)) {
      new ConfirmModal(app, {
        title: tr('deleteCurrentConfirmTitle', '删除当前使用的嵌入模型？'),
        message: tr(
          'deleteCurrentConfirmMessage',
          '"{{name}}" 是当前使用的嵌入模型。删除其文件后，本地嵌入检索将不可用，直到你选择其他模型。此操作不可撤销。',
          { name: entry.displayName },
        ),
        ctaText: t('common.delete', '删除'),
        onConfirm: doDelete,
      }).open()
      return
    }
    doDelete()
  }

  const endpoint = settings.localEmbedding.endpoint
  const isKnownPreset =
    endpoint === DEFAULT_LOCAL_EMBEDDING_ENDPOINT ||
    endpoint === HF_MIRROR_LOCAL_EMBEDDING_ENDPOINT
  const [customDraft, setCustomDraft] = useState(isKnownPreset ? '' : endpoint)
  const [showCustomEndpoint, setShowCustomEndpoint] = useState(!isKnownPreset)
  useEffect(() => {
    const known =
      endpoint === DEFAULT_LOCAL_EMBEDDING_ENDPOINT ||
      endpoint === HF_MIRROR_LOCAL_EMBEDDING_ENDPOINT
    setShowCustomEndpoint(!known)
    if (!known) setCustomDraft(endpoint)
  }, [endpoint])

  const storageUsedBytes = useMemo(
    () =>
      LOCAL_EMBEDDING_CATALOG.reduce((sum, entry) => {
        const state = modelSnapshot.get(entry.id)
        return state?.status === 'ready' ? sum + entry.totalBytes : sum
      }, 0),
    [modelSnapshot],
  )

  const handleManageDownloaded = () => {
    new ConfirmModal(app, {
      title: tr('manageDownloadedConfirmTitle', '移除全部已下载模型？'),
      message: tr(
        'manageDownloadedConfirmMessage',
        '将删除磁盘上所有已下载的本地嵌入模型，之后可以重新下载。',
      ),
      ctaText: t('common.delete', '删除'),
      onConfirm: () => {
        manager.removeAll().catch((error: unknown) => {
          console.error(
            '[YOLO] Failed to remove all local embedding models:',
            error,
          )
        })
      },
    }).open()
  }

  if (!Platform.isDesktop) {
    return (
      <div className="yolo-local-embedding-group is-disabled">
        <div className="yolo-kb-divider-label yolo-kb-divider-label--sub">
          {tr('groupLabel', '本地')}
        </div>
        <div className="yolo-local-embedding-desktop-only">
          {tr('desktopOnly', '本地嵌入模型仅支持桌面端。')}
        </div>
      </div>
    )
  }

  return (
    <div className="yolo-local-embedding-group">
      <div className="yolo-kb-divider-label yolo-kb-divider-label--sub">
        {tr('groupLabel', '本地')}
        <span className="yolo-kb-divider-label-faint">
          {tr('groupDesc', '完全在本机运行嵌入计算，无需 API Key。')}
        </span>
      </div>

      <div className="yolo-local-embedding-list">
        {LOCAL_EMBEDDING_CATALOG.map((entry) => {
          const state: LocalEmbeddingModelState = modelSnapshot.get(
            entry.id,
          ) ?? { status: 'not-installed' }
          const expanded = expandedIds.has(entry.id)
          const current = isCurrent(entry)

          return (
            <div
              key={entry.id}
              className={`yolo-local-embedding-row${current ? ' is-current' : ''}`}
            >
              <div className="yolo-local-embedding-row-main">
                <div className="yolo-local-embedding-row-name">
                  {entry.displayName}
                  <a
                    href={`https://huggingface.co/${entry.hfRepo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="yolo-local-embedding-hf-link"
                    aria-label={entry.hfRepo}
                  >
                    <ExternalLink size={12} />
                  </a>
                  {entry.recommended && (
                    <span className="yolo-local-embedding-tag is-recommended">
                      {t('settings.defaults.recommendedBadge', '推荐')}
                    </span>
                  )}
                  {current && (
                    <span className="yolo-kb-status-pill green">
                      <Check size={10} /> {tr('current', '当前使用')}
                    </span>
                  )}
                </div>
                <div className="yolo-local-embedding-row-meta">
                  {tr(
                    'metaLine',
                    '{{dimension}} 维 · {{languages}} · {{size}}',
                    {
                      dimension: entry.dimension,
                      languages: entry.languages.join(', '),
                      size: formatBytes(entry.totalBytes),
                    },
                  )}
                </div>
                {state.status === 'downloading' && (
                  <div className="yolo-local-embedding-row-status">
                    <div className="yolo-local-embedding-progress">
                      <span
                        style={{
                          width: `${state.totalBytes > 0 ? Math.min(100, Math.round((state.receivedBytes / state.totalBytes) * 100)) : 0}%`,
                        }}
                      />
                    </div>
                    {tr(
                      'downloadingLine',
                      '正在下载 {{file}} — {{percent}}%（{{received}} / {{total}}）',
                      {
                        file: state.currentFile,
                        percent:
                          state.totalBytes > 0
                            ? Math.min(
                                100,
                                Math.round(
                                  (state.receivedBytes / state.totalBytes) *
                                    100,
                                ),
                              )
                            : 0,
                        received: formatBytes(state.receivedBytes),
                        total: formatBytes(state.totalBytes),
                      },
                    )}
                  </div>
                )}
                {state.status === 'verifying' && (
                  <div className="yolo-local-embedding-row-status">
                    {tr('verifying', '正在校验文件…')}
                  </div>
                )}
                {state.status === 'ready' && (
                  <div className="yolo-local-embedding-row-status is-ready">
                    {tr('readyLine', '已下载')}
                  </div>
                )}
                {state.status === 'failed' && (
                  <div className="yolo-local-embedding-row-status is-error">
                    {tr('failedLine', '下载失败：{{error}}', {
                      error: state.error,
                    })}
                  </div>
                )}

                <button
                  type="button"
                  className="yolo-local-embedding-disclosure"
                  onClick={() => toggleExpanded(entry.id)}
                >
                  {expanded ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                  {expanded
                    ? tr('hideSource', '收起来源')
                    : tr('viewSource', '查看来源')}
                </button>
                {expanded && (
                  <div className="yolo-local-embedding-source">
                    <div>
                      <span>{tr('sourceRepoLabel', '仓库')}</span>
                      <code>{entry.hfRepo}</code>
                    </div>
                    <div>
                      <span>{tr('sourceRevisionLabel', '版本')}</span>
                      <code>{entry.revision.slice(0, 12)}</code>
                    </div>
                    <div>
                      <span>{tr('sourceFilesLabel', '文件')}</span>
                      <code>
                        {entry.files.map((file) => file.path).join(', ')}
                      </code>
                    </div>
                  </div>
                )}
              </div>
              <div className="yolo-local-embedding-row-side">
                {state.status === 'not-installed' && (
                  <ObsidianButton
                    text={tr('download', '下载')}
                    icon="download"
                    onClick={() => handleDownload(entry)}
                  />
                )}
                {state.status === 'downloading' && (
                  <ObsidianButton
                    text={t('common.cancel', '取消')}
                    icon="x"
                    onClick={() => manager.cancelDownload(entry.id)}
                  />
                )}
                {state.status === 'failed' && (
                  <>
                    <ObsidianButton
                      text={t('common.retry', '重试')}
                      icon="rotate-cw"
                      onClick={() => handleDownload(entry)}
                    />
                    <ObsidianButton
                      icon="trash-2"
                      tooltip={t('common.delete', '删除')}
                      onClick={() => handleDelete(entry)}
                    />
                  </>
                )}
                {state.status === 'ready' && !current && (
                  <>
                    <ObsidianButton
                      text={t(
                        'settings.knowledgeBases.setAsCurrent',
                        '设为当前',
                      )}
                      cta
                      onClick={() => handleSetCurrent(entry)}
                    />
                    <ObsidianButton
                      icon="trash-2"
                      tooltip={t('common.delete', '删除')}
                      onClick={() => handleDelete(entry)}
                    />
                  </>
                )}
                {state.status === 'ready' && current && (
                  <ObsidianButton
                    icon="trash-2"
                    tooltip={t('common.delete', '删除')}
                    onClick={() => handleDelete(entry)}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="yolo-local-embedding-footer">
        <span className="yolo-local-embedding-footer-label">
          {tr('endpointLabel', '下载源')}
        </span>
        <ObsidianDropdown
          value={showCustomEndpoint ? CUSTOM_ENDPOINT_SENTINEL : endpoint}
          options={{
            [DEFAULT_LOCAL_EMBEDDING_ENDPOINT]: 'huggingface.co',
            [HF_MIRROR_LOCAL_EMBEDDING_ENDPOINT]: 'hf-mirror.com',
            [CUSTOM_ENDPOINT_SENTINEL]: tr('endpointCustomOption', '自定义'),
          }}
          onChange={(value) => {
            if (value === CUSTOM_ENDPOINT_SENTINEL) {
              setShowCustomEndpoint(true)
              return
            }
            setShowCustomEndpoint(false)
            applySettingsUpdate({
              ...settings,
              localEmbedding: { ...settings.localEmbedding, endpoint: value },
            })
          }}
        />
        {showCustomEndpoint && (
          <ObsidianTextInput
            value={customDraft}
            placeholder={tr('endpointCustomPlaceholder', 'https://example.com')}
            onChange={(value) => {
              setCustomDraft(value)
              const trimmed = value.trim().replace(/\/+$/, '')
              if (/^https?:\/\/.+/i.test(trimmed)) {
                applySettingsUpdate({
                  ...settings,
                  localEmbedding: {
                    ...settings.localEmbedding,
                    endpoint: trimmed,
                  },
                })
              }
            }}
          />
        )}
        <span className="yolo-local-embedding-footer-spacer" />
        <span className="yolo-local-embedding-footer-storage">
          {tr('storageUsed', '已占用 {{size}}', {
            size: formatBytes(storageUsedBytes),
          })}
        </span>
        <ObsidianButton
          text={tr('manageDownloaded', '管理已下载模型')}
          disabled={storageUsedBytes === 0}
          onClick={handleManageDownloaded}
        />
      </div>
    </div>
  )
}
