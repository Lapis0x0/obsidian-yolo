import type { App, EventRef, TAbstractFile } from 'obsidian'

import {
  type LearningProjectStats,
  loadLearningProjectStats,
} from './learningStats'
import { isPathUnderLearningBase, scanProjects } from './projectScanner'
import type { LearningSrsStore } from './srs/srsStore'
import type { Project } from './types'

const VAULT_REFRESH_DEBOUNCE_MS = 200
const MAX_TIMER_DELAY_MS = 2_147_000_000

export type LearningStatsSnapshot = {
  projects: readonly Project[]
  byProject: ReadonlyMap<string, LearningProjectStats>
  failedProjectIds: ReadonlySet<string>
  loading: boolean
}

type LearningStatsSubscriber = (snapshot: LearningStatsSnapshot) => void

type LearningStatsServiceOptions = {
  app: App
  getLearningBaseDir: () => string
  srsStore: LearningSrsStore
  scan?: typeof scanProjects
  loadProjectStats?: typeof loadLearningProjectStats
  now?: () => Date
}

const createEmptySnapshot = (): LearningStatsSnapshot => ({
  projects: [],
  byProject: new Map(),
  failedProjectIds: new Set(),
  loading: true,
})

export function getTotalDueCards(snapshot: LearningStatsSnapshot): number {
  let total = 0
  for (const stats of snapshot.byProject.values()) total += stats.dueCards
  return total
}

export class LearningStatsService {
  private readonly app: App
  private readonly getLearningBaseDir: () => string
  private readonly srsStore: LearningSrsStore
  private readonly scan: typeof scanProjects
  private readonly loadProjectStats: typeof loadLearningProjectStats
  private readonly now: () => Date
  private readonly subscribers = new Set<LearningStatsSubscriber>()
  private snapshot = createEmptySnapshot()
  private started = false
  private disposed = false
  private generation = 0
  private operationQueue: Promise<void> = Promise.resolve()
  private vaultRefs: EventRef[] = []
  private unsubscribeSrs: (() => void) | null = null
  private vaultRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private nextDueTimer: ReturnType<typeof setTimeout> | null = null

  constructor({
    app,
    getLearningBaseDir,
    srsStore,
    scan = scanProjects,
    loadProjectStats = loadLearningProjectStats,
    now = () => new Date(),
  }: LearningStatsServiceOptions) {
    this.app = app
    this.getLearningBaseDir = getLearningBaseDir
    this.srsStore = srsStore
    this.scan = scan
    this.loadProjectStats = loadProjectStats
    this.now = now
  }

  getSnapshot(): LearningStatsSnapshot {
    return this.snapshot
  }

  subscribe(subscriber: LearningStatsSubscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber(this.snapshot)
    return () => this.subscribers.delete(subscriber)
  }

  start(): void {
    if (this.started || this.disposed) return
    this.activate()
    void this.refreshAll()
  }

  restart(): void {
    if (this.disposed) return
    this.deactivate()
    this.snapshot = createEmptySnapshot()
    this.emit()
    this.activate()
    void this.refreshAll()
  }

