import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import dayjs from 'dayjs'
import { useReducedMotion } from 'framer-motion'
import {
  Ban,
  Clock,
  Database,
  Layers,
  Pickaxe,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { App, Notice } from 'obsidian'
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { RECOMMENDED_MODELS_FOR_EMBEDDING } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { LOCAL_EMBEDDING_PROVIDER_ID } from '../../../core/rag/local-embedding/constants'
import { RagIndexServiceSnapshot } from '../../../core/rag/ragIndexService'
import type YoloPlugin from '../../../main'
import { KnowledgeBase } from '../../../settings/schema/setting.types'
import { MOTION_DURATION_ENTER_S } from '../../../styles/tokens/motion'
import { getNodeWindow } from '../../../utils/dom/window-context'
import { ObsidianButton } from '../../common/ObsidianButton'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { IndexProgressRing } from '../IndexProgressRing'
import {
  EmbeddingDbManageModal,
  inMemoryIndexMb,
} from '../modals/EmbeddingDbManageModal'
import { KnowledgeBaseModal } from '../modals/KnowledgeBaseModal'
import {
  describeScope,
  includeScopeLabels,
  rulesFromWorkspaceScope,
} from '../scope/scopeRules'
import { resolveScopePathKind } from '../scope/scopeVault'

import {
  type LocalEmbeddingEngineIssue,
  LocalEmbeddingShelf,
  describeLocalEmbeddingEngineIssue,
  useLocalEmbeddingEngineIssue,
} from './rag/LocalEmbeddingShelf'

type RAGSectionProps = {
  app: App
  plugin: YoloPlugin
}

type KbData = {
  docCount: number
  chunkCount: number
  /** In-memory index size estimate (MB) — same int8 formula as
   * `EmbeddingDbManageModal`'s table, not the on-disk float32 `vectorBytes`. */
  estimateMb: number
  pendingChanged: number
}

const EMPTY_KB_DATA: KbData = {
  docCount: 0,
  chunkCount: 0,
  estimateMb: 0,
  pendingChanged: 0,
}

/** easeOutQuint — the JS mirror of `MOTION_EASE_OUT`. */
const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5)

/**
 * Tweens a stat from its previous value to the new one so live-indexing
 * numbers roll instead of jumping. rAF runs on the node's own window
 * (popout-safe); reduced motion degrades to an instant jump.
 */
function AnimatedNumber({
  value,
  format,
}: {
  value: number
  format: (n: number) => string
}) {
  const reducedMotion = useReducedMotion()
  const [display, setDisplay] = useState(value)
  const previousRef = useRef(value)
  const nodeRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const from = previousRef.current
    previousRef.current = value
    if (reducedMotion || from === value) {
      setDisplay(value)
      return
    }
    const win = getNodeWindow(nodeRef.current)
    const durationMs = MOTION_DURATION_ENTER_S * 1000
    const start = win.performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      setDisplay(from + (value - from) * easeOutQuint(t))
      if (t < 1) raf = win.requestAnimationFrame(tick)
    }
    raf = win.requestAnimationFrame(tick)
    return () => win.cancelAnimationFrame(raf)
  }, [value, reducedMotion])

  return <span ref={nodeRef}>{format(display)}</span>
}

/** The API row only lists API embedding models. When the current model is
 *  local, keep the last API pick (or the first available API model) so the
 *  dropdown never goes blank just because a local model is in use. */
function resolvePendingApiEmbeddingModelId(
  currentId: string,
  apiModels: readonly { id: string }[],
  pendingId: string,
): string {
  if (apiModels.some((model) => model.id === currentId)) return currentId
  if (apiModels.some((model) => model.id === pendingId)) return pendingId
  return apiModels[0]?.id ?? ''
}

/** File-based percent for a running/completed run — mirrors the previous
 * single-run RAGSection's ring computation, applied per knowledge base. */
function ringPercentFor(
  status: RagIndexServiceSnapshot['runs'][string] | undefined,
  isActive: boolean,
): number {
  if (!status) return 0
  if (!isActive && status.status === 'completed') return 100
  if ((status.totalFiles ?? 0) > 0) {
    const pct = Math.round(
      ((status.completedFiles ?? 0) / (status.totalFiles ?? 1)) * 100,
    )
    return Math.max(0, Math.min(100, pct))
  }
  if (!status.totalChunks) return 0
  const pct = Math.round(
    ((status.completedChunks ?? 0) / status.totalChunks) * 100,
  )
  return Math.max(0, Math.min(100, pct))
}

type Translate = (key: string, fallback: string) => string

function formatUpdatedAgo(at: number, t: Translate): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) {
    return t('settings.knowledgeBases.updatedJustNow', '刚刚更新')
  }
  if (minutes < 60) {
    return t(
      'settings.knowledgeBases.updatedMinutesAgo',
      '{{n}} 分钟前更新',
    ).replace('{{n}}', String(minutes))
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return t(
      'settings.knowledgeBases.updatedHoursAgo',
      '{{n}} 小时前更新',
    ).replace('{{n}}', String(hours))
  }
  const days = Math.round(hours / 24)
  if (days < 7) {
    return t(
      'settings.knowledgeBases.updatedDaysAgo',
      '{{n}} 天前更新',
    ).replace('{{n}}', String(days))
  }
  return t('settings.knowledgeBases.lastUpdated', '最近更新 {{time}}').replace(
    '{{time}}',
    dayjs(at).format('YYYY-MM-DD HH:mm'),
  )
}

