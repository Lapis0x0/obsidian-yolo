import type { LearningVaultWriteApi } from '../domain/learningVaultWriteApi'

import { collectExistingCardUuids } from './cardGenerator'
import type {
  LearningGenerationActivity,
  LearningGenerationHost,
  LearningWorkspaceScope,
} from './host'
import {
  type ChapterWriteTarget,
  createProjectScaffold,
  markProjectStudying,
} from './projectWriter'
import type { StagedReference } from './referenceStaging'
import {
  type ProjectResumePlan,
  buildProjectResumePlan,
  isProjectResumePlanFullyGenerated,
} from './resumePlan'
import {
  type ChapterKnowledgePoint,
  generateChapterSerially,
} from './serialChapterEngine'
import type {
  CardGenerationEvent,
  CardGenerationResult,
  GenerationProgress,
  KnowledgePointGenerationEvent,
  OutlineChapter,
} from './types'

/**
 * Host-shaped module-level service that owns the "project generation" task
 * (knowledge points + cards) end to end. It is created once when the Learning
 * module activates and disposed when the module deactivates, so the task's
 * lifetime is independent of any wizard view or workspace mount: closing the
 * view that started a generation no longer interrupts it.
 */

export type ProjectGenerationRunStatus =
  | 'knowledge-points'
  | 'cards'
  | 'completed'
  | 'error'
  | 'aborted'

export type ProjectGenerationTaskSnapshot = Readonly<{
  taskId: string
  topic: string
  projectId: string | null
  status: ProjectGenerationRunStatus
  chapters: readonly GenerationProgress[]
  error?: string
}>

export type ProjectGenerationServiceEvent =
  | Readonly<{
      type: 'project-started'
      snapshot: ProjectGenerationTaskSnapshot
    }>
  | Readonly<{
      type: 'chapter-progress'
      snapshot: ProjectGenerationTaskSnapshot
      progress: GenerationProgress
    }>
  | Readonly<{
      type: 'knowledge-point'
      snapshot: ProjectGenerationTaskSnapshot
      point: KnowledgePointGenerationEvent
    }>
  | Readonly<{
      type: 'knowledge-completed'
      snapshot: ProjectGenerationTaskSnapshot
    }>
  | Readonly<{ type: 'cards-started'; snapshot: ProjectGenerationTaskSnapshot }>
  | Readonly<{
      type: 'card'
      snapshot: ProjectGenerationTaskSnapshot
      card: CardGenerationEvent
    }>
  | Readonly<{
      type: 'chapter-settled'
      snapshot: ProjectGenerationTaskSnapshot
      result: CardGenerationResult
    }>
  | Readonly<{
      type: 'cards-finished'
      snapshot: ProjectGenerationTaskSnapshot
      failed: boolean
    }>
  | Readonly<{ type: 'completed'; snapshot: ProjectGenerationTaskSnapshot }>
  | Readonly<{ type: 'error'; snapshot: ProjectGenerationTaskSnapshot }>
  | Readonly<{ type: 'aborted'; snapshot: ProjectGenerationTaskSnapshot }>

export type ProjectGenerationListener = (
  event: ProjectGenerationServiceEvent,
) => void

export type StartProjectGenerationInput = Readonly<{
  topic: string
  level: string
  goal: string
  projectName: string
  projectGoal: string
  outputLanguage: string
  chapters: readonly OutlineChapter[]
  stagingDir?: string
  referenceFiles?: readonly StagedReference[]
}>

/** Thrown by {@link ProjectGenerationService.startProjectGeneration} when a task is already running. */
export class LearningProjectGenerationBusyError extends Error {
  constructor() {
    super('A Learning project generation task is already running')
    this.name = 'LearningProjectGenerationBusyError'
  }
}

export type ProjectGenerationBackgroundPort = Readonly<{
  showRunning(detail: string, projectId: string | null): void
  showFailed(detail: string, projectId: string | null): void
  clear(): void
}>

export type ProjectGenerationCardsOutcome = 'success' | 'partial' | 'failed'