  refreshAll(): Promise<LearningStatsSnapshot> {
    if (!this.started && !this.disposed) this.activate()
    const generation = this.generation
    return this.enqueue(async () => {
      if (!this.isCurrent(generation)) return
      const now = this.now()
      let projects: readonly Project[]
      try {
        projects = (await this.scan(this.app, this.getLearningBaseDir()))
          .projects
      } catch (error) {
        console.error('[YOLO] Failed to scan learning projects:', error)
        if (!this.isCurrent(generation)) return
        this.publish({
          projects: this.snapshot.projects,
          byProject: new Map(),
          failedProjectIds: new Set(
            this.snapshot.projects.map((project) => project.id),
          ),
          loading: false,
        })
        return
      }

      const results = await Promise.allSettled(
        projects.map(async (project) => ({
          projectId: project.id,
          stats: await this.loadProjectStats({
            app: this.app,
            project,
            srsStore: this.srsStore,
            now,
          }),
        })),
      )
      if (!this.isCurrent(generation)) return

      const byProject = new Map<string, LearningProjectStats>()
      const failedProjectIds = new Set<string>()
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          byProject.set(result.value.projectId, result.value.stats)
        } else {
          failedProjectIds.add(projects[index].id)
          console.error(
            `[YOLO] Failed to load learning statistics for ${projects[index].slug}:`,
            result.reason,
          )
        }
      })
      this.publish({ projects, byProject, failedProjectIds, loading: false })
    })
  }

  refreshProject(projectSlug: string): Promise<LearningStatsSnapshot> {
    if (!this.started && !this.disposed) this.activate()
    const knownProject = this.snapshot.projects.find(
      (project) => project.slug === projectSlug,
    )
    if (!knownProject) return this.refreshAll()

    const generation = this.generation
    return this.enqueue(async () => {
      if (!this.isCurrent(generation)) return
      const project = this.snapshot.projects.find(
        (item) => item.slug === projectSlug,
      )
      if (!project) return

      const byProject = new Map(this.snapshot.byProject)
      const failedProjectIds = new Set(this.snapshot.failedProjectIds)
      try {
        const stats = await this.loadProjectStats({
          app: this.app,
          project,
          srsStore: this.srsStore,
          now: this.now(),
        })
        if (!this.isCurrent(generation)) return
        byProject.set(project.id, stats)
        failedProjectIds.delete(project.id)
      } catch (error) {
        if (!this.isCurrent(generation)) return
        byProject.delete(project.id)
        failedProjectIds.add(project.id)
        console.error(
          `[YOLO] Failed to refresh learning statistics for ${project.slug}:`,
          error,
        )
      }
      this.publish({
        projects: this.snapshot.projects,
        byProject,
        failedProjectIds,
        loading: false,
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.deactivate()
    this.subscribers.clear()
  }

  private activate(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.generation += 1
    const baseDir = this.getLearningBaseDir()
    const refreshIfLearningPath = (file: TAbstractFile) => {
      if (isPathUnderLearningBase(file.path, baseDir)) {
        this.scheduleVaultRefresh()
      }
    }
    this.vaultRefs = [
      this.app.vault.on('create', refreshIfLearningPath),
      this.app.vault.on('modify', refreshIfLearningPath),
      this.app.vault.on('delete', refreshIfLearningPath),
      this.app.vault.on('rename', (file, oldPath) => {
        if (
          isPathUnderLearningBase(file.path, baseDir) ||
          isPathUnderLearningBase(oldPath, baseDir)
        ) {
          this.scheduleVaultRefresh()
        }
      }),
    ]
    this.unsubscribeSrs = this.srsStore.subscribe(({ projectSlug }) => {
      void this.refreshProject(projectSlug)
    })
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.handleFocus)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
  }

  private deactivate(): void {
    this.started = false
    this.generation += 1
    this.operationQueue = Promise.resolve()
    for (const ref of this.vaultRefs) this.app.vault.offref(ref)
    this.vaultRefs = []
    this.unsubscribeSrs?.()
    this.unsubscribeSrs = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.handleFocus)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener(
        'visibilitychange',
        this.handleVisibilityChange,
      )
    }
    this.clearTimers()
  }

  private readonly handleFocus = () => {
    void this.refreshAll()
  }

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') void this.refreshAll()
  }

  private scheduleVaultRefresh(): void {
    if (this.vaultRefreshTimer !== null) {
      clearTimeout(this.vaultRefreshTimer)
    }
    this.vaultRefreshTimer = setTimeout(() => {
      this.vaultRefreshTimer = null
      void this.refreshAll()
    }, VAULT_REFRESH_DEBOUNCE_MS)
  }

  private scheduleNextDueRefresh(): void {
    if (this.nextDueTimer !== null) clearTimeout(this.nextDueTimer)
    this.nextDueTimer = null
    const now = this.now().getTime()
    let nextDueAt: number | null = null
    for (const stats of this.snapshot.byProject.values()) {
      if (stats.nextDueAt === null || stats.nextDueAt <= now) continue
      if (nextDueAt === null || stats.nextDueAt < nextDueAt) {
        nextDueAt = stats.nextDueAt
      }
    }
    if (nextDueAt === null) return
    const delay = Math.min(
      Math.max(nextDueAt - now + 50, 1_000),
      MAX_TIMER_DELAY_MS,
    )
    this.nextDueTimer = setTimeout(() => {
      this.nextDueTimer = null
      void this.refreshAll()
    }, delay)
  }

  private clearTimers(): void {
    if (this.vaultRefreshTimer !== null) clearTimeout(this.vaultRefreshTimer)
    if (this.nextDueTimer !== null) clearTimeout(this.nextDueTimer)
    this.vaultRefreshTimer = null
    this.nextDueTimer = null
  }

  private publish(snapshot: LearningStatsSnapshot): void {
    this.snapshot = snapshot
    this.scheduleNextDueRefresh()
    this.emit()
  }

  private emit(): void {
    for (const subscriber of this.subscribers) subscriber(this.snapshot)
  }

  private isCurrent(generation: number): boolean {
    return this.started && !this.disposed && generation === this.generation
  }

  private enqueue(
    operation: () => Promise<void>,
  ): Promise<LearningStatsSnapshot> {
    const next = this.operationQueue.then(operation, operation)
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next.then(() => this.snapshot)
  }
}
