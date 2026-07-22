import type { LearningVaultReadApi } from '../learningVaultReadApi'
import { isPathUnderLearningBase } from '../projectScanner'
import type { Project } from '../types'

import {
  type LearningProjectStats,
  loadLearningProjectStats,
} from './learningStats'
import type {
  LearningLifecyclePorts,
  LearningProjectSourcePort,
  LearningStatsSrsPort,
  LearningTimerHandle,
} from './ports'

const VAULT_REFRESH_DEBOUNCE_MS = 200
const MAX_TIMER_DELAY_MS = 2_147_000_000

export type LearningStatsSnapshot = {
  projects: readonly Project[]
  byProject: ReadonlyMap<string, LearningProjectStats>
  pausedProjectIds: ReadonlySet<string>
  failedProjectIds: ReadonlySet<string>
  loading: boolean
}

export type LearningStatsSubscriber = (snapshot: LearningStatsSnapshot) => void

type LoadProjectStats = typeof loadLearningProjectStats

export type LearningStatsServiceOptions = {
  vault: LearningVaultReadApi
  projects: LearningProjectSourcePort
  srsStore: LearningStatsSrsPort
  lifecycle: LearningLifecyclePorts
  loadProjectStats?: LoadProjectStats
}

const createEmptySnapshot = (): LearningStatsSnapshot => ({
  projects: [],
  byProject: new Map(),
  pausedProjectIds: new Set(),
  failedProjectIds: new Set(),
  loading: true,
})

export function getTotalDueCards(snapshot: LearningStatsSnapshot): number {
  let total = 0
  for (const stats of snapshot.byProject.values()) {
    if (!stats.paused) total += stats.dueCards
  }
  return total
}

export class LearningStatsService {
  private readonly subscribers = new Set<LearningStatsSubscriber>()
  private readonly vault: LearningVaultReadApi
  private readonly projects: LearningProjectSourcePort
  private readonly srsStore: LearningStatsSrsPort
  private readonly lifecycle: LearningLifecyclePorts
  private readonly loadProjectStats: LoadProjectStats
  private snapshot = createEmptySnapshot()
  private started = false
  private disposed = false
  private generation = 0
  private operationQueue: Promise<void> = Promise.resolve()
  private cleanups: Array<() => void> = []
  private vaultRefreshTimer: LearningTimerHandle | null = null
  private nextDueTimer: LearningTimerHandle | null = null