/** A project's resumability, derived purely from what is on disk. */
export type ProjectResumeInspection =
  | Readonly<{ resumable: false; reason: 'complete' | 'unavailable' }>
  | Readonly<{
      resumable: true
      completedChapters: number
      totalChapters: number
    }>

export type ProjectGenerationServiceDeps = Readonly<{
  generationHost: LearningGenerationHost
  /** Narrow, direct vault writer used for scaffolding and knowledge point writes. */
  writer: LearningVaultWriteApi
  getLearningBaseDir: () => string
  getModelId: () => string | undefined
  shouldGenerateCards: () => boolean
  moveStagedReferences?: (input: {
    stagingDir: string
    projectPath: string
  }) => Promise<string>
  onProjectReady?: (projectPath: string) => void | Promise<void>
  activities: {
    knowledgePoints(detail: string): LearningGenerationActivity
    cards(detail: string): LearningGenerationActivity
  }
  background?: ProjectGenerationBackgroundPort
  notifyCardsCompletion?: (input: {
    taskId: string
    projectId: string
    outcome: ProjectGenerationCardsOutcome
    cardCount: number
    generatedCount: number
    skippedCount: number
    notFinishedCount: number
  }) => void
  describeChapterProgress: (completed: number, total: number) => string
  describeCardsProgress: () => string
}>

const ACTIVE_STATUSES: readonly ProjectGenerationRunStatus[] = [
  'knowledge-points',
  'cards',
]

/** How a single chapter is handled by the shared generation loop. */
type ChapterLoopAction =
  | Readonly<{ kind: 'full' }>
  | Readonly<{
      kind: 'cards-only'
      existingKnowledgePoints: readonly ChapterKnowledgePoint[]
    }>
  | Readonly<{
      kind: 'skip'
      existingKnowledgePoints: readonly ChapterKnowledgePoint[]
    }>

/** Fully-resolved inputs for one generation run, whether fresh or resumed. */
type GenerationRunSpec = Readonly<{
  projectPath: string
  indexPath: string
  projectTopic: string
  projectGoal: string
  outputLanguage: string
  level: string
  outline: readonly OutlineChapter[]
  chapterTargets: readonly ChapterWriteTarget[]
  chapterActions: readonly ChapterLoopAction[]
  workspaceScope?: LearningWorkspaceScope
  referenceDir?: string
  generateCards: boolean
  usedCardUuids: Set<string>
  /** Fresh starts navigate the user to the project once it's usable; resume does not (the user is already there). */
  notifyProjectReady: boolean
}>

export class ProjectGenerationService {
  private readonly deps: ProjectGenerationServiceDeps
  private readonly listeners = new Set<ProjectGenerationListener>()
  private current: {
    snapshot: ProjectGenerationTaskSnapshot
    controller: AbortController
  } | null = null
  private disposed = false
  private taskSequence = 0

  constructor(deps: ProjectGenerationServiceDeps) {
    this.deps = deps
  }

  getCurrentTask(): ProjectGenerationTaskSnapshot | null {
    return this.current?.snapshot ?? null
  }