function CardScopeCaption({
  labels,
  excludeCount,
  t,
}: {
  labels: string[]
  excludeCount: number
  t: Translate
}) {
  const named = labels.length <= 2 ? labels : labels.slice(0, 1)
  return (
    <span className="yolo-kb-card-meta-text">
      {labels.length === 0 ? (
        t('settings.knowledgeBases.scopeWholeVault', '整个库')
      ) : (
        <>
          {t('settings.knowledgeBases.scopeOnlyPrefix', '仅')}{' '}
          {named.map((name, index) => (
            <Fragment key={name}>
              {index > 0 ? '、' : null}
              <b>{name}</b>
            </Fragment>
          ))}
          {labels.length > 2
            ? t('settings.knowledgeBases.scopeAndMore', ' 等 {{n}} 处').replace(
                '{{n}}',
                String(labels.length),
              )
            : null}
        </>
      )}
      {excludeCount > 0
        ? t(
            'settings.knowledgeBases.scopeExcludeSuffix',
            '，排除 {{n}} 处',
          ).replace('{{n}}', String(excludeCount))
        : null}
    </span>
  )
}

export function RAGSection({ app, plugin }: RAGSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const [indexSnapshot, setIndexSnapshot] = useState<RagIndexServiceSnapshot>(
    () => plugin.getRagIndexSnapshot(),
  )
  const [kbData, setKbData] = useState<Record<string, KbData>>({})
  // Popout-safe realm for this section's own timers (debounce, throttle) —
  // captured from the mounted node rather than the bare global `window`, so
  // scheduling still targets the right window when this settings tab is open
  // in a popout. See `src/utils/dom/window-context.ts`.
  const [portalContainer, setPortalContainer] = useState<HTMLElement>()
  const sectionWindowRef = useRef<Window & typeof globalThis>(window)
  const sectionRef = useCallback((node: HTMLDivElement | null) => {
    sectionWindowRef.current = getNodeWindow(node)
    setPortalContainer(node?.ownerDocument.body)
  }, [])

  const isRagEnabled = settings.ragOptions.enabled ?? true
  const isAutoUpdateEnabled = settings.ragOptions.autoUpdateEnabled ?? true
  const isIndexPdfEnabled = settings.ragOptions.indexPdf ?? true
  const knowledgeBases = settings.knowledgeBases

  useEffect(() => {
    return plugin.subscribeToRagIndexRuns(setIndexSnapshot)
  }, [plugin])

  // Cheap per-kb stats/pending recompute: on mount, whenever the knowledge
  // base list or its scopes change, and on a throttled vault-event timer —
  // matches the plan's "Tab 挂载、每次运行结束、vault 文件事件节流 2s 后重算".
  const refreshKbData = useCallback(async () => {
    if (knowledgeBases.length === 0) {
      setKbData({})
      return
    }
    const dbManager = await plugin.getDbManager()
    const currentDimension = settings.embeddingModels.find(
      (model) => model.id === settings.embeddingModelId,
    )?.dimension
    const entries = await Promise.all(
      knowledgeBases.map(async (kb): Promise<[string, KbData]> => {
        try {
          const vectorManager = await dbManager.getVectorManager(kb.id)
          const [docCount, stats, pending] = await Promise.all([
            vectorManager.getIndexedFileCount(settings.embeddingModelId),
            vectorManager.getEmbeddingStats(),
            plugin.countPendingChanges(kb.id),
          ])
          const modelStats = stats.find(
            (s) => s.model === settings.embeddingModelId,
          )
          const rowCount = modelStats?.rowCount ?? 0
          return [
            kb.id,
            {
              docCount,
              chunkCount: rowCount,
              estimateMb: inMemoryIndexMb(rowCount, currentDimension) ?? 0,
              pendingChanged: pending.changed,
            },
          ]
        } catch (error) {
          console.warn(
            `[YOLO] Failed to load knowledge base stats for "${kb.id}".`,
            error,
          )
          return [kb.id, EMPTY_KB_DATA]
        }
      }),
    )
    setKbData(Object.fromEntries(entries))
  }, [
    plugin,
    knowledgeBases,
    settings.embeddingModelId,
    settings.embeddingModels,
  ])

  const knowledgeBaseScopeKey = useMemo(
    () =>
      knowledgeBases
        .map((kb) => `${kb.id}:${kb.include.join(',')}:${kb.exclude.join(',')}`)
        .join('|'),
    [knowledgeBases],
  )

  useEffect(() => {
    void refreshKbData()
  }, [refreshKbData, knowledgeBaseScopeKey])

  // While a run is active, vectors land in IndexedDB batch by batch
  // (VectorManager flushes per adaptive batch), so poll the same cheap stats
  // on the vault-event cadence to let the card's doc/chunk/MB numbers grow
  // live instead of sitting at 0 until completion.
  const anyRunRunning = useMemo(
    () =>
      Object.values(indexSnapshot.runs).some((run) => run.status === 'running'),
    [indexSnapshot],
  )
  useEffect(() => {
    if (!anyRunRunning) return
    const win = sectionWindowRef.current
    const timer = win.setInterval(() => {
      void refreshKbData()
    }, 2000)
    return () => win.clearInterval(timer)
  }, [anyRunRunning, refreshKbData])

  const previousRunningKbIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const runningNow = new Set(
      Object.entries(indexSnapshot.runs)
        .filter(([, run]) => run.status === 'running')
        .map(([kbId]) => kbId),
    )
    const previous = previousRunningKbIdsRef.current
    const anyFinished = [...previous].some((kbId) => !runningNow.has(kbId))
    previousRunningKbIdsRef.current = runningNow
    if (anyFinished) {
      void refreshKbData()
    }
  }, [indexSnapshot, refreshKbData])

  useEffect(() => {
    const vault = plugin.app.vault
    let timer: number | null = null
    const scheduleRefresh = () => {
      if (timer !== null) return
      timer = sectionWindowRef.current.setTimeout(() => {
        timer = null
        void refreshKbData()
      }, 2000)
    }
    const events = ['create', 'modify', 'delete', 'rename'] as const

    const refs = events.map((name) => (vault as any).on(name, scheduleRefresh))
    return () => {
      if (timer !== null) sectionWindowRef.current.clearTimeout(timer)

      refs.forEach((ref: any) => vault.offref(ref))
    }
  }, [plugin, refreshKbData])

  // Any base whose scope, or a shared setting (embedding model / chunk size /
  // PDF indexing), just changed converges through the same idempotent `sync`
  // path — debounced per base so rapid edits collapse into one run.
  const syncTimersRef = useRef<Map<string, number>>(new Map())
  const previousSyncInputsRef = useRef<{
    embeddingModelId: string
    chunkSize: number
    indexPdf: boolean
    scopeByKbId: Map<string, string>
  } | null>(null)

  useEffect(() => {
    const scopeByKbId = new Map(
      knowledgeBases.map((kb) => [
        kb.id,
        `${kb.include.join(',')} ${kb.exclude.join(',')}`,
      ]),
    )
    const next = {
      embeddingModelId: settings.embeddingModelId,
      chunkSize: settings.ragOptions.chunkSize,
      indexPdf: isIndexPdfEnabled,
      scopeByKbId,
    }
    const previous = previousSyncInputsRef.current
    previousSyncInputsRef.current = next
    if (!previous || !isRagEnabled || !next.embeddingModelId) return

    const sharedChanged =
      previous.embeddingModelId !== next.embeddingModelId ||
      previous.chunkSize !== next.chunkSize ||
      previous.indexPdf !== next.indexPdf

    for (const kb of knowledgeBases) {
      const scopeChanged =
        previous.scopeByKbId.get(kb.id) !== next.scopeByKbId.get(kb.id)
      if (!sharedChanged && !scopeChanged) continue
      const timers = syncTimersRef.current
      const existingTimer = timers.get(kb.id)
      if (existingTimer !== undefined)
        sectionWindowRef.current.clearTimeout(existingTimer)
      timers.set(
        kb.id,
        sectionWindowRef.current.setTimeout(() => {
          timers.delete(kb.id)
          plugin
            .runRagIndex(kb.id, {
              mode: 'sync',
              scope: { kind: 'all' },
              trigger: 'manual',
              retryPolicy: 'transient',
            })
            .catch((error: unknown) => {
              console.error(
                `[YOLO] Failed to sync knowledge base "${kb.id}":`,
                error,
              )
            })
        }, 800),
      )
    }
  }, [
    isRagEnabled,
    isIndexPdfEnabled,
    knowledgeBases,
    plugin,
    settings.embeddingModelId,
    settings.ragOptions.chunkSize,
  ])

  useEffect(() => {
    const timers = syncTimersRef.current
    return () => {
      for (const timer of timers.values())
        sectionWindowRef.current.clearTimeout(timer)
    }
  }, [])

  const applySettingsUpdate = useCallback(
    (nextSettings: typeof settings, errorMessage?: string) => {
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
    },
    [setSettings, t],
  )

  const runIndexJob = useCallback(
    async (
      kbId: string,
      mode: 'rebuild' | 'sync',
      {
        successNotice,
        failureNotice,
      }: { successNotice?: string; failureNotice: string },
    ) => {
      try {
        const result = await plugin.runRagIndex(kbId, {
          mode,
          scope: { kind: 'all' },
          trigger: 'manual',
          retryPolicy: 'transient',
        })
        const skippedCount = result.permanentFailedPaths.length
        if (skippedCount > 0) {
          new Notice(
            t(
              'notices.indexedWithSkipped',
              '索引完成，{{count}} 个文件无法索引',
            ).replace('{{count}}', String(skippedCount)),
          )
        } else if (successNotice) {
          new Notice(successNotice)
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          new Notice(t('notices.indexCancelled', '索引已取消'))
        } else {
          console.error('[YOLO] Failed to update knowledge base index:', error)
          new Notice(failureNotice)
        }
      } finally {
        void refreshKbData()
      }
    },
    [plugin, refreshKbData, t],
  )

  const activeKbId = indexSnapshot.activeKbId
  const activeRun = activeKbId ? indexSnapshot.runs[activeKbId] : undefined
  const isIndexing = activeKbId !== null
  const queuedCount = indexSnapshot.queuedKbIds.length

  // Cancelling an active run now force-tears-down the embedding session
  // (see `ragIndexService.ts`), which is fast but not instant — a stuck
  // Worker can take a few seconds to force-terminate. Without this, the
  // button just sits there looking unresponsive for that whole window.
  const [isCancellingIndex, setIsCancellingIndex] = useState(false)
  useEffect(() => {
    if (!isIndexing) setIsCancellingIndex(false)
  }, [isIndexing])

  const totalDocs = useMemo(
    () =>
      knowledgeBases.reduce(
        (sum, kb) => sum + (kbData[kb.id]?.docCount ?? 0),
        0,
      ),
    [knowledgeBases, kbData],
  )
  const totalPending = useMemo(
    () =>
      knowledgeBases.reduce(
        (sum, kb) => sum + (kbData[kb.id]?.pendingChanged ?? 0),
        0,
      ),
    [knowledgeBases, kbData],
  )
  const failedOrRetryingCount = useMemo(
    () =>
      Object.values(indexSnapshot.runs).filter(
        (run) => run.status === 'failed' || run.status === 'retry_scheduled',
      ).length,
    [indexSnapshot.runs],
  )

  // `yolo-local` models get their own "本地" shelf (`LocalEmbeddingShelf`)
  // right below this row — excluded here so there's exactly one entry point
  // to pick/manage a local model, not two.
  const apiEmbeddingModels = useMemo(
    () =>
      settings.embeddingModels.filter(
        (model) => model.providerId !== LOCAL_EMBEDDING_PROVIDER_ID,
      ),
    [settings.embeddingModels],
  )

  const embeddingModelOptionGroups = useMemo<
    ObsidianDropdownOptionGroup[]
  >(() => {
    const providerOrder = settings.providers.map((p) => p.id)
    const providerIdsInModels = Array.from(
      new Set(apiEmbeddingModels.map((model) => model.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]
    const recommendedBadge =
      t('settings.defaults.recommendedBadge') ?? '(Recommended)'

    return orderedProviderIds
      .map<ObsidianDropdownOptionGroup | null>((providerId) => {
        const groupModels = apiEmbeddingModels.filter(
          (model) => model.providerId === providerId,
        )
        if (groupModels.length === 0) return null
        return {
          label: providerId,
          options: groupModels.map((model) => {
            const baseLabel = model.name || model.model || model.id
            const badge = RECOMMENDED_MODELS_FOR_EMBEDDING.includes(model.id)
              ? ` ${recommendedBadge}`
              : ''
            return { value: model.id, label: `${baseLabel}${badge}`.trim() }
          }),
        }
      })
      .filter((group): group is ObsidianDropdownOptionGroup => group !== null)
  }, [apiEmbeddingModels, settings.providers, t])

  const currentEmbeddingModel = settings.embeddingModels.find(
    (m) => m.id === settings.embeddingModelId,
  )
  const currentEmbeddingModelLabel = useMemo(() => {
    return currentEmbeddingModel
      ? currentEmbeddingModel.name ||
          currentEmbeddingModel.model ||
          currentEmbeddingModel.id
      : settings.embeddingModelId
  }, [currentEmbeddingModel, settings.embeddingModelId])

  // The only scenario where local-embedding engine info surfaces in the
  // status bar: the currently selected model is local and can't actually
  // run right now (not downloaded / component disabled / mobile). See
  // docs/plans/08-22-local-embedding/00-plan.md §3.6.
  const localEmbeddingIssue = useLocalEmbeddingEngineIssue(
    plugin,
    currentEmbeddingModel,
  )
  const localEmbeddingIssueCopy = useMemo(
    () =>
      localEmbeddingIssue
        ? describeLocalEmbeddingEngineIssue(localEmbeddingIssue, t)
        : null,
    [localEmbeddingIssue, t],
  )
  const handleLocalEmbeddingIssueAction = useCallback(
    (issue: LocalEmbeddingEngineIssue) => {
      switch (issue.action) {
        case 'download':
        case 'retry-download':
          plugin
            .getLocalEmbeddingModelManager()
            .download(issue.entry)
            .catch((error: unknown) => {
              if (error instanceof DOMException && error.name === 'AbortError')
                return
              console.error(
                '[YOLO] Local embedding model download failed:',
                error,
              )
            })
          return
        case 'cancel':
          plugin.getLocalEmbeddingModelManager().cancelDownload(issue.entry.id)
          return
        case 'enable':
          plugin
            .getRuntimeComponentService()
            .setEnabled('embedding-engine', true)
            .catch((error: unknown) => {
              console.error('[YOLO] Failed to enable embedding-engine:', error)
              new Notice(
                t(
                  'settings.knowledgeBases.localEmbedding.engineEnableFailed',
                  '启用嵌入引擎失败',
                ),
              )
            })
          return
        case 'retry-component':
          plugin
            .getRuntimeComponentService()
            .retry('embedding-engine')
            .catch((error: unknown) => {
              console.error('[YOLO] Failed to retry embedding-engine:', error)
            })
          return
        default:
          return
      }
    },
    [plugin, t],
  )

  // The API row previews a selection locally — switching models means every
  // knowledge base's existing vectors stop matching (a de facto full rebuild),
  // so a dropdown pick alone must never apply it. A separate "set as current"
  // confirm step is required. This tracks that pending *API* pick and must
  // not be overwritten by a local model id (those live in the shelf below).
  const [pendingEmbeddingModelId, setPendingEmbeddingModelId] = useState(() =>
    resolvePendingApiEmbeddingModelId(
      settings.embeddingModelId,
      apiEmbeddingModels,
      '',
    ),
  )
  useEffect(() => {
    setPendingEmbeddingModelId((prev) =>
      resolvePendingApiEmbeddingModelId(
        settings.embeddingModelId,
        apiEmbeddingModels,
        prev,
      ),
    )
  }, [apiEmbeddingModels, settings.embeddingModelId])

  const [showAdvancedRagSettings, setShowAdvancedRagSettings] = useState(false)
  const [chunkSizeInput, setChunkSizeInput] = useState(
    String(settings.ragOptions.chunkSize),
  )
  const [minSimilarityInput, setMinSimilarityInput] = useState(
    String(settings.ragOptions.minSimilarity),
  )
  const [limitInput, setLimitInput] = useState(
    String(settings.ragOptions.limit),
  )
  const [embeddingConcurrencyInput, setEmbeddingConcurrencyInput] = useState(
    String(settings.ragOptions.embeddingConcurrency ?? 10),
  )

  useEffect(() => {
    setChunkSizeInput(String(settings.ragOptions.chunkSize))
  }, [settings.ragOptions.chunkSize])
  useEffect(() => {
    setMinSimilarityInput(String(settings.ragOptions.minSimilarity))
  }, [settings.ragOptions.minSimilarity])
  useEffect(() => {
    setLimitInput(String(settings.ragOptions.limit))
  }, [settings.ragOptions.limit])
  useEffect(() => {
    setEmbeddingConcurrencyInput(
      String(settings.ragOptions.embeddingConcurrency ?? 10),
    )
  }, [settings.ragOptions.embeddingConcurrency])

  const parseIntegerInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^\d+$/.test(trimmed)) return null
    return parseInt(trimmed, 10)
  }
  const parseFloatInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^\d*(?:[.,]\d*)?$/.test(trimmed)) return null
    if (
      trimmed === '.' ||
      trimmed === ',' ||
      trimmed.endsWith('.') ||
      trimmed.endsWith(',')
    )
      return null
    const normalized = trimmed.includes(',')
      ? trimmed.split(',').join('.')
      : trimmed
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }

  const handleOpenKbModal = (kbId?: string) => {
    new KnowledgeBaseModal(app, plugin, kbId).open()
  }

  const handleDeleteKb = (kb: KnowledgeBase) => {
    new ConfirmModal(app, {
      title: t('settings.knowledgeBases.deleteTitle', '删除知识库'),
      message: t(
        'settings.knowledgeBases.deleteConfirm',
        '将删除知识库「{{name}}」及其全部索引数据，此操作不可撤销。',
      ).replace('{{name}}', kb.name),
      ctaText: t('common.delete', '删除'),
      onConfirm: () => {
        void plugin.deleteKnowledgeBase(kb.id).catch((error: unknown) => {
          console.error('[YOLO] Failed to delete knowledge base:', error)
          new Notice(
            t('settings.knowledgeBases.deleteFailed', '删除知识库失败'),
          )
        })
      },
    }).open()
  }

  return (
    <div className="yolo-settings-section" ref={sectionRef}>
      <div className="yolo-settings-header">
        {t('settings.rag.title', '知识库')}
      </div>
      <div className="yolo-settings-desc">
        {t(
          'settings.rag.desc',
          '管理知识库索引。当 Agent 使用「搜索」工具并选择混合 & RAG 模式时，会自动调用知识库能力。',
        )}
      </div>

      {/* Status bar: main toggle + one-line status + primary actions. The
          local-embedding engine's health is not its own row — it only ever
          takes over this one status line, when the currently selected model
          is local and can't actually run right now. See
          docs/plans/08-22-local-embedding/00-plan.md §3.6. */}
      <div
        className={`yolo-kb-status-bar${isIndexing ? ' is-busy' : ''}${!isRagEnabled ? ' is-off' : ''}${isRagEnabled && localEmbeddingIssue ? ' is-warn' : ''}`}
      >
        <span className="yolo-kb-status-dot" />
        <div className="yolo-kb-status-text">
          {!isRagEnabled ? (
            <>
              <div className="yolo-kb-status-line">
                {t('settings.rag.indexingDisabled', '知识库索引已关闭')}
              </div>
              <div className="yolo-kb-status-sub">
                {t(
                  'settings.rag.indexingDisabledSub',
                  'Agent 的「搜索」工具将只使用关键词检索。可先选择嵌入模型，再开启索引。',
                )}
              </div>
            </>
          ) : localEmbeddingIssueCopy ? (
            <>
              <div className="yolo-kb-status-line">
                {localEmbeddingIssueCopy.line}
              </div>
              {localEmbeddingIssueCopy.sub && (
                <div className="yolo-kb-status-sub">
                  {localEmbeddingIssueCopy.sub}
                </div>
              )}
            </>
          ) : knowledgeBases.length === 0 ? (
            <div className="yolo-kb-status-line">
              {t('settings.knowledgeBases.emptyState', '还没有知识库')}
            </div>
          ) : isIndexing && activeRun ? (
            <>
              <div className="yolo-kb-status-line">
                {t('settings.rag.indexingProgress', '正在索引 {{kb}}').replace(
                  '{{kb}}',
                  knowledgeBases.find((kb) => kb.id === activeKbId)?.name ?? '',
                )}{' '}
                <b>{ringPercentFor(activeRun, true)}%</b>
              </div>
              <div className="yolo-kb-status-sub yolo-mono">
                {activeRun.currentFile ??
                  t('settings.rag.preparingProgress', 'Preparing index...')}
                {queuedCount > 0
                  ? ` · ${t('settings.knowledgeBases.queuedCount', '{{n}} 个知识库排队中').replace('{{n}}', String(queuedCount))}`
                  : ''}
              </div>
            </>
          ) : (
            <>
              <div className="yolo-kb-status-line">
                {t('settings.rag.indexedCount', '已索引 {{n}} 篇').replace(
                  '{{n}}',
                  String(totalDocs),
                )}
                {totalPending > 0 && (
                  <span className="yolo-kb-status-pill amber">
                    {t(
                      'settings.knowledgeBases.pendingCount',
                      '{{n}} 个待更新',
                    ).replace('{{n}}', String(totalPending))}
                  </span>
                )}
                {failedOrRetryingCount > 0 && (
                  <span className="yolo-kb-status-pill red">
                    {t(
                      'settings.knowledgeBases.attentionCount',
                      '{{n}} 个知识库需要关注',
                    ).replace('{{n}}', String(failedOrRetryingCount))}
                  </span>
                )}
              </div>
              <div className="yolo-kb-status-sub">
                {t('settings.knowledgeBases.count', '{{n}} 个知识库').replace(
                  '{{n}}',
                  String(knowledgeBases.length),
                )}
                {' · '}
                {t(
                  'settings.knowledgeBases.embeddingModelLine',
                  '嵌入模型 {{model}}',
                ).replace('{{model}}', currentEmbeddingModelLabel)}
              </div>
            </>
          )}
        </div>
        <div className="yolo-kb-status-actions">
          {!isRagEnabled ? (
            <ObsidianButton
              text={t(
                'settings.knowledgeBases.enableAndIndex',
                '开启并建立索引',
              )}
              cta
              onClick={() => {
                if (!settings.embeddingModelId) {
                  new Notice(
                    t(
                      'settings.rag.selectEmbeddingModelFirst',
                      '请先选择嵌入模型，再启用知识库索引。',
                    ),
                  )
                  return
                }
                applySettingsUpdate({
                  ...settings,
                  ragOptions: { ...settings.ragOptions, enabled: true },
                })
                for (const kb of knowledgeBases) {
                  void runIndexJob(kb.id, 'sync', {
                    failureNotice: t('notices.indexUpdateFailed'),
                  })
                }
              }}
            />
          ) : localEmbeddingIssue ? (
            localEmbeddingIssueCopy?.actionLabel ? (
              <ObsidianButton
                text={localEmbeddingIssueCopy.actionLabel}
                cta
                onClick={() =>
                  handleLocalEmbeddingIssueAction(localEmbeddingIssue)
                }
              />
            ) : null
          ) : knowledgeBases.length === 0 ? (
            <ObsidianButton
              text={t('settings.knowledgeBases.new', '新建知识库')}
              cta
              onClick={() => handleOpenKbModal()}
            />
          ) : (
            <>
              <span className="yolo-kb-status-auto">
                {t('settings.rag.autoUpdate', '自动更新')}
                <ObsidianToggle
                  value={isAutoUpdateEnabled}
                  onChange={(value) =>
                    applySettingsUpdate({
                      ...settings,
                      ragOptions: {
                        ...settings.ragOptions,
                        autoUpdateEnabled: value,
                      },
                    })
                  }
                />
              </span>
              {isIndexing ? (
                <ObsidianButton
                  text={
                    isCancellingIndex
                      ? t('settings.rag.cancellingIndex', '取消中…')
                      : t('settings.rag.cancelIndex', '取消')
                  }
                  disabled={isCancellingIndex}
                  onClick={() => {
                    setIsCancellingIndex(true)
                    plugin.cancelRagIndex()
                  }}
                />
              ) : (
                <ObsidianButton
                  text={t('settings.rag.updateNow', '立即更新')}
                  disabled={knowledgeBases.length === 0}
                  onClick={() => {
                    for (const kb of knowledgeBases) {
                      void runIndexJob(kb.id, 'sync', {
                        failureNotice: t('notices.indexUpdateFailed'),
                      })
                    }
                  }}
                />
              )}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  className="yolo-kb-status-menu-trigger"
                  aria-label={t('common.configure', 'Configure')}
                >
                  <span
                    className="yolo-agent-card-menu-trigger-dots"
                    aria-hidden="true"
                  >
                    ...
                  </span>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal container={portalContainer}>
                  <DropdownMenu.Content
                    className="yolo-agent-card-menu-popover yolo-kb-menu-popover"
                    align="end"
                    sideOffset={6}
                  >
                    <ul className="yolo-agent-card-menu-list">
                      <DropdownMenu.Item
                        asChild
                        onSelect={() => {
                          for (const kb of knowledgeBases) {
                            void runIndexJob(kb.id, 'rebuild', {
                              successNotice: t('notices.rebuildComplete'),
                              failureNotice: t('notices.rebuildFailed'),
                            })
                          }
                        }}
                      >
                        <li className="yolo-agent-card-menu-item">
                          <span className="yolo-agent-card-menu-icon">
                            <RefreshCw size={14} />
                          </span>
                          {t(
                            'settings.knowledgeBases.rebuildAll',
                            '重建全部索引',
                          )}
                        </li>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        asChild
                        onSelect={() =>
                          new EmbeddingDbManageModal(app, plugin).open()
                        }
                      >
                        <li className="yolo-agent-card-menu-item">
                          <span className="yolo-agent-card-menu-icon">
                            <Database size={14} />
                          </span>
                          {t('settings.rag.manage', '管理索引数据…')}
                        </li>
                      </DropdownMenu.Item>
                      <li
                        className="yolo-agent-card-menu-sep"
                        aria-hidden="true"
                      />
                      <DropdownMenu.Item
                        asChild
                        onSelect={() => {
                          plugin.cancelRagIndex()
                          applySettingsUpdate({
                            ...settings,
                            ragOptions: {
                              ...settings.ragOptions,
                              enabled: false,
                            },
                          })
                        }}
                      >
                        <li className="yolo-agent-card-menu-item yolo-agent-card-menu-danger">
                          <span className="yolo-agent-card-menu-icon">
                            <Ban size={14} />
                          </span>
                          {t(
                            'settings.knowledgeBases.disable',
                            '关闭知识库索引',
                          )}
                        </li>
                      </DropdownMenu.Item>
                    </ul>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </>
          )}
        </div>
      </div>

      <div className="yolo-kb-content">
        <div className={!isRagEnabled ? 'yolo-kb-dimmed' : undefined}>
          <div className="yolo-kb-divider-label yolo-kb-divider-label--with-action">
            <span className="yolo-kb-divider-label-text">
              {t('settings.knowledgeBases.title', '知识库')}
            </span>
            <span className="yolo-kb-divider-label-line" aria-hidden="true" />
            <ObsidianButton
              text={t('settings.knowledgeBases.new', '新建知识库')}
              cta
              className="yolo-kb-new-button"
              onClick={() => handleOpenKbModal()}
            />
          </div>

          <div className="yolo-kb-grid">
            {knowledgeBases.map((kb) => {
              const data = kbData[kb.id] ?? EMPTY_KB_DATA
              const run = indexSnapshot.runs[kb.id]
              const isThisIndexing = activeKbId === kb.id
              const isQueued = indexSnapshot.queuedKbIds.includes(kb.id)
              const rules = rulesFromWorkspaceScope(kb)
              const pathKind = (path: string) =>
                resolveScopePathKind(plugin.app.vault, path)
              const isNeedsAttention =
                !isThisIndexing &&
                (run?.status === 'failed' || run?.status === 'retry_scheduled')
              const lastUpdatedAt =
                run?.status === 'completed'
                  ? (run.updatedAt ?? undefined)
                  : undefined

              return (
                <article
                  key={kb.id}
                  className={`yolo-agent-card yolo-agent-card--clickable yolo-kb-card${isThisIndexing ? ' is-indexing' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleOpenKbModal(kb.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      handleOpenKbModal(kb.id)
                    }
                  }}
                >
                  {isThisIndexing && (
                    <div className="yolo-kb-card-ring">
                      <IndexProgressRing percent={ringPercentFor(run, true)} />
                    </div>
                  )}
                  <div className="yolo-kb-card-top">
                    <div className="yolo-kb-card-head">
                      <span className="yolo-kb-card-icon">
                        <Database size={16} />
                      </span>
                      <div className="yolo-kb-card-title">
                        <div className="yolo-kb-card-name">
                          {kb.name}
                          <span
                            className={`yolo-kb-status-pill${
                              isThisIndexing
                                ? ' blue'
                                : isQueued
                                  ? ' blue'
                                  : isNeedsAttention
                                    ? ' red'
                                    : data.pendingChanged > 0
                                      ? ' amber'
                                      : ' green'
                            }`}
                          >
                            {isThisIndexing
                              ? t(
                                  'settings.knowledgeBases.stateIndexing',
                                  '索引中',
                                )
                              : isQueued
                                ? t(
                                    'settings.knowledgeBases.stateQueued',
                                    '排队中',
                                  )
                                : isNeedsAttention
                                  ? t(
                                      'settings.knowledgeBases.stateAttention',
                                      '需要关注',
                                    )
                                  : data.pendingChanged > 0
                                    ? t(
                                        'settings.knowledgeBases.statePending',
                                        '待更新',
                                      )
                                    : t(
                                        'settings.knowledgeBases.stateReady',
                                        '已就绪',
                                      )}
                          </span>
                        </div>
                        {kb.description && (
                          <div className="yolo-kb-card-desc">
                            {kb.description}
                          </div>
                        )}
                      </div>
                      {!isThisIndexing && (
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger
                            className="yolo-agent-card-menu-trigger"
                            aria-label={t('common.configure', 'Configure')}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <span
                              className="yolo-agent-card-menu-trigger-dots"
                              aria-hidden="true"
                            >
                              ...
                            </span>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal container={portalContainer}>
                            <DropdownMenu.Content
                              className="yolo-agent-card-menu-popover yolo-kb-menu-popover"
                              align="end"
                              sideOffset={6}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <ul className="yolo-agent-card-menu-list">
                                <DropdownMenu.Item
                                  asChild
                                  onSelect={() => {
                                    void runIndexJob(kb.id, 'rebuild', {
                                      successNotice: t(
                                        'notices.rebuildComplete',
                                      ),
                                      failureNotice: t('notices.rebuildFailed'),
                                    })
                                  }}
                                >
                                  <li className="yolo-agent-card-menu-item">
                                    <span className="yolo-agent-card-menu-icon">
                                      <Pickaxe size={14} />
                                    </span>
                                    {t(
                                      'settings.knowledgeBases.rebuildThis',
                                      '重建此库',
                                    )}
                                  </li>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                  asChild
                                  onSelect={() => handleDeleteKb(kb)}
                                >
                                  <li className="yolo-agent-card-menu-item yolo-agent-card-menu-danger">
                                    <span className="yolo-agent-card-menu-icon">
                                      <Trash2 size={14} />
                                    </span>
                                    {t(
                                      'settings.knowledgeBases.delete',
                                      '删除知识库',
                                    )}
                                  </li>
                                </DropdownMenu.Item>
                              </ul>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      )}
                    </div>
                    <div className="yolo-kb-card-meta">
                      <span className="yolo-kb-card-meta-item">
                        <Layers size={13} aria-hidden="true" />
                        <CardScopeCaption
                          labels={includeScopeLabels(rules, pathKind)}
                          excludeCount={
                            describeScope(rules, pathKind).exclude.total
                          }
                          t={t}
                        />
                      </span>
                      {data.pendingChanged > 0 && (
                        <span className="yolo-kb-card-meta-item yolo-kb-card-meta-attn">
                          {t(
                            'settings.knowledgeBases.pendingFiles',
                            '{{n}} 个文件已修改',
                          ).replace('{{n}}', String(data.pendingChanged))}
                        </span>
                      )}
                      {lastUpdatedAt !== undefined && (
                        <span className="yolo-kb-card-meta-item">
                          <Clock size={13} aria-hidden="true" />
                          {formatUpdatedAgo(lastUpdatedAt, t)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="yolo-kb-card-foot">
                    <div className="yolo-kb-card-nums">
                      <div className="yolo-kb-card-num">
                        <b>
                          <AnimatedNumber
                            value={data.docCount}
                            format={(n) => String(Math.round(n))}
                          />
                        </b>
                        <span>{t('settings.knowledgeBases.docs', '文档')}</span>
                      </div>
                      <div className="yolo-kb-card-num">
                        <b>
                          <AnimatedNumber
                            value={data.chunkCount}
                            format={(n) => String(Math.round(n))}
                          />
                        </b>
                        <span>
                          {t('settings.knowledgeBases.chunks', '向量块')}
                        </span>
                      </div>
                      <div className="yolo-kb-card-num">
                        <b>
                          <AnimatedNumber
                            value={data.estimateMb}
                            format={(n) => n.toFixed(1)}
                          />
                        </b>
                        <span>MB</span>
                      </div>
                    </div>
                  </div>
                </article>
              )
            })}
            <article
              className="yolo-agent-create-card"
              role="button"
              tabIndex={0}
              onClick={() => handleOpenKbModal()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  handleOpenKbModal()
                }
              }}
            >
              <div className="yolo-agent-create-card-icon">
                <Plus size={28} />
              </div>
              <div className="yolo-agent-create-card-text">
                {t('settings.knowledgeBases.new', '新建知识库')}
              </div>
            </article>
          </div>
        </div>

        {/* Embedding model shelf: the API row below only selects among
              already-configured API embedding models — provider/key setup
              stays on the Models tab. The "本地" group right after it is
              `LocalEmbeddingShelf`, a curated download list with its own
              per-model lifecycle; local embedding models are deliberately
              not a normal Provider entry (no API key/base URL), see
              docs/plans/08-22-local-embedding/00-plan.md §3.5-§3.7. */}
        <div className="yolo-kb-divider-label yolo-kb-divider-label--sub">
          {t('settings.knowledgeBases.embeddingModelShelf', '嵌入模型')}
          <span className="yolo-kb-divider-label-faint">
            {t(
              'settings.knowledgeBases.embeddingModelShelfDesc',
              '所有知识库共用 · 更换需重建索引',
            )}
          </span>
        </div>
        <div className="yolo-kb-model-list">
          <div
            className={`yolo-kb-ml-row${
              currentEmbeddingModel &&
              currentEmbeddingModel.providerId !== LOCAL_EMBEDDING_PROVIDER_ID
                ? ' is-current'
                : ''
            }`}
          >
            <div className="yolo-kb-ml-main">
              <div className="yolo-kb-ml-name is-plain">
                {t('settings.knowledgeBases.embeddingModelApiRow', 'API 模型')}
                <ObsidianDropdown
                  value={pendingEmbeddingModelId}
                  groupedOptions={embeddingModelOptionGroups}
                  onChange={setPendingEmbeddingModelId}
                />
              </div>
              <div className="yolo-kb-ml-meta">
                {t(
                  'settings.knowledgeBases.embeddingModelApiRowMeta',
                  '{{dimension}} 维 · 按 token 计费 · 密钥与自定义模型在「模型」标签页管理',
                ).replace(
                  '{{dimension}}',
                  String(
                    settings.embeddingModels.find(
                      (m) => m.id === pendingEmbeddingModelId,
                    )?.dimension ?? '—',
                  ),
                )}
              </div>
            </div>
            <div className="yolo-kb-ml-side">
              <ObsidianButton
                text={t('settings.knowledgeBases.setAsCurrent', '设为当前')}
                className="yolo-kb-ml-ghost"
                disabled={
                  !pendingEmbeddingModelId ||
                  pendingEmbeddingModelId === settings.embeddingModelId
                }
                onClick={() =>
                  applySettingsUpdate({
                    ...settings,
                    embeddingModelId: pendingEmbeddingModelId,
                  })
                }
              />
            </div>
          </div>
          <LocalEmbeddingShelf plugin={plugin} />
        </div>

        <section className="yolo-rag-card">
          <div
            className={`yolo-settings-advanced-toggle yolo-clickable${
              showAdvancedRagSettings ? ' is-expanded' : ''
            }`}
            onClick={() => setShowAdvancedRagSettings((prev) => !prev)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setShowAdvancedRagSettings((prev) => !prev)
              }
            }}
          >
            <span className="yolo-settings-advanced-toggle-icon">▶</span>
            {t('settings.rag.advanced', '高级设置')}
          </div>

          {showAdvancedRagSettings && (
            <>
              <ObsidianSetting
                name={t('settings.rag.indexPdf', '索引 PDF')}
                desc={t(
                  'settings.rag.indexPdfDesc',
                  '为知识库提取并索引 PDF 文本；首次全库重建可能较慢。大型仓库若不需要可关闭。',
                )}
                className="yolo-settings-card"
              >
                <ObsidianToggle
                  value={isIndexPdfEnabled}
                  onChange={(value) =>
                    applySettingsUpdate({
                      ...settings,
                      ragOptions: { ...settings.ragOptions, indexPdf: value },
                    })
                  }
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.rag.chunkSize')}
                desc={t('settings.rag.chunkSizeDesc')}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={chunkSizeInput}
                  placeholder="1000"
                  onChange={(value) => {
                    setChunkSizeInput(value)
                    const chunkSize = parseIntegerInput(value)
                    if (chunkSize !== null) {
                      applySettingsUpdate({
                        ...settings,
                        ragOptions: { ...settings.ragOptions, chunkSize },
                      })
                    }
                  }}
                  onBlur={() => {
                    if (parseIntegerInput(chunkSizeInput) === null) {
                      setChunkSizeInput(String(settings.ragOptions.chunkSize))
                    }
                  }}
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.rag.minSimilarity')}
                desc={t('settings.rag.minSimilarityDesc')}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={minSimilarityInput}
                  placeholder="0.0"
                  onChange={(value) => {
                    setMinSimilarityInput(value)
                    const minSimilarity = parseFloatInput(value)
                    if (minSimilarity !== null) {
                      applySettingsUpdate({
                        ...settings,
                        ragOptions: { ...settings.ragOptions, minSimilarity },
                      })
                    }
                  }}
                  onBlur={() => {
                    if (parseFloatInput(minSimilarityInput) === null) {
                      setMinSimilarityInput(
                        String(settings.ragOptions.minSimilarity),
                      )
                    }
                  }}
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.rag.limit')}
                desc={t('settings.rag.limitDesc')}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={limitInput}
                  placeholder="10"
                  onChange={(value) => {
                    setLimitInput(value)
                    const limit = parseIntegerInput(value)
                    if (limit !== null) {
                      applySettingsUpdate({
                        ...settings,
                        ragOptions: { ...settings.ragOptions, limit },
                      })
                    }
                  }}
                  onBlur={() => {
                    if (parseIntegerInput(limitInput) === null) {
                      setLimitInput(String(settings.ragOptions.limit))
                    }
                  }}
                />
              </ObsidianSetting>

              <ObsidianSetting
                name={t('settings.rag.embeddingConcurrency')}
                desc={t('settings.rag.embeddingConcurrencyDesc')}
                className="yolo-settings-card"
              >
                <ObsidianTextInput
                  value={embeddingConcurrencyInput}
                  placeholder="10"
                  onChange={(value) => {
                    setEmbeddingConcurrencyInput(value)
                    const parsed = parseIntegerInput(value)
                    if (parsed !== null) {
                      const clamped = Math.max(1, Math.min(24, parsed))
                      applySettingsUpdate({
                        ...settings,
                        ragOptions: {
                          ...settings.ragOptions,
                          embeddingConcurrency: clamped,
                        },
                      })
                    }
                  }}
                  onBlur={() => {
                    const parsed = parseIntegerInput(embeddingConcurrencyInput)
                    if (parsed === null) {
                      setEmbeddingConcurrencyInput(
                        String(settings.ragOptions.embeddingConcurrency ?? 10),
                      )
                      return
                    }
                    const clamped = Math.max(1, Math.min(24, parsed))
                    if (clamped !== parsed) {
                      setEmbeddingConcurrencyInput(String(clamped))
                    }
                  }}
                />
              </ObsidianSetting>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
