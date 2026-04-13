import { App } from 'obsidian'

import { IndexProgress } from '../../components/chat-view/QueryProgress'
import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'

import { classifyRagIndexError, type RagIndexFailureKind } from './ragIndexErrors'
import { RAGEngine } from './ragEngine'

type AppWithLocalStorage = App & {
  loadLocalStorage?: (key: string) => string | null | Promise<string | null>
  saveLocalStorage?: (key: string, value: string) => void | Promise<void>
}

export type RagIndexRunStatus =
  | 'idle'
  | 'running'
  | 'retry_scheduled'
  | 'failed'
  | 'completed'

export type RagIndexRunTrigger = 'manual' | 'auto'

export type RagIndexRunSnapshot = {
  runId: string | null
  trigger: RagIndexRunTrigger | null
  mode: 'full' | 'incremental' | null
  status: RagIndexRunStatus
  startedAt: number | null
  updatedAt: number | null
  currentFile?: string
  lastCompletedFile?: string
  totalFiles?: number
  completedFiles?: number
  totalChunks?: number
  completedChunks?: number
  waitingForRateLimit?: boolean
  retryCount: number
  retryAt?: number
  failureKind?: RagIndexFailureKind
  failureMessage?: string
}

type RagIndexServiceDeps = {
  app: App
  getRagEngine: () => Promise<RAGEngine>
  activityRegistry: BackgroundActivityRegistry
  t: (key: string, fallback?: string) => string
}

type RagIndexSubscriber = (snapshot: RagIndexRunSnapshot) => void

const STORAGE_KEY = 'smtcmp_rag_index_run'
const RETRY_ACTIVITY_ID = 'rag:index'

const isPromiseLike = <T,>(value: T | Promise<T>): value is Promise<T> =>
  typeof value === 'object' &&
  value !== null &&
  'then' in (value as Record<string, unknown>) &&
  typeof (value as { then?: unknown }).then === 'function'

const defaultSnapshot = (): RagIndexRunSnapshot => ({
  runId: null,
  trigger: null,
  mode: null,
  status: 'idle',
  startedAt: null,
  updatedAt: null,
  retryCount: 0,
})

