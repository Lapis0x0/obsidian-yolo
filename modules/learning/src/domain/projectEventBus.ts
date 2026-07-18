import type { LearningVaultReadApi } from './learningVaultReadApi'
import {
  isPathUnderLearningBase,
  scanProject,
  scanProjects,
} from './projectScanner'
import type {
  Chapter,
  KnowledgePoint,
  LearningEvent,
  OutlineProject,
  Relation,
} from './types'

type OutlineLearningEvent =
  | Exclude<LearningEvent, { type: 'project_initialized' }>
  | (Omit<
      Extract<LearningEvent, { type: 'project_initialized' }>,
      'snapshot'
    > & {
      snapshot: OutlineProject
    })

type OutlineLearningEventListener = (event: OutlineLearningEvent) => void

type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never

const DISPOSED_ERROR_MESSAGE = 'ProjectEventBus has been disposed'

export type SyntheticLearningEventInput = DistributiveOmit<
  OutlineLearningEvent,
  'sequence' | 'timestamp'
>

/** Watches one active outline project and emits snapshot-derived domain events. */
export class ProjectEventBus {
  private readonly listeners = new Set<OutlineLearningEventListener>()
  private snapshot: OutlineProject | null = null
  private sequence = 0
  private activeProjectPath: string | null = null
  private activeBaseDir: string | null = null
  private mockMode = false
  private pendingRefreshHandle: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private vaultEventCleanups: Array<() => void> = []
  private watchingVault = false
  private projectGeneration = 0
  private refreshQueue: Promise<void> = Promise.resolve()
  private refreshInFlight = false
  private trailingRefreshRequested = false

  constructor(private readonly vault: LearningVaultReadApi) {}

  getSnapshot(): OutlineProject | null {
    return this.snapshot
  }