  subscribe(listener: ProjectGenerationListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Accepts and starts a new generation task, or throws
   * {@link LearningProjectGenerationBusyError} if one is already running.
   * The returned snapshot reflects the task at acceptance time; subsequent
   * progress is delivered through {@link subscribe}.
   */
  startProjectGeneration(
    input: StartProjectGenerationInput,
  ): ProjectGenerationTaskSnapshot {
    this.assertCanStartNewTask()
    this.taskSequence += 1
    const controller = new AbortController()
    const snapshot: ProjectGenerationTaskSnapshot = {
      taskId: `learning-generation-${Date.now().toString(36)}-${this.taskSequence}`,
      topic: input.projectName || input.topic,
      projectId: null,
      status: 'knowledge-points',
      chapters: input.chapters.map((chapter, chapterIndex) => ({
        chapterIndex,
        chapterTitle: chapter.title,
        status: 'pending' as const,
      })),
    }
    this.current = { snapshot, controller }
    this.deps.background?.showRunning(
      this.deps.describeChapterProgress(0, input.chapters.length),
      null,
    )
    void this.runGeneration(snapshot.taskId, controller, () =>
      this.buildFreshSpec(input),
    ).catch((error) => {
      console.error(
        '[YOLO] Learning project generation task failed unexpectedly',
        error,
      )
    })
    return snapshot
  }

  /**
   * Resumes a previously interrupted generation task from what is already on
   * disk. Unlike {@link startProjectGeneration}, this must read the vault
   * before it can even report an initial snapshot, so it is async; a task
   * that cannot be resumed (e.g. it predates resume support, or generation
   * already fully completed) rejects instead of creating a task.
   */
  async resumeProjectGeneration(
    projectPath: string,
  ): Promise<ProjectGenerationTaskSnapshot> {
    this.assertCanStartNewTask()
    const generateCards = this.deps.shouldGenerateCards()
    const plan = await buildProjectResumePlan({
      vault: this.deps.generationHost.vault,
      vaultWriter: this.deps.generationHost.vaultWriter,
      projectPath,
      generateCards,
    })
    // Re-check: disposal or a concurrent task may have raced the awaits above.
    this.assertCanStartNewTask()

    this.taskSequence += 1
    const controller = new AbortController()
    const completedChapters = plan.chapters.filter(
      (chapter) => chapter.state === 'complete',
    ).length
    const snapshot: ProjectGenerationTaskSnapshot = {
      taskId: `learning-generation-resume-${Date.now().toString(36)}-${this.taskSequence}`,
      topic: plan.topic,
      projectId: plan.projectPath,
      status: 'knowledge-points',
      chapters: plan.chapters.map((chapter) => ({
        chapterIndex: chapter.chapterIndex,
        chapterTitle: chapter.chapterTitle,
        status:
          chapter.state === 'complete'
            ? ('completed' as const)
            : ('pending' as const),
      })),
    }
    this.current = { snapshot, controller }
    this.deps.background?.showRunning(
      this.deps.describeChapterProgress(
        completedChapters,
        plan.chapters.length,
      ),
      plan.projectPath,
    )
    void this.runGeneration(snapshot.taskId, controller, () =>
      this.buildResumeSpec(plan, generateCards),
    ).catch((error) => {
      console.error(
        '[YOLO] Learning project generation resume failed unexpectedly',
        error,
      )
    })
    return snapshot
  }

  /**
   * Reports whether a project has an unfinished generation that can be
   * resumed, without starting anything. Used by the project view to decide
   * whether to show a "generation unfinished" banner.
   */
  async inspectResumability(
    projectPath: string,
  ): Promise<ProjectResumeInspection> {
    let plan: ProjectResumePlan
    try {
      plan = await buildProjectResumePlan({
        vault: this.deps.generationHost.vault,
        vaultWriter: this.deps.generationHost.vaultWriter,
        projectPath,
        generateCards: this.deps.shouldGenerateCards(),
      })
    } catch {
      return { resumable: false, reason: 'unavailable' }
    }
    if (isProjectResumePlanFullyGenerated(plan)) {
      return { resumable: false, reason: 'complete' }
    }
    return {
      resumable: true,
      completedChapters: plan.chapters.filter(
        (chapter) => chapter.state === 'complete',
      ).length,
      totalChapters: plan.chapters.length,
    }
  }

  abortCurrentTask(): void {
    this.current?.controller.abort()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.current?.controller.abort()
    this.listeners.clear()
  }

  private assertCanStartNewTask(): void {
    if (this.disposed) {
      throw new Error('Learning project generation service has been disposed')
    }
    if (
      this.current &&
      ACTIVE_STATUSES.includes(this.current.snapshot.status)
    ) {
      throw new LearningProjectGenerationBusyError()
    }
  }

  private async buildFreshSpec(
    input: StartProjectGenerationInput,
  ): Promise<GenerationRunSpec> {
    const { deps } = this
    const root = deps.getLearningBaseDir()
    const scaffold = await createProjectScaffold({
      writer: deps.writer,
      baseDir: root,
      topic: input.projectName || input.topic,
      goal: input.projectGoal || input.goal,
      level: input.level,
      outputLanguage: input.outputLanguage,
      chapters: [...input.chapters],
    })
    let referenceDir: string | undefined
    if (input.stagingDir && input.referenceFiles?.length) {
      referenceDir = await deps.moveStagedReferences?.({
        stagingDir: input.stagingDir,
        projectPath: scaffold.projectPath,
      })
    }
    const workspaceScope: LearningWorkspaceScope | undefined = referenceDir
      ? { enabled: true, include: [referenceDir], exclude: [] }
      : undefined
    const generateCards = deps.shouldGenerateCards()
    const usedCardUuids = generateCards
      ? await collectExistingCardUuids(
          deps.generationHost.vault,
          scaffold.projectPath,
        )
      : new Set<string>()
    return {
      projectPath: scaffold.projectPath,
      indexPath: scaffold.indexPath,
      projectTopic: input.projectName || input.topic,
      projectGoal: input.projectGoal || input.goal,
      outputLanguage: input.outputLanguage,
      level: input.level,
      outline: input.chapters,
      chapterTargets: scaffold.chapters,
      chapterActions: input.chapters.map(() => ({ kind: 'full' as const })),
      workspaceScope,
      referenceDir,
      generateCards,
      usedCardUuids,
      notifyProjectReady: true,
    }
  }

  private async buildResumeSpec(
    plan: ProjectResumePlan,
    generateCards: boolean,
  ): Promise<GenerationRunSpec> {
    const { deps } = this
    const usedCardUuids = generateCards
      ? await collectExistingCardUuids(
          deps.generationHost.vault,
          plan.projectPath,
        )
      : new Set<string>()
    const workspaceScope: LearningWorkspaceScope | undefined = plan.referenceDir
      ? { enabled: true, include: [plan.referenceDir], exclude: [] }
      : undefined
    return {
      projectPath: plan.projectPath,
      indexPath: `${plan.projectPath}/index.md`,
      projectTopic: plan.topic,
      projectGoal: plan.goal,
      outputLanguage: plan.outputLanguage,
      level: plan.level,
      outline: plan.chapters.map((chapter) => ({
        title: chapter.chapterTitle,
        contract: chapter.chapterContract,
      })),
      chapterTargets: plan.chapters.map((chapter) => chapter.target),
      chapterActions: plan.chapters.map((chapter): ChapterLoopAction => {
        if (chapter.state === 'complete') {
          return {
            kind: 'skip',
            existingKnowledgePoints: chapter.existingKnowledgePoints,
          }
        }
        if (chapter.state === 'cards-missing') {
          return {
            kind: 'cards-only',
            existingKnowledgePoints: chapter.existingKnowledgePoints,
          }
        }
        return { kind: 'full' }
      }),
      workspaceScope,
      referenceDir: plan.referenceDir,
      generateCards,
      usedCardUuids,
      notifyProjectReady: false,
    }
  }

  private emit(event: ProjectGenerationServiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[YOLO] Learning generation listener failed', error)
      }
    }
  }

  /** Applies a patch to the current task if it is still the given task, returning the new snapshot. */
  private patch(
    taskId: string,
    patch: Partial<ProjectGenerationTaskSnapshot>,
  ): ProjectGenerationTaskSnapshot | null {
    if (!this.current || this.current.snapshot.taskId !== taskId) return null
    const snapshot = { ...this.current.snapshot, ...patch }
    this.current = { ...this.current, snapshot }
    return snapshot
  }

  private reportChapterProgress(
    taskId: string,
    progress: GenerationProgress,
  ): void {
    if (!this.current || this.current.snapshot.taskId !== taskId) return
    const chapters = this.current.snapshot.chapters.map((chapter) =>
      chapter.chapterIndex === progress.chapterIndex ? progress : chapter,
    )
    const snapshot = this.patch(taskId, { chapters })
    if (!snapshot) return
    this.emit({ type: 'chapter-progress', snapshot, progress })
    if (progress.status === 'completed') {
      const completed = chapters.filter(
        (chapter) => chapter.status === 'completed',
      ).length
      this.deps.background?.showRunning(
        this.deps.describeChapterProgress(completed, chapters.length),
        snapshot.projectId,
      )
    }
  }

  /**
   * Runs the serial per-chapter loop shared by fresh starts and resumes.
   * `buildSpec` does whatever async setup is specific to the entry point
   * (scaffold creation for a fresh start, nothing further for a resume) —
   * errors it throws are handled by the same failure path as a mid-loop
   * chapter failure, so a fresh start that fails to even scaffold the
   * project still surfaces as a normal failed task.
   */
  private async runGeneration(
    taskId: string,
    controller: AbortController,
    buildSpec: () => Promise<GenerationRunSpec>,
  ): Promise<void> {
    const { deps } = this
    const signal = controller.signal
    try {
      const spec = await buildSpec()
      let snapshot = this.patch(taskId, { projectId: spec.projectPath })
      if (!snapshot) return
      deps.background?.showRunning(
        deps.describeChapterProgress(
          spec.chapterActions.filter((action) => action.kind === 'skip').length,
          spec.chapterTargets.length,
        ),
        spec.projectPath,
      )
      this.emit({ type: 'project-started', snapshot })

      // Each chapter runs its knowledge-point session, then (if enabled) its
      // card session, strictly before the next chapter starts — see
      // `generateChapterSerially`. Chapters already complete (resume) are
      // resolved without an agent call at all.
      const priorChapterKnowledgeTitles: {
        chapterTitle: string
        titles: string[]
      }[] = []
      const cardResults: CardGenerationResult[] = []

      for (
        let chapterIndex = 0;
        chapterIndex < spec.chapterTargets.length;
        chapterIndex += 1
      ) {
        const target = spec.chapterTargets[chapterIndex]
        const action = spec.chapterActions[chapterIndex]
        if (!target || !action) {
          throw new Error(`Missing chapter plan at index ${chapterIndex}`)
        }

        if (action.kind !== 'skip') {
          this.reportChapterProgress(taskId, {
            chapterIndex,
            chapterTitle: target.chapterTitle,
            status: 'generating',
            emittedCount: 0,
          })
        }

        let outcome: Awaited<ReturnType<typeof generateChapterSerially>>
        try {
          outcome =
            action.kind === 'skip'
              ? {
                  knowledgePoints: [...action.existingKnowledgePoints],
                  cardResult: spec.generateCards
                    ? {
                        chapterIndex,
                        chapterTitle: target.chapterTitle,
                        cards: [],
                        status: 'skipped' as const,
                        discardedCount: 0,
                      }
                    : null,
                }
              : await generateChapterSerially({
                  host: deps.generationHost,
                  modelId: deps.getModelId(),
                  projectTopic: spec.projectTopic,
                  projectGoal: spec.projectGoal,
                  outputLanguage: spec.outputLanguage,
                  level: spec.level,
                  outline: spec.outline,
                  chapterIndex,
                  target,
                  projectPath: spec.projectPath,
                  priorChapterKnowledgeTitles,
                  workspaceScope: spec.workspaceScope,
                  referenceDir: spec.referenceDir,
                  generateCards: spec.generateCards,
                  usedCardUuids: spec.usedCardUuids,
                  vault: deps.generationHost.vault,
                  writer: deps.writer,
                  abortSignal: signal,
                  activities: deps.activities,
                  runId: taskId,
                  projectId: spec.projectPath,
                  resumeKnowledgePoints:
                    action.kind === 'cards-only'
                      ? [...action.existingKnowledgePoints]
                      : undefined,
                  onKnowledgePoint: (point) => {
                    this.reportChapterProgress(taskId, {
                      chapterIndex: point.chapterIndex,
                      chapterTitle: point.chapterTitle,
                      status: 'generating',
                      emittedCount: point.kpIndex + 1,
                    })
                    const current = this.current?.snapshot
                    if (current && current.taskId === taskId) {
                      this.emit({
                        type: 'knowledge-point',
                        snapshot: current,
                        point,
                      })
                    }
                  },
                  onCard: (event) => {
                    const current = this.current?.snapshot
                    if (current && current.taskId === taskId) {
                      this.emit({
                        type: 'card',
                        snapshot: current,
                        card: event,
                      })
                    }
                  },
                })
        } catch (error) {
          this.reportChapterProgress(taskId, {
            chapterIndex,
            chapterTitle: target.chapterTitle,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }

        this.reportChapterProgress(taskId, {
          chapterIndex,
          chapterTitle: target.chapterTitle,
          status: 'completed',
        })
        priorChapterKnowledgeTitles.push({
          chapterTitle: target.chapterTitle,
          titles: outcome.knowledgePoints.map((point) => point.title),
        })
        if (outcome.cardResult) {
          cardResults.push(outcome.cardResult)
          const current = this.current?.snapshot
          if (current && current.taskId === taskId) {
            this.emit({
              type: 'chapter-settled',
              snapshot: current,
              result: outcome.cardResult,
            })
          }
        }

        // The project becomes usable as soon as its first chapter is fully
        // ready: consumption is inherently serial (studying chapter 1 does
        // not require chapter N to exist yet), so later chapters keep
        // generating in the background while the user can already start.
        if (chapterIndex === 0) {
          await markProjectStudying({
            vault: deps.generationHost.vault,
            writer: deps.writer,
            indexPath: spec.indexPath,
          })
          if (spec.notifyProjectReady) {
            await deps.onProjectReady?.(spec.projectPath)
          }
          snapshot = this.current?.snapshot ?? null
          if (!snapshot || snapshot.taskId !== taskId) return
          this.emit({ type: 'knowledge-completed', snapshot })
          if (spec.generateCards) {
            snapshot = this.patch(taskId, { status: 'cards' })
            if (!snapshot) return
            deps.background?.showRunning(
              deps.describeCardsProgress(),
              spec.projectPath,
            )
            this.emit({ type: 'cards-started', snapshot })
          }
        }
      }

      if (spec.generateCards) {
        const projectId = spec.projectPath
        const outcome = getCardGenerationOutcome(cardResults)
        const failed = outcome !== 'success'
        deps.notifyCardsCompletion?.({
          taskId,
          projectId,
          outcome,
          cardCount: cardResults.reduce(
            (total, result) => total + result.cards.length,
            0,
          ),
          generatedCount: cardResults.filter(
            (result) => result.status === 'generated',
          ).length,
          skippedCount: cardResults.filter(
            (result) => result.status === 'skipped',
          ).length,
          notFinishedCount: cardResults.filter(
            (result) =>
              result.status === 'partial' || result.status === 'failed',
          ).length,
        })
        const current = this.current?.snapshot
        if (current && current.taskId === taskId) {
          this.emit({ type: 'cards-finished', snapshot: current, failed })
        }
      }

      const finalSnapshot = this.patch(taskId, { status: 'completed' })
      if (!finalSnapshot) return
      deps.background?.clear()
      this.emit({ type: 'completed', snapshot: finalSnapshot })
    } catch (error) {
      const aborted = signal.aborted
      const message = error instanceof Error ? error.message : String(error)
      const finalSnapshot = this.patch(taskId, {
        status: aborted ? 'aborted' : 'error',
        ...(aborted ? {} : { error: message }),
      })
      if (!finalSnapshot) return
      if (aborted) {
        deps.background?.clear()
        this.emit({ type: 'aborted', snapshot: finalSnapshot })
      } else {
        deps.background?.showFailed(message, finalSnapshot.projectId)
        this.emit({ type: 'error', snapshot: finalSnapshot })
      }
    }
  }
}

function getCardGenerationOutcome(
  results: readonly CardGenerationResult[],
): ProjectGenerationCardsOutcome {
  if (
    results.length === 0 ||
    results.every((result) => result.status === 'failed')
  ) {
    return 'failed'
  }
  return results.some(
    (result) => result.status === 'partial' || result.status === 'failed',
  )
    ? 'partial'
    : 'success'
}