  constructor({
    vault,
    projects,
    srsStore,
    lifecycle,
    loadProjectStats = loadLearningProjectStats,
  }: LearningStatsServiceOptions) {
    this.vault = vault
    this.projects = projects
    this.srsStore = srsStore
    this.lifecycle = lifecycle
    this.loadProjectStats = loadProjectStats
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
      const now = this.lifecycle.clock.now()
      let projects: readonly Project[]
      try {
        projects = (await this.projects.scanProjects()).projects
      } catch (error) {
        console.error('[YOLO] Failed to scan learning projects:', error)
        if (!this.isCurrent(generation)) return
        this.publish({
          projects: this.snapshot.projects,
          byProject: new Map(),
          pausedProjectIds: this.snapshot.pausedProjectIds,
          failedProjectIds: new Set(
            this.snapshot.projects.map((project) => project.id),
          ),
          loading: false,
        })
        return
      }

      const [results, pausedResults] = await Promise.all([
        Promise.allSettled(
          projects.map(async (project) => ({
            projectId: project.id,
            stats: await this.loadProjectStats({
              vault: this.vault,
              project,
              srsStore: this.srsStore,
              now,
            }),
          })),
        ),
        Promise.allSettled(
          projects.map(async (project) => ({
            projectId: project.id,
            paused: await this.srsStore.isProjectPaused(project.slug),
          })),
        ),
      ])
      if (!this.isCurrent(generation)) return

      const byProject = new Map<string, LearningProjectStats>()
      const pausedProjectIds = new Set<string>()
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
      pausedResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          if (result.value.paused) pausedProjectIds.add(result.value.projectId)
          return
        }
        if (this.snapshot.pausedProjectIds.has(projects[index].id)) {
          pausedProjectIds.add(projects[index].id)
        }
        console.error(
          `[YOLO] Failed to load learning pause state for ${projects[index].slug}:`,
          result.reason,
        )
      })
      this.publish({
        projects,
        byProject,
        pausedProjectIds,
        failedProjectIds,
        loading: false,
      })
    })
  }

  refreshProject(projectSlug: string): Promise<LearningStatsSnapshot> {
    if (!this.started && !this.disposed) this.activate()
    if (
      !this.snapshot.projects.some((project) => project.slug === projectSlug)
    ) {
      return this.refreshAll()
    }

    const generation = this.generation
    return this.enqueue(async () => {
      if (!this.isCurrent(generation)) return
      const project = this.snapshot.projects.find(
        (item) => item.slug === projectSlug,
      )
      if (!project) return

      const byProject = new Map(this.snapshot.byProject)
      const pausedProjectIds = new Set(this.snapshot.pausedProjectIds)
      const failedProjectIds = new Set(this.snapshot.failedProjectIds)
      const [statsResult, pausedResult] = await Promise.allSettled([
        this.loadProjectStats({
          vault: this.vault,
          project,
          srsStore: this.srsStore,
          now: this.lifecycle.clock.now(),
        }),
        this.srsStore.isProjectPaused(project.slug),
      ])
      if (!this.isCurrent(generation)) return
      if (statsResult.status === 'fulfilled') {
        byProject.set(project.id, statsResult.value)
        failedProjectIds.delete(project.id)
      } else {
        byProject.delete(project.id)
        failedProjectIds.add(project.id)
        console.error(
          `[YOLO] Failed to refresh learning statistics for ${project.slug}:`,
          statsResult.reason,
        )
      }
      if (pausedResult.status === 'fulfilled') {
        if (pausedResult.value) pausedProjectIds.add(project.id)
        else pausedProjectIds.delete(project.id)
      } else {
        console.error(
          `[YOLO] Failed to refresh learning pause state for ${project.slug}:`,
          pausedResult.reason,
        )
      }
      this.publish({
        projects: this.snapshot.projects,
        byProject,
        pausedProjectIds,
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
    const baseDir = this.projects.getLearningBaseDir()
    const refreshIfLearningPath = (file: { path: string }) => {
      if (isPathUnderLearningBase(file.path, baseDir)) {
        this.scheduleVaultRefresh()
      }
    }
    this.cleanups = [
      this.vault.onCreate(baseDir, refreshIfLearningPath),
      this.vault.onModify(baseDir, refreshIfLearningPath),
      this.vault.onDelete(baseDir, refreshIfLearningPath),
      this.vault.onRename(baseDir, (file, oldPath) => {
        if (
          isPathUnderLearningBase(file.path, baseDir) ||
          isPathUnderLearningBase(oldPath, baseDir)
        ) {
          this.scheduleVaultRefresh()
        }
      }),
      this.srsStore.subscribe(({ projectSlug }) => {
        void this.refreshProject(projectSlug)
      }),
      this.lifecycle.focus.subscribeFocus(() => {
        void this.refreshAll()
      }),
      this.lifecycle.visibility.subscribeVisible(() => {
        void this.refreshAll()
      }),
    ]
  }

  private deactivate(): void {
    this.started = false
    this.generation += 1
    this.operationQueue = Promise.resolve()
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
    this.clearTimers()
  }

  private scheduleVaultRefresh(): void {
    if (this.vaultRefreshTimer !== null) {
      this.lifecycle.clock.clearTimeout(this.vaultRefreshTimer)
    }
    this.vaultRefreshTimer = this.lifecycle.clock.setTimeout(() => {
      this.vaultRefreshTimer = null
      void this.refreshAll()
    }, VAULT_REFRESH_DEBOUNCE_MS)
  }

  private scheduleNextDueRefresh(): void {
    if (this.nextDueTimer !== null) {
      this.lifecycle.clock.clearTimeout(this.nextDueTimer)
    }
    this.nextDueTimer = null
    const now = this.lifecycle.clock.now().getTime()
    let nextDueAt: number | null = null
    for (const stats of this.snapshot.byProject.values()) {
      if (stats.paused) continue
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
    this.nextDueTimer = this.lifecycle.clock.setTimeout(() => {
      this.nextDueTimer = null
      void this.refreshAll()
    }, delay)
  }

  private clearTimers(): void {
    if (this.vaultRefreshTimer !== null) {
      this.lifecycle.clock.clearTimeout(this.vaultRefreshTimer)
    }
    if (this.nextDueTimer !== null) {
      this.lifecycle.clock.clearTimeout(this.nextDueTimer)
    }
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
