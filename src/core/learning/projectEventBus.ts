import { App, TAbstractFile, TFile, TFolder } from 'obsidian'

import {
  isPathUnderLearningBase,
  scanProject,
  scanProjects,
} from './projectScanner'
import type {
  Chapter,
  KnowledgePoint,
  LearningEvent,
  LearningEventListener,
  Project,
  Relation,
} from './types'

/**
 * Distributive Omit so that LearningEvent (a discriminated union) keeps its
 * per-variant fields when we strip the auto-populated ones.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never

export type SyntheticLearningEventInput = DistributiveOmit<
  LearningEvent,
  'sequence' | 'timestamp'
>

/**
 * ProjectEventBus
 * ─────────────────────────────────────────────────────────────────────────
 * Watches the vault and emits high-level domain events as a learning project
 * grows. This is the driver for the "growing knowledge graph" visual.
 *
 * Two data surfaces are exposed:
 *   1. `getSnapshot()`  — current full Project model (lazy / cached)
 *   2. `subscribe(cb)`  — incremental domain events
 *
 * Why both?
 *   - When the graph component first mounts, it draws the current snapshot
 *     statically (no animation, just "here's what already exists").
 *   - From then on, every change comes through as an event so the component
 *     can animate node-add / edge-establish / focus pulse individually.
 *
 * Events are produced by diffing successive project snapshots. The vault
 * watcher is the trigger; the diff is the truth. This makes the same bus
 * usable for both real vault changes AND the mock replay tool (which simply
 * synthesizes events directly without going through diff).
 *
 * Project scoping:
 *   - The bus tracks a SINGLE active project at a time (the one the
 *     LearningView is showing). Switching projects re-scans and replays an
 *     initial `project_initialized` event.
 */
export class ProjectEventBus {
  private readonly listeners = new Set<LearningEventListener>()
  private snapshot: Project | null = null
  private sequence = 0
  private activeProjectPath: string | null = null
  private activeBaseDir: string | null = null
  /**
   * When true, the diff-emitter is suppressed (e.g. while the mock replay tool
   * is driving events). Vault changes still update the cached snapshot.
   */
  private mockMode = false
  /**
   * Pending refresh handle. We debounce vault events because Obsidian can fire
   * many `modify`/`create` events in quick succession when a folder is
   * generated, and we don't want to thrash the diff.
   */
  private pendingRefreshHandle: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private vaultEventCleanups: Array<() => void> = []

  constructor(private readonly app: App) {}

  getSnapshot(): Project | null {
    return this.snapshot
  }