  subscribe(listener: OutlineLearningEventListener): () => void {
    this.assertNotDisposed()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async setActiveProject(
    baseDir: string,
    projectFolderPath: string | null,
  ): Promise<void> {
    this.assertNotDisposed()
    const baseChanged = this.activeBaseDir !== baseDir
    const replacementCleanups =
      this.watchingVault && baseChanged
        ? this.registerVaultWatchers(baseDir)
        : null
    const oldCleanups = replacementCleanups ? this.vaultEventCleanups : null
    const projectChanged = this.activeProjectPath !== projectFolderPath
    this.projectGeneration += 1
    this.activeBaseDir = baseDir
    this.activeProjectPath = projectFolderPath
    this.clearPendingRefresh()
    this.trailingRefreshRequested = false
    if (projectChanged) this.snapshot = null
    let cleanupErrors: unknown[] = []
    if (replacementCleanups && oldCleanups) {
      this.vaultEventCleanups = replacementCleanups
      cleanupErrors = runCleanups(oldCleanups)
    }
    if (projectFolderPath) {
      await this.refreshSnapshot({ emitInitial: true })
    }
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
  }

  async refreshSnapshot({
    emitInitial,
  }: {
    emitInitial: boolean
  }): Promise<void> {
    this.assertNotDisposed()
    const projectPath = this.activeProjectPath
    const generation = this.projectGeneration
    if (!projectPath) return

    const refresh = this.refreshQueue.then(() =>
      this.performRefresh(projectPath, generation, emitInitial),
    )
    this.refreshQueue = refresh.catch(() => undefined)
    await refresh
  }

  private async performRefresh(
    projectPath: string,
    generation: number,
    emitInitial: boolean,
  ): Promise<void> {
    this.refreshInFlight = true
    try {
      if (!this.isCurrentProject(projectPath, generation)) return

      const folder = this.vault.getEntry(projectPath)
      if (folder?.kind !== 'folder') {
        if (this.isCurrentProject(projectPath, generation)) this.snapshot = null
        return
      }

      const next = await scanProject(this.vault, folder.path)
      if (!this.isCurrentProject(projectPath, generation)) return
      if (!next || next.kind !== 'outline') {
        this.snapshot = null
        return
      }

      if (emitInitial || this.snapshot === null) {
        this.snapshot = next
        this.emit({
          type: 'project_initialized',
          sequence: this.nextSequence(),
          timestamp: Date.now(),
          projectId: next.id,
          snapshot: next,
        })
        return
      }

      if (this.mockMode) {
        this.snapshot = next
        return
      }

      const events = diffProjects(this.snapshot, next, () => ({
        sequence: this.nextSequence(),
        timestamp: Date.now(),
      }))
      this.snapshot = next
      for (const event of events) this.emit(event)
    } finally {
      this.refreshInFlight = false
      this.startTrailingRefresh()
    }
  }

  /** Starts one set of scoped vault subscriptions, replacing any prior set. */
  startWatchingVault(): void {
    this.assertNotDisposed()
    const cleanups = this.registerVaultWatchers(this.activeBaseDir ?? '')
    const oldCleanups = this.vaultEventCleanups
    this.vaultEventCleanups = cleanups
    this.watchingVault = true
    const errors = runCleanups(oldCleanups)
    if (errors.length > 0) throw errors[0]
  }

  private registerVaultWatchers(scopePath: string): Array<() => void> {
    const handler = (entry: { path: string }) => {
      if (this.disposed || !this.activeBaseDir || !this.activeProjectPath)
        return
      if (!isPathUnderLearningBase(entry.path, this.activeBaseDir)) return
      if (
        entry.path !== this.activeProjectPath &&
        !entry.path.startsWith(`${this.activeProjectPath}/`)
      ) {
        return
      }
      this.scheduleRefresh()
    }

    const renameHandler = (entry: { path: string }, oldPath: string) => {
      if (this.disposed || !this.activeBaseDir || !this.activeProjectPath)
        return
      const oldUnder = isPathUnderLearningBase(oldPath, this.activeBaseDir)
      const newUnder = isPathUnderLearningBase(entry.path, this.activeBaseDir)
      if (!oldUnder && !newUnder) return
      if (
        !pathsIntersect(oldPath, this.activeProjectPath) &&
        !pathsIntersect(entry.path, this.activeProjectPath)
      ) {
        return
      }
      this.scheduleRefresh()
    }

    const registrations = [
      () => this.vault.onCreate(scopePath, handler),
      () => this.vault.onModify(scopePath, handler),
      () => this.vault.onDelete(scopePath, handler),
      () => this.vault.onRename(scopePath, renameHandler),
    ]
    const cleanups: Array<() => void> = []
    try {
      for (const register of registrations) cleanups.push(register())
    } catch (error) {
      runCleanups(cleanups)
      throw error
    }
    return cleanups
  }

  stopWatchingVault(): void {
    const cleanups = this.vaultEventCleanups
    this.vaultEventCleanups = []
    this.watchingVault = false
    const errors = runCleanups(cleanups)
    if (errors.length > 0) throw errors[0]
  }

  beginMockSession(): void {
    this.assertNotDisposed()
    this.mockMode = true
  }

  endMockSession(): void {
    this.assertNotDisposed()
    this.mockMode = false
  }

  emitSynthetic(event: SyntheticLearningEventInput): OutlineLearningEvent {
    this.assertNotDisposed()
    const enriched = {
      ...event,
      sequence: this.nextSequence(),
      timestamp: Date.now(),
    } as OutlineLearningEvent
    this.emit(enriched)
    return enriched
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.projectGeneration += 1
    this.listeners.clear()
    this.clearPendingRefresh()
    this.trailingRefreshRequested = false
    this.stopWatchingVault()
  }

  private scheduleRefresh(): void {
    if (
      this.disposed ||
      this.pendingRefreshHandle ||
      this.trailingRefreshRequested
    )
      return
    this.pendingRefreshHandle = setTimeout(() => {
      this.pendingRefreshHandle = null
      if (this.refreshInFlight) {
        this.trailingRefreshRequested = true
        return
      }
      void this.refreshSnapshot({ emitInitial: false })
    }, 150)
  }

  private emit(event: OutlineLearningEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[YOLO] Learning event listener failed', error)
      }
    }
  }

  private nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }

  private clearPendingRefresh(): void {
    if (!this.pendingRefreshHandle) return
    clearTimeout(this.pendingRefreshHandle)
    this.pendingRefreshHandle = null
  }

  private isCurrentProject(projectPath: string, generation: number): boolean {
    return (
      !this.disposed &&
      this.projectGeneration === generation &&
      this.activeProjectPath === projectPath
    )
  }

  private startTrailingRefresh(): void {
    if (this.disposed || !this.trailingRefreshRequested) return
    this.trailingRefreshRequested = false
    void this.refreshSnapshot({ emitInitial: false })
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error(DISPOSED_ERROR_MESSAGE)
  }
}

function pathsIntersect(first: string, second: string): boolean {
  return (
    isPathUnderLearningBase(first, second) ||
    isPathUnderLearningBase(second, first)
  )
}

