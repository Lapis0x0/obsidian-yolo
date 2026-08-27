import { Check, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { Notice, Platform } from 'obsidian'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

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
import type YoloPlugin from '../../../../main'
import { EmbeddingModel } from '../../../../types/embedding-model.types'
import {
  ensureUniqueModelId,
  generateModelId,
} from '../../../../utils/model-id-utils'
import { ObsidianButton } from '../../../common/ObsidianButton'
import { ObsidianDropdown } from '../../../common/ObsidianDropdown'
import { ObsidianTextInput } from '../../../common/ObsidianTextInput'

const CUSTOM_ENDPOINT_SENTINEL = '__custom__'
const DELETE_CONFIRM_TIMEOUT_MS = 3000

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

export type LocalEmbeddingEngineIssueKind =
  | 'non-desktop'
  | 'model-not-downloaded'
  | 'model-failed'
  | 'model-downloading'
  | 'model-verifying'
  | 'component-disabled'
  | 'component-failed'
  | 'component-preparing'

export type LocalEmbeddingEngineIssueAction =
  | 'download'
  | 'cancel'
  | 'retry-download'
  | 'enable'
  | 'retry-component'

export type LocalEmbeddingEngineIssue = Readonly<{
  kind: LocalEmbeddingEngineIssueKind
  entry: LocalEmbeddingCatalogEntry
  action?: LocalEmbeddingEngineIssueAction
  /** Populated for `model-failed`. */
  error?: string
  /** Populated for `model-downloading` — 0-100, rounded. */
  percent?: number
}>

type Translate = (key: string, fallback?: string) => string

/** `t('settings.knowledgeBases.localEmbedding.<key>', fallback)` with
 * `{{var}}` interpolation — the one place both the shelf and the status-bar
 * copy helper below resolve this namespace's strings from. */
function localEmbeddingTranslator(t: Translate) {
  return (
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ) => {
    const raw = t(`settings.knowledgeBases.localEmbedding.${key}`, fallback)
    return vars ? format(raw, vars) : raw
  }
}

/**
 * Health check for the *currently selected* embedding model: healthy means
 * "model ready, `embedding-engine` component enabled, component status in
 * {ready, active, loading}" — anything else is a `LocalEmbeddingEngineIssue`
 * for `RAGSection`'s status bar to take over its one status line with
 * (instead of adding a second), per
 * docs/plans/08-22-local-embedding/00-plan.md §3.6. `null` whenever the
 * current model isn't local, or is local and healthy.
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

    const state = modelSnapshot.get(entry.id) ?? { status: 'not-installed' }
    if (state.status === 'downloading') {
      return {
        kind: 'model-downloading',
        entry,
        action: 'cancel',
        percent:
          state.totalBytes > 0
            ? Math.min(
                100,
                Math.round((state.receivedBytes / state.totalBytes) * 100),
              )
            : 0,
      }
    }
    if (state.status === 'verifying') {
      return { kind: 'model-verifying', entry }
    }
    if (state.status === 'failed') {
      return {
        kind: 'model-failed',
        entry,
        action: 'retry-download',
        error: state.error,
      }
    }
    if (state.status === 'not-installed') {
      return { kind: 'model-not-downloaded', entry, action: 'download' }
    }

    // `state.status === 'ready'` from here — the model itself is fine, so
    // any remaining issue is with the `embedding-engine` component.
    const record = runtimeSnapshot.find(
      (r) => r.descriptor.id === 'embedding-engine',
    )
    if (!record) return null
    if (!record.enabled) {
      return { kind: 'component-disabled', entry, action: 'enable' }
    }
    if (record.status === 'failed') {
      return { kind: 'component-failed', entry, action: 'retry-component' }
    }
    if (!['ready', 'active', 'loading'].includes(record.status)) {
      return { kind: 'component-preparing', entry }
    }
    return null
  }, [currentModel, modelSnapshot, runtimeSnapshot])
}

/**
 * Status-bar copy + action-button label for one `LocalEmbeddingEngineIssue`
 * — kept as one small mapping here (not a growing ternary chain in
 * `RAGSection`) so the status bar's JSX only has to render whatever this
 * returns.
 */
export function describeLocalEmbeddingEngineIssue(
  issue: LocalEmbeddingEngineIssue,
  t: Translate,
): { line: string; sub: string | null; actionLabel: string | null } {
  const tr = localEmbeddingTranslator(t)
  switch (issue.kind) {
    case 'non-desktop':
      return {
        line: tr('engineNonDesktop', '本地嵌入不可用'),
        sub: tr('engineNonDesktopSub', '本地嵌入模型仅支持桌面端运行。'),
        actionLabel: null,
      }
    case 'model-not-downloaded':
      return {
        line: tr('engineModelNotDownloaded', '本地嵌入模型尚未下载'),
        sub: tr(
          'engineModelNotDownloadedSub',
          '请在知识库设置中下载模型后再使用本地嵌入。',
        ),
        actionLabel: tr('engineDownloadAction', '下载模型'),
      }
    case 'model-failed':
      return {
        line: tr('engineModelFailedLine', '本地嵌入模型下载失败：{{error}}', {
          error: issue.error ?? '',
        }),
        sub: null,
        actionLabel: t('common.retry', '重试'),
      }
    case 'model-downloading':
      return {
        line: tr(
          'engineModelDownloadingLine',
          '本地嵌入模型下载中 {{percent}}%',
          {
            percent: issue.percent ?? 0,
          },
        ),
        sub: null,
        actionLabel: t('common.cancel', '取消'),
      }
    case 'model-verifying':
      return {
        line: tr('engineModelVerifying', '正在校验本地嵌入模型文件…'),
        sub: null,
        actionLabel: null,
      }
    case 'component-disabled':
      return {
        line: tr('engineComponentDisabled', '本地嵌入引擎已禁用'),
        sub: tr(
          'engineComponentDisabledSub',
          '请启用嵌入引擎后再使用本地嵌入。',
        ),
        actionLabel: tr('engineEnableAction', '启用'),
      }
    case 'component-failed':
      return {
        line: tr('engineComponentFailed', '本地嵌入引擎初始化失败'),
        sub: null,
        actionLabel: t('common.retry', '重试'),
      }
    case 'component-preparing':
      return {
        line: tr('engineComponentPreparing', '本地嵌入引擎准备中…'),
        sub: null,
        actionLabel: null,
      }
  }
}

type LocalEmbeddingShelfProps = {
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
export function LocalEmbeddingShelf({ plugin }: LocalEmbeddingShelfProps) {
  const { settings, updateSettings } = useSettings()
  const { t } = useLanguage()
  const tr = useMemo(() => localEmbeddingTranslator(t), [t])

  // Every write here goes through `updateSettings`'s `(prev) => next`
  // updater rather than closing over the `settings` this render saw —
  // otherwise an update that lands while another settings write elsewhere
  // is in flight would overwrite it with a stale full snapshot.
  const applySettingsUpdate = (
    updater: (prev: typeof settings) => typeof settings,
    errorMessage?: string,
  ) => {
    void (async () => {
      try {
        await updateSettings(updater)
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

  const handleSetCurrent = (entry: LocalEmbeddingCatalogEntry) => {
    const baseId = generateModelId(LOCAL_EMBEDDING_PROVIDER_ID, entry.id)
    applySettingsUpdate((prev) => {
      const existing = prev.embeddingModels.find(
        (m) =>
          m.providerId === LOCAL_EMBEDDING_PROVIDER_ID && m.model === entry.id,
      )
      if (existing) {
        return { ...prev, embeddingModelId: existing.id }
      }
      const id = ensureUniqueModelId(
        prev.embeddingModels.map((m) => m.id),
        baseId,
      )
      const record: EmbeddingModel = {
        providerId: LOCAL_EMBEDDING_PROVIDER_ID,
        id,
        model: entry.id,
        name: entry.displayName,
        dimension: entry.dimension,
        nativeDimension: entry.dimension,
      }
      return {
        ...prev,
        embeddingModels: [...prev.embeddingModels, record],
        embeddingModelId: id,
      }
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

  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  )
  const deleteConfirmTimerRef = useRef<number | null>(null)
  const clearDeleteConfirmTimer = () => {
    if (deleteConfirmTimerRef.current !== null) {
      window.clearTimeout(deleteConfirmTimerRef.current)
      deleteConfirmTimerRef.current = null
    }
  }
  useEffect(() => () => clearDeleteConfirmTimer(), [])

  const handleDelete = (entry: LocalEmbeddingCatalogEntry) => {
    if (confirmingDeleteId !== entry.id) {
      clearDeleteConfirmTimer()
      setConfirmingDeleteId(entry.id)
      deleteConfirmTimerRef.current = window.setTimeout(() => {
        setConfirmingDeleteId((current) =>
          current === entry.id ? null : current,
        )
        deleteConfirmTimerRef.current = null
      }, DELETE_CONFIRM_TIMEOUT_MS)
      return
    }
    clearDeleteConfirmTimer()
    setConfirmingDeleteId(null)
    manager.remove(entry.id).catch((error: unknown) => {
      console.error('[YOLO] Failed to remove local embedding model:', error)
    })
  }

  const endpoint = settings.localEmbedding.endpoint
  const isKnownPreset =
    endpoint === DEFAULT_LOCAL_EMBEDDING_ENDPOINT ||
    endpoint === HF_MIRROR_LOCAL_EMBEDDING_ENDPOINT
  const [customDraft, setCustomDraft] = useState(isKnownPreset ? '' : endpoint)
  const [customDraftError, setCustomDraftError] = useState<string | null>(null)
  const [showCustomEndpoint, setShowCustomEndpoint] = useState(!isKnownPreset)
  useEffect(() => {
    const known =
      endpoint === DEFAULT_LOCAL_EMBEDDING_ENDPOINT ||
      endpoint === HF_MIRROR_LOCAL_EMBEDDING_ENDPOINT
    setShowCustomEndpoint(!known)
    if (!known) setCustomDraft(endpoint)
    setCustomDraftError(null)
  }, [endpoint])

  // Local draft only — committed on blur (see `commitCustomEndpoint`), not
  // on every keystroke, so a half-typed URL never becomes the live download
  // source.
  const commitCustomEndpoint = () => {
    const trimmed = customDraft.trim()
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      setCustomDraftError(
        tr('endpointCustomInvalid', '请输入合法的 http/https 地址'),
      )
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setCustomDraftError(
        tr('endpointCustomInvalid', '请输入合法的 http/https 地址'),
      )
      return
    }
    setCustomDraftError(null)
    const normalized = trimmed.replace(/\/+$/, '')
    applySettingsUpdate((prev) => ({
      ...prev,
      localEmbedding: { ...prev.localEmbedding, endpoint: normalized },
    }))
  }

  const groupHeader = (
    <div className="yolo-kb-ml-group">
      <b>{tr('groupLabel', '本地')}</b>
      {tr('groupDesc', '在你的设备上运行，笔记内容不出本机')}
    </div>
  )

  if (!Platform.isDesktop) {
    return (
      <>
        {groupHeader}
        <div className="yolo-kb-ml-row">
          <div className="yolo-kb-ml-main">
            <div className="yolo-kb-ml-meta">
              {tr('desktopOnly', '本地嵌入模型仅支持桌面端。')}
            </div>
          </div>
        </div>
      </>
    )
  }

  const percentOf = (received: number, total: number) =>
    total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0

  return (
    <>
      {groupHeader}
      {LOCAL_EMBEDDING_CATALOG.map((entry) => {
        const state: LocalEmbeddingModelState = modelSnapshot.get(entry.id) ?? {
          status: 'not-installed',
        }
        const expanded = expandedIds.has(entry.id)
        const current = isCurrent(entry)
        const sizeLabel = formatBytes(entry.totalBytes)

        return (
          <div
            key={entry.id}
            className={`yolo-kb-ml-row${current ? ' is-current' : ''}`}
          >
            <div className="yolo-kb-ml-main">
              <div className="yolo-kb-ml-name is-plain">
                {entry.hfRepo}
                <a
                  href={`https://huggingface.co/${entry.hfRepo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="yolo-kb-ml-hf"
                  aria-label={entry.hfRepo}
                >
                  <ExternalLink size={12} />
                </a>
                {entry.languages.map((code) => (
                  <span key={code} className="yolo-kb-ml-tag">
                    {tr(`languageNames.${code}`, code)}
                  </span>
                ))}
                <span className="yolo-kb-ml-tag">
                  {entry.dtype === 'fp16'
                    ? tr('dtypeBadge.fp16', 'FP16')
                    : tr('dtypeBadge.q8', 'INT8')}
                </span>
              </div>
              <div className="yolo-kb-ml-meta">
                {state.status === 'downloading' ? (
                  <>
                    <span className="yolo-kb-ml-progress">
                      <span
                        style={{
                          transform: `scaleX(${percentOf(state.receivedBytes, state.totalBytes) / 100})`,
                        }}
                      />
                    </span>
                    {tr(
                      'downloadingLine',
                      '下载中 {{percent}}% · {{received}} / {{total}}',
                      {
                        percent: percentOf(
                          state.receivedBytes,
                          state.totalBytes,
                        ),
                        received: formatBytes(state.receivedBytes),
                        total: formatBytes(state.totalBytes),
                      },
                    )}
                  </>
                ) : (
                  <span>
                    {tr('metaLine', '{{dimension}} 维 · {{size}}', {
                      dimension: entry.dimension,
                      size: sizeLabel,
                    })}
                    {state.status === 'ready' &&
                      ` · ${tr('readyLine', '已下载')}`}
                    {state.status === 'verifying' &&
                      ` · ${tr('verifying', '正在校验文件…')}`}
                  </span>
                )}
                {state.status === 'failed' && (
                  <span className="yolo-kb-ml-error">
                    {tr('failedLine', '下载失败：{{error}}', {
                      error: state.error,
                    })}
                  </span>
                )}
                <span
                  role="button"
                  tabIndex={0}
                  className="yolo-kb-ml-source-toggle"
                  aria-expanded={expanded}
                  onClick={() => toggleExpanded(entry.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      toggleExpanded(entry.id)
                    }
                  }}
                >
                  {tr('viewSource', '来源')}
                  {expanded ? (
                    <ChevronDown size={11} />
                  ) : (
                    <ChevronRight size={11} />
                  )}
                </span>
              </div>
              {expanded && (
                <dl className="yolo-kb-ml-source">
                  <dt>{tr('sourceRepoLabel', '仓库')}</dt>
                  <dd>
                    <code>{entry.hfRepo}</code>
                  </dd>
                  <dt>{tr('sourceRevisionLabel', '版本')}</dt>
                  <dd>
                    <code>{entry.revision}</code>
                  </dd>
                  <dt>{tr('sourceFilesLabel', '文件')}</dt>
                  <dd>
                    {entry.files.map((file) => (
                      <div key={file.path} className="yolo-kb-ml-source-file">
                        <code>{file.path}</code>
                        <span>
                          {formatBytes(file.byteSize)} · {file.sha256}
                        </span>
                      </div>
                    ))}
                  </dd>
                </dl>
              )}
            </div>
            <div className="yolo-kb-ml-side">
              {state.status === 'not-installed' && (
                <ObsidianButton
                  text={tr('download', '下载')}
                  onClick={() => handleDownload(entry)}
                />
              )}
              {state.status === 'downloading' && (
                <ObsidianButton
                  text={t('common.cancel', '取消')}
                  className="yolo-kb-ml-ghost"
                  onClick={() => manager.cancelDownload(entry.id)}
                />
              )}
              {state.status === 'failed' && (
                <ObsidianButton
                  text={t('common.retry', '重试')}
                  onClick={() => handleDownload(entry)}
                />
              )}
              {state.status === 'ready' && current && (
                <span className="yolo-kb-ml-current">
                  <Check size={10} strokeWidth={2.4} />
                  {tr('current', '当前使用')}
                </span>
              )}
              {state.status === 'ready' && !current && (
                <ObsidianButton
                  text={t('settings.knowledgeBases.setAsCurrent', '设为当前')}
                  className="yolo-kb-ml-ghost"
                  onClick={() => handleSetCurrent(entry)}
                />
              )}
              {(state.status === 'ready' || state.status === 'failed') && (
                <ObsidianButton
                  icon="trash-2"
                  className={
                    confirmingDeleteId === entry.id
                      ? 'yolo-kb-ml-icon-confirming'
                      : 'yolo-kb-ml-icon'
                  }
                  tooltip={
                    confirmingDeleteId === entry.id
                      ? tr('confirmDelete', '再次点击确认删除')
                      : t('common.delete', '删除')
                  }
                  onClick={() => handleDelete(entry)}
                />
              )}
            </div>
          </div>
        )
      })}

      <div className="yolo-kb-ml-foot">
        {tr('endpointLabel', '下载源')}
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
            setCustomDraftError(null)
            applySettingsUpdate((prev) => ({
              ...prev,
              localEmbedding: { ...prev.localEmbedding, endpoint: value },
            }))
          }}
        />
        {showCustomEndpoint && (
          <span className="yolo-kb-ml-endpoint-custom">
            <ObsidianTextInput
              value={customDraft}
              placeholder={tr(
                'endpointCustomPlaceholder',
                'https://example.com',
              )}
              onChange={(value) => {
                setCustomDraft(value)
                if (customDraftError) setCustomDraftError(null)
              }}
              onBlur={commitCustomEndpoint}
            />
            {customDraftError && (
              <span className="yolo-kb-ml-endpoint-error">
                {customDraftError}
              </span>
            )}
          </span>
        )}
      </div>
    </>
  )
}