  subscribe(listener: LearningEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Switch the bus to track the project at `projectFolderPath`. Re-scans
   * immediately and emits a `project_initialized` event with the fresh
   * snapshot.
   *
   * @param baseDir The learning base directory (used to scope vault watchers).
   * @param projectFolderPath Vault path of the project folder.
   */
  async setActiveProject(
    baseDir: string,
    projectFolderPath: string | null,
  ): Promise<void> {
    this.activeBaseDir = baseDir
    this.activeProjectPath = projectFolderPath
    if (!projectFolderPath) {
      this.snapshot = null
      return
    }
    await this.refreshSnapshot({ emitInitial: true })
  }

  /**
   * Re-scan the active project and emit either an initial snapshot event or
   * a diffed set of incremental events.
   */
  async refreshSnapshot({
    emitInitial,
  }: {
    emitInitial: boolean
  }): Promise<void> {
    if (!this.activeProjectPath) return

    const folder = this.app.vault.getAbstractFileByPath(this.activeProjectPath)
    if (!(folder instanceof TFolder)) {
      this.snapshot = null
      return
    }

    const next = await scanProject(this.app, folder)
    if (!next) {
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
      // Skip diff emission; mock tool drives the bus directly. Snapshot still
      // updated so post-replay state stays consistent.
      this.snapshot = next
      return
    }

    const events = diffProjects(this.snapshot, next, () => ({
      sequence: this.nextSequence(),
      timestamp: Date.now(),
    }))
    this.snapshot = next
    for (const event of events) this.emit(event)
  }

  /**
   * Start watching vault changes scoped to the active learning base dir. Idempotent.
   */
  startWatchingVault(): void {
    this.stopWatchingVault()

    const handler = (file: TAbstractFile) => {
      if (this.disposed) return
      if (!this.activeBaseDir) return
      if (!isPathUnderLearningBase(file.path, this.activeBaseDir)) return
      if (!this.activeProjectPath) return
      if (
        !file.path.startsWith(this.activeProjectPath + '/') &&
        file.path !== this.activeProjectPath
      ) {
        return
      }
      this.scheduleRefresh()
    }

    const renameHandler = (file: TAbstractFile, oldPath: string) => {
      if (this.disposed) return
      if (!this.activeBaseDir) return
      const oldUnder = isPathUnderLearningBase(oldPath, this.activeBaseDir)
      const newUnder = isPathUnderLearningBase(file.path, this.activeBaseDir)
      if (!oldUnder && !newUnder) return
      this.scheduleRefresh()
    }

    const onCreate = this.app.vault.on('create', handler)
    const onModify = this.app.vault.on('modify', handler)
    const onDelete = this.app.vault.on('delete', handler)
    const onRename = this.app.vault.on('rename', renameHandler)

    this.vaultEventCleanups = [
      () => this.app.vault.offref(onCreate),
      () => this.app.vault.offref(onModify),
      () => this.app.vault.offref(onDelete),
      () => this.app.vault.offref(onRename),
    ]
  }

  stopWatchingVault(): void {
    for (const cleanup of this.vaultEventCleanups) cleanup()
    this.vaultEventCleanups = []
  }

  /**
   * Direct event injection — used by the mock replay tool. While mock mode is
   * on, vault-derived diffs are suppressed so the synthesized stream is the
   * sole source of events.
   */
  beginMockSession(): void {
    this.mockMode = true
  }

  endMockSession(): void {
    this.mockMode = false
  }

  /**
   * Emit a synthesized event (mock or agent-driven). The `sequence` and
   * `timestamp` will be filled in automatically.
   */
  emitSynthetic(event: SyntheticLearningEventInput): LearningEvent {
    const enriched = {
      ...event,
      sequence: this.nextSequence(),
      timestamp: Date.now(),
    } as LearningEvent
    this.emit(enriched)
    return enriched
  }

  dispose(): void {
    this.disposed = true
    this.stopWatchingVault()
    this.listeners.clear()
    if (this.pendingRefreshHandle) {
      clearTimeout(this.pendingRefreshHandle)
      this.pendingRefreshHandle = null
    }
  }

  private scheduleRefresh(): void {
    if (this.pendingRefreshHandle) return
    this.pendingRefreshHandle = setTimeout(() => {
      this.pendingRefreshHandle = null
      void this.refreshSnapshot({ emitInitial: false })
    }, 150)
  }

  private emit(event: LearningEvent): void {
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
}

/**
 * Computes the minimal set of domain events that transforms `prev` into
 * `next`. The order is intentional: structural adds (chapters then knowledge
 * points) before relations, so a graph rendering them in order never sees an
 * edge before both endpoints exist.
 */
export function diffProjects(
  prev: Project,
  next: Project,
  meta: () => { sequence: number; timestamp: number },
): LearningEvent[] {
  const events: LearningEvent[] = []
  const projectId = next.id

  const prevChapters = new Map(prev.chapters.map((c) => [c.id, c]))
  const nextChapters = new Map(next.chapters.map((c) => [c.id, c]))

  for (const [id, chapter] of nextChapters) {
    const previous = prevChapters.get(id)
    if (!previous) {
      events.push({
        type: 'chapter_added',
        ...meta(),
        projectId,
        chapter,
      })
    } else if (chapterChanged(previous, chapter)) {
      events.push({
        type: 'chapter_updated',
        ...meta(),
        projectId,
        chapter,
      })
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

  const prevKps = new Map(prev.knowledgePoints.map((kp) => [kp.id, kp]))
  const nextKps = new Map(next.knowledgePoints.map((kp) => [kp.id, kp]))

  for (const [id, kp] of nextKps) {
    const previous = prevKps.get(id)
    if (!previous) {
      events.push({
        type: 'knowledge_point_added',
        ...meta(),
        projectId,
        knowledgePoint: kp,
      })
    } else {
      const changedFields = diffKnowledgePointFields(previous, kp)
      if (changedFields.length > 0) {
        events.push({
          type: 'knowledge_point_updated',
          ...meta(),
          projectId,
          knowledgePoint: kp,
          changedFields,
        })
      }
    }
  }

  for (const [id] of prevKps) {
    if (!nextKps.has(id)) {
      events.push({
        type: 'knowledge_point_removed',
        ...meta(),
        projectId,
        knowledgePointId: id,
      })
    }
  }

  for (const [id, kp] of nextKps) {
    const previous = prevKps.get(id)
    const previousRelations = previous?.relations ?? []
    const { added, removed } = diffRelations(previousRelations, kp.relations)
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
  if (prev.title !== next.title) return true
  if (prev.slug !== next.slug) return true
  if (prev.knowledgePointIds.length !== next.knowledgePointIds.length)
    return true
  for (let i = 0; i < prev.knowledgePointIds.length; i += 1) {
    if (prev.knowledgePointIds[i] !== next.knowledgePointIds[i]) return true
  }
  return false
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
  const prevKeys = new Map(prev.map((r) => [relationKey(r), r]))
  const nextKeys = new Map(next.map((r) => [relationKey(r), r]))
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

// Re-export scanProjects so consumers can find both APIs through the bus module.
export { scanProjects }
// Silence unused-import warning if TFile becomes unused after refactors.
void TFile