function runCleanups(cleanups: Array<() => void>): unknown[] {
  const errors: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

/**
 * Computes the ordered domain events that transform one outline into another.
 * Structural additions precede relations so consumers never see dangling edges.
 */
export function diffProjects(
  prev: OutlineProject,
  next: OutlineProject,
  meta: () => { sequence: number; timestamp: number },
): OutlineLearningEvent[] {
  const events: OutlineLearningEvent[] = []
  const projectId = next.id
  const prevChapters = new Map(
    prev.chapters.map((chapter) => [chapter.id, chapter]),
  )
  const nextChapters = new Map(
    next.chapters.map((chapter) => [chapter.id, chapter]),
  )

  for (const [id, chapter] of nextChapters) {
    const previous = prevChapters.get(id)
    if (!previous) {
      events.push({ type: 'chapter_added', ...meta(), projectId, chapter })
    } else if (chapterChanged(previous, chapter)) {
      events.push({ type: 'chapter_updated', ...meta(), projectId, chapter })
    }
  }

  for (const [id] of prevChapters) {
    if (!nextChapters.has(id)) {
      events.push({
        type: 'chapter_removed',
        ...meta(),
        projectId,
        chapterId: id,
      })
    }
  }

  const prevKnowledgePoints = new Map(
    prev.knowledgePoints.map((point) => [point.id, point]),
  )
  const nextKnowledgePoints = new Map(
    next.knowledgePoints.map((point) => [point.id, point]),
  )

  for (const [id, knowledgePoint] of nextKnowledgePoints) {
    const previous = prevKnowledgePoints.get(id)
    if (!previous) {
      events.push({
        type: 'knowledge_point_added',
        ...meta(),
        projectId,
        knowledgePoint,
      })
    } else {
      const changedFields = diffKnowledgePointFields(previous, knowledgePoint)
      if (changedFields.length > 0) {
        events.push({
          type: 'knowledge_point_updated',
          ...meta(),
          projectId,
          knowledgePoint,
          changedFields,
        })
      }
    }
  }

  for (const [id] of prevKnowledgePoints) {
    if (!nextKnowledgePoints.has(id)) {
      events.push({
        type: 'knowledge_point_removed',
        ...meta(),
        projectId,
        knowledgePointId: id,
      })
    }
  }

  for (const [id, knowledgePoint] of nextKnowledgePoints) {
    const previousRelations = prevKnowledgePoints.get(id)?.relations ?? []
    const { added, removed } = diffRelations(
      previousRelations,
      knowledgePoint.relations,
    )
    for (const relation of added) {
      events.push({
        type: 'relation_established',
        ...meta(),
        projectId,
        sourceId: id,
        relation,
      })
    }
    for (const relation of removed) {
      events.push({
        type: 'relation_removed',
        ...meta(),
        projectId,
        sourceId: id,
        targetId: relation.targetId,
      })
    }
  }

  return events
}

function chapterChanged(prev: Chapter, next: Chapter): boolean {
  if (prev.title !== next.title || prev.slug !== next.slug) return true
  if (prev.knowledgePointIds.length !== next.knowledgePointIds.length)
    return true
  return prev.knowledgePointIds.some(
    (id, index) => id !== next.knowledgePointIds[index],
  )
}

function diffKnowledgePointFields(
  prev: KnowledgePoint,
  next: KnowledgePoint,
): Array<keyof KnowledgePoint> {
  const fields: Array<keyof KnowledgePoint> = []
  if (prev.title !== next.title) fields.push('title')
  if (prev.chapterId !== next.chapterId) fields.push('chapterId')
  if (prev.hasCards !== next.hasCards) fields.push('hasCards')
  if (prev.hasExercises !== next.hasExercises) fields.push('hasExercises')
  if (prev.mtime !== next.mtime) fields.push('mtime')
  return fields
}

function diffRelations(
  prev: Relation[],
  next: Relation[],
): { added: Relation[]; removed: Relation[] } {
  const prevKeys = new Map(
    prev.map((relation) => [relationKey(relation), relation]),
  )
  const nextKeys = new Map(
    next.map((relation) => [relationKey(relation), relation]),
  )
  const added: Relation[] = []
  const removed: Relation[] = []
  for (const [key, relation] of nextKeys) {
    if (!prevKeys.has(key)) added.push(relation)
  }
  for (const [key, relation] of prevKeys) {
    if (!nextKeys.has(key)) removed.push(relation)
  }
  return { added, removed }
}

function relationKey(relation: Relation): string {
  return `${relation.targetId}::${relation.type}`
}

export { scanProjects }