const createRunId = (): string =>
  `rag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const readLocalStorage = async (app: App, key: string): Promise<string | null> => {
  const appWithLocalStorage = app as AppWithLocalStorage
  if (typeof appWithLocalStorage.loadLocalStorage !== 'function') {
    return null
  }
  const result = appWithLocalStorage.loadLocalStorage(key)
  return isPromiseLike(result) ? await result : result
}

const writeLocalStorage = async (
  app: App,
  key: string,
  value: string,
): Promise<void> => {
  const appWithLocalStorage = app as AppWithLocalStorage
  if (typeof appWithLocalStorage.saveLocalStorage !== 'function') {
    return
  }
  const result = appWithLocalStorage.saveLocalStorage(key, value)
  if (isPromiseLike(result)) {
    await result
  }
}

export class RagIndexBusyError extends Error {
  constructor() {
    super('RAG index is already running.')
    this.name = 'RagIndexBusyError'
  }
}

export class RagIndexService {
  private readonly app: App
  private readonly getRagEngine: () => Promise<RAGEngine>
  private readonly activityRegistry: BackgroundActivityRegistry
  private readonly t: (key: string, fallback?: string) => string

  private snapshot: RagIndexRunSnapshot = defaultSnapshot()
  private readonly subscribers = new Set<RagIndexSubscriber>()
  private currentAbortController: AbortController | null = null
  private initPromise: Promise<void> | null = null

  constructor(deps: RagIndexServiceDeps) {
    this.app = deps.app
    this.getRagEngine = deps.getRagEngine
    this.activityRegistry = deps.activityRegistry
    this.t = deps.t
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const raw = await readLocalStorage(this.app, STORAGE_KEY)
        if (!raw) {
          return
        }
        try {
          const parsed = JSON.parse(raw) as Partial<RagIndexRunSnapshot>
          this.snapshot = {
            ...defaultSnapshot(),
            ...parsed,
          }
          if (this.snapshot.status === 'running') {
            this.snapshot = {
              ...this.snapshot,
              status: 'failed',
              failureKind: 'unknown',
              failureMessage: this.t(
                'settings.rag.previousRunInterrupted',
                '上次索引未正常完成。',
              ),
              updatedAt: Date.now(),
            }
            await this.persistSnapshot()
          }
          this.publishActivity()
          this.emit()
        } catch (error) {
          console.warn('[YOLO] Failed to restore RAG index state', error)
        }
      })()
    }
    await this.initPromise
  }

  subscribe(subscriber: RagIndexSubscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber({ ...this.snapshot })
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  getSnapshot(): RagIndexRunSnapshot {
    return { ...this.snapshot }
  }

  isRunning(): boolean {
    return this.snapshot.status === 'running'
  }

  cancelActiveRun(): void {
    this.currentAbortController?.abort()
  }

  async runIndex(options: {
    reindexAll: boolean
    trigger: RagIndexRunTrigger
    onProgress?: (progress: IndexProgress) => void
  }): Promise<void> {
    await this.initialize()
    if (this.currentAbortController) {
      throw new RagIndexBusyError()
    }

    const runId = createRunId()
    const controller = new AbortController()
    this.currentAbortController = controller

    const startedAt = Date.now()
    this.snapshot = {
      runId,
      trigger: options.trigger,
      mode: options.reindexAll ? 'full' : 'incremental',
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      retryCount:
        options.trigger === 'auto' && this.snapshot.trigger === 'auto'
          ? this.snapshot.retryCount
          : 0,
    }
    await this.persistSnapshot()

    try {
      const ragEngine = await this.getRagEngine()
      await ragEngine.updateVaultIndex(
        {
          reindexAll: options.reindexAll,
          signal: controller.signal,
          indexRunId: runId,
        },
        (queryProgress) => {
          if (queryProgress.type !== 'indexing') {
            return
          }
          const progress = queryProgress.indexProgress
          this.snapshot = {
            ...this.snapshot,
            updatedAt: Date.now(),
            currentFile: progress.currentFile,
            lastCompletedFile:
              (progress.completedFiles ?? 0) > 0
                ? progress.currentFile ?? this.snapshot.lastCompletedFile
                : this.snapshot.lastCompletedFile,
            totalFiles: progress.totalFiles,
            completedFiles: progress.completedFiles,
            totalChunks: progress.totalChunks,
            completedChunks: progress.completedChunks,
            waitingForRateLimit: progress.waitingForRateLimit,
          }
          void this.persistSnapshot()
          options.onProgress?.(progress)
        },
      )

      this.snapshot = {
        ...this.snapshot,
        status: 'completed',
        updatedAt: Date.now(),
        failureKind: undefined,
        failureMessage: undefined,
        retryAt: undefined,
        waitingForRateLimit: false,
      }
      await this.persistSnapshot()
    } catch (error) {
      const failureKind = classifyRagIndexError(error)
      this.snapshot = {
        ...this.snapshot,
        status: failureKind === 'aborted' ? 'idle' : 'failed',
        updatedAt: Date.now(),
        failureKind,
        failureMessage: error instanceof Error ? error.message : String(error),
        waitingForRateLimit: false,
      }
      await this.persistSnapshot()
      throw error
    } finally {
      this.currentAbortController = null
      this.publishActivity()
      this.emit()
    }
  }

  async markRetryScheduled(input: {
    reindexAll: boolean
    retryAt: number
    failureMessage?: string
  }): Promise<void> {
    await this.initialize()
    this.snapshot = {
      ...this.snapshot,
      mode: input.reindexAll ? 'full' : 'incremental',
      trigger: 'auto',
      status: 'retry_scheduled',
      retryAt: input.retryAt,
      updatedAt: Date.now(),
      failureKind: 'transient',
      failureMessage: input.failureMessage,
      retryCount: this.snapshot.retryCount + 1,
    }
    await this.persistSnapshot()
  }

  async clearRetryScheduled(): Promise<void> {
    await this.initialize()
    if (this.snapshot.status !== 'retry_scheduled') {
      return
    }
    this.snapshot = {
      ...this.snapshot,
      status: 'idle',
      updatedAt: Date.now(),
      retryAt: undefined,
      failureKind: undefined,
      failureMessage: undefined,
      waitingForRateLimit: false,
    }
    await this.persistSnapshot()
  }

  cleanup(): void {
    this.currentAbortController?.abort()
    this.currentAbortController = null
    this.subscribers.clear()
    this.activityRegistry.remove(RETRY_ACTIVITY_ID)
  }

  private async persistSnapshot(): Promise<void> {
    await writeLocalStorage(this.app, STORAGE_KEY, JSON.stringify(this.snapshot))
    this.publishActivity()
    this.emit()
  }

  private publishActivity(): void {
    if (
      this.snapshot.status === 'idle' ||
      this.snapshot.status === 'completed'
    ) {
      this.activityRegistry.remove(RETRY_ACTIVITY_ID)
      return
    }

    const title = this.buildActivityTitle()
    const detail = this.buildActivityDetail()
    this.activityRegistry.upsert({
      id: RETRY_ACTIVITY_ID,
      kind: 'rag-index',
      title,
      detail,
      status:
        this.snapshot.status === 'retry_scheduled'
          ? 'waiting'
          : this.snapshot.status === 'failed'
            ? 'failed'
            : 'running',
      updatedAt: Date.now(),
      action: { type: 'open-knowledge-settings' },
    })
  }

  private buildActivityTitle(): string {
    if (this.snapshot.status === 'retry_scheduled') {
      return this.t('statusBar.ragAutoUpdateRunning', '知识库等待重试')
    }
    if (this.snapshot.status === 'failed') {
      return this.t('statusBar.ragAutoUpdateFailed', '知识库索引失败')
    }
    if (this.snapshot.mode === 'full') {
      return this.t('notices.rebuildingIndex', '正在重建知识库索引')
    }
    return this.t('statusBar.ragAutoUpdateRunning', '知识库正在后台更新')
  }

  private buildActivityDetail(): string {
    if (this.snapshot.status === 'retry_scheduled') {
      const retryAtLabel = this.snapshot.retryAt
        ? new Date(this.snapshot.retryAt).toLocaleTimeString()
        : this.t('common.retry', '重试')
      return this.snapshot.failureMessage
        ? `${this.snapshot.failureMessage} · ${retryAtLabel}`
        : retryAtLabel
    }
    if (this.snapshot.status === 'failed') {
      return (
        this.snapshot.failureMessage ??
        this.t(
          'statusBar.ragAutoUpdateFailedDetail',
          '最近一次后台同步失败，请稍后重试。',
        )
      )
    }
    if (this.snapshot.waitingForRateLimit) {
      return this.t(
        'settings.rag.waitingRateLimit',
        'Waiting for rate limit to reset...',
      )
    }
    if (this.snapshot.currentFile) {
      return this.snapshot.currentFile
    }
    return this.t(
      'statusBar.ragAutoUpdateRunningDetail',
      '正在增量同步知识库索引。',
    )
  }

  private emit(): void {
    const snapshot = { ...this.snapshot }
    for (const subscriber of this.subscribers) {
      subscriber(snapshot)
    }
  }
}
