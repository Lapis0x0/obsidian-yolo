import { LearningGenerationAbortError } from './abortError'
import { collectExistingCardUuids } from './cardGenerator'
import type { LearningGenerationHost } from './host'
import {
  LearningProjectGenerationBusyError,
  ProjectGenerationService,
  type ProjectGenerationServiceDeps,
  type ProjectGenerationServiceEvent,
} from './projectGenerationService'
import { createProjectScaffold, markProjectStudying } from './projectWriter'
import {
  LearningProjectResumeUnavailableError,
  buildProjectResumePlan,
} from './resumePlan'
import type { ChapterResumePlan, ProjectResumePlan } from './resumePlan'
import { generateChapterSerially } from './serialChapterEngine'
import type { ChapterGenerationOutcome } from './serialChapterEngine'

jest.mock('./serialChapterEngine', () => ({
  generateChapterSerially: jest.fn(),
}))
jest.mock('./cardGenerator', () => ({
  collectExistingCardUuids: jest.fn(),
}))
jest.mock('./projectWriter', () => ({
  createProjectScaffold: jest.fn(),
  markProjectStudying: jest.fn(async () => undefined),
}))
jest.mock('./resumePlan', () => {
  const actual = jest.requireActual('./resumePlan')
  return {
    ...actual,
    buildProjectResumePlan: jest.fn(),
  }
})

const generateChapterSeriallyMock = jest.mocked(generateChapterSerially)
const collectExistingCardUuidsMock = jest.mocked(collectExistingCardUuids)
const createProjectScaffoldMock = jest.mocked(createProjectScaffold)
const markProjectStudyingMock = jest.mocked(markProjectStudying)
const buildProjectResumePlanMock = jest.mocked(buildProjectResumePlan)

const INPUT = {
  topic: 'Topic',
  level: 'familiar',
  goal: 'Goal',
  projectName: 'Project',
  projectGoal: 'Project goal',
  outputLanguage: 'English',
  chapters: [
    { title: 'Chapter one', contract: 'Contract one' },
    { title: 'Chapter two', contract: 'Contract two' },
  ],
}

function scaffoldFor(chapters: typeof INPUT.chapters) {
  return {
    projectPath: 'Learning/project',
    projectSlug: 'project',
    indexPath: 'Learning/project/index.md',
    chapters: chapters.map((chapter, index) => ({
      chapterIndex: index,
      chapterTitle: chapter.title,
      chapterSlug: `chapter-${index}`,
      chapterPath: `Learning/project/chapter-${index}`,
      knowledgePath: `Learning/project/chapter-${index}/knowledge.md`,
      cardsPath: `Learning/project/chapter-${index}/cards.md`,
    })),
  }
}

/** Default happy-path stand-in for one chapter's two-stage serial run. */
function defaultChapterOutcome(
  chapterIndex: number,
  chapterTitle: string,
  generateCards: boolean,
): ChapterGenerationOutcome {
  const kpId = `kp-${chapterIndex}`
  return {
    knowledgePoints: [{ uuid: kpId, title: 'KP' }],
    cardResult: generateCards
      ? {
          chapterIndex,
          chapterTitle,
          cards: [
            {
              title: 'Card',
              kpUuid: kpId,
              front: 'Front',
              back: 'Back',
              startLine: 1,
              cardUuid: `card-${chapterIndex}`,
            },
          ],
          status: 'generated',
          discardedCount: 0,
        }
      : null,
  }
}

function createDeps(
  overrides: Partial<ProjectGenerationServiceDeps> = {},
): ProjectGenerationServiceDeps {
  return {
    generationHost: {
      vault: {} as LearningGenerationHost['vault'],
      vaultWriter: {} as LearningGenerationHost['vaultWriter'],
      agent: {} as LearningGenerationHost['agent'],
    },
    writer: {} as ProjectGenerationServiceDeps['writer'],
    getLearningBaseDir: () => 'Learning',
    getModelId: () => undefined,
    shouldGenerateCards: () => true,
    background: {
      showRunning: jest.fn(),
      showFailed: jest.fn(),
      clear: jest.fn(),
    },
    notifyCardsCompletion: jest.fn(),
    activities: {
      knowledgePoints: (detail) => ({ title: 'Generating knowledge', detail }),
      cards: (detail) => ({ title: 'Generating cards', detail }),
    },
    describeChapterProgress: (completed, total) => `${completed}/${total}`,
    describeCardsProgress: () => 'cards',
    ...overrides,
  }
}

function waitForEvent(
  service: ProjectGenerationService,
  predicate: (event: ProjectGenerationServiceEvent) => boolean,
): Promise<ProjectGenerationServiceEvent> {
  return new Promise((resolve) => {
    const unsubscribe = service.subscribe((event) => {
      if (!predicate(event)) return
      unsubscribe()
      resolve(event)
    })
  })
}

describe('ProjectGenerationService', () => {
  beforeEach(() => {
    generateChapterSeriallyMock.mockReset()
    collectExistingCardUuidsMock.mockReset()
    createProjectScaffoldMock.mockReset()
    markProjectStudyingMock.mockReset()
    buildProjectResumePlanMock.mockReset()
    createProjectScaffoldMock.mockImplementation(async ({ chapters }) =>
      scaffoldFor(chapters as typeof INPUT.chapters),
    )
    collectExistingCardUuidsMock.mockResolvedValue(new Set())
    generateChapterSeriallyMock.mockImplementation(
      async ({
        chapterIndex,
        target,
        generateCards,
        onKnowledgePoint,
        onCard,
      }) => {
        onKnowledgePoint?.({
          chapterIndex,
          chapterTitle: target.chapterTitle,
          kpIndex: 0,
          kpId: `kp-${chapterIndex}`,
          title: 'KP',
        })
        const outcome = defaultChapterOutcome(
          chapterIndex,
          target.chapterTitle,
          generateCards,
        )
        if (outcome.cardResult) {
          onCard?.({
            runId: 'run',
            projectId: 'Learning/project',
            chapterId: target.chapterPath,
            chapterIndex,
            cardIndex: 0,
            cardUuid: outcome.cardResult.cards[0].cardUuid,
            card: outcome.cardResult.cards[0],
          })
        }
        return outcome
      },
    )
  })

  it('accepts a task and reports it through getCurrentTask', () => {
    const deps = createDeps()
    const service = new ProjectGenerationService(deps)

    const snapshot = service.startProjectGeneration(INPUT)

    expect(snapshot.status).toBe('knowledge-points')
    expect(snapshot.projectId).toBeNull()
    expect(snapshot.chapters).toHaveLength(2)
    expect(service.getCurrentTask()).toBe(snapshot)
    expect(deps.background?.showRunning).toHaveBeenCalledWith('0/2', null)
  })

  it('rejects a concurrent start while a task is running', () => {
    createProjectScaffoldMock.mockImplementation(() => new Promise(() => {}))
    const service = new ProjectGenerationService(createDeps())

    service.startProjectGeneration(INPUT)

    expect(() => service.startProjectGeneration(INPUT)).toThrow(
      LearningProjectGenerationBusyError,
    )
  })

  it('allows starting a new task once the previous one has completed', async () => {
    const service = new ProjectGenerationService(createDeps())

    const first = service.startProjectGeneration(INPUT)
    await waitForEvent(
      service,
      (event) =>
        event.type === 'completed' && event.snapshot.taskId === first.taskId,
    )

    expect(() => service.startProjectGeneration(INPUT)).not.toThrow()
  })

  it('runs chapters strictly serially and broadcasts lifecycle events in the expected order', async () => {
    const singleChapterInput = { ...INPUT, chapters: [INPUT.chapters[0]] }
    const deps = createDeps()
    const service = new ProjectGenerationService(deps)
    const events: ProjectGenerationServiceEvent['type'][] = []
    service.subscribe((event) => events.push(event.type))

    service.startProjectGeneration(singleChapterInput)
    await waitForEvent(service, (event) => event.type === 'completed')

    expect(events).toEqual([
      'project-started',
      'chapter-progress', // generating (chapter start)
      'chapter-progress', // generating (knowledge point emitted)
      'knowledge-point',
      'card',
      'chapter-progress', // completed
      'chapter-settled',
      'knowledge-completed',
      'cards-started',
      'cards-finished',
      'completed',
    ])
    expect(service.getCurrentTask()?.status).toBe('completed')
    expect(deps.background?.clear).toHaveBeenCalled()
    expect(deps.notifyCardsCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', cardCount: 1 }),
    )
    expect(markProjectStudyingMock).toHaveBeenCalledTimes(1)
  })

  it('makes the project studying-ready after the first chapter, before later chapters run', async () => {
    const deps = createDeps()
    const service = new ProjectGenerationService(deps)
    let knowledgeCompletedIndex = -1
    let secondChapterStartIndex = -1
    let eventIndex = -1
    service.subscribe((event) => {
      eventIndex += 1
      if (event.type === 'knowledge-completed')
        knowledgeCompletedIndex = eventIndex
      if (
        event.type === 'chapter-progress' &&
        event.progress.status === 'generating' &&
        event.progress.chapterIndex === 1 &&
        secondChapterStartIndex === -1
      ) {
        secondChapterStartIndex = eventIndex
      }
    })

    service.startProjectGeneration(INPUT)
    await waitForEvent(service, (event) => event.type === 'completed')

    expect(markProjectStudyingMock).toHaveBeenCalledTimes(1)
    expect(knowledgeCompletedIndex).toBeGreaterThanOrEqual(0)
    expect(secondChapterStartIndex).toBeGreaterThan(knowledgeCompletedIndex)
    expect(generateChapterSeriallyMock).toHaveBeenCalledTimes(2)
  })

  it('skips the cards phase when shouldGenerateCards returns false', async () => {
    const deps = createDeps({ shouldGenerateCards: () => false })
    const service = new ProjectGenerationService(deps)
    const events: ProjectGenerationServiceEvent['type'][] = []
    service.subscribe((event) => events.push(event.type))

    service.startProjectGeneration(INPUT)
    await waitForEvent(service, (event) => event.type === 'completed')

    expect(events).not.toContain('cards-started')
    expect(events).not.toContain('card')
    expect(events).not.toContain('chapter-settled')
    expect(events).not.toContain('cards-finished')
    expect(collectExistingCardUuidsMock).not.toHaveBeenCalled()
  })

  it('marks a chapter failure as a task-level error and stops the loop before later chapters', async () => {
    const threeChapterInput = {
      ...INPUT,
      chapters: [
        { title: 'Chapter one', contract: 'Contract one' },
        { title: 'Chapter two', contract: 'Contract two' },
        { title: 'Chapter three', contract: 'Contract three' },
      ],
    }
    generateChapterSeriallyMock.mockImplementation(
      async ({ chapterIndex, target, generateCards, onKnowledgePoint }) => {
        if (chapterIndex === 1) throw new Error('boom')
        onKnowledgePoint?.({
          chapterIndex,
          chapterTitle: target.chapterTitle,
          kpIndex: 0,
          kpId: `kp-${chapterIndex}`,
          title: 'KP',
        })
        return defaultChapterOutcome(
          chapterIndex,
          target.chapterTitle,
          generateCards,
        )
      },
    )
    const deps = createDeps()
    const service = new ProjectGenerationService(deps)

    service.startProjectGeneration(threeChapterInput)
    const errorEvent = await waitForEvent(service, (e) => e.type === 'error')

    expect(errorEvent.snapshot.status).toBe('error')
    expect(errorEvent.snapshot.error).toContain('boom')
    expect(errorEvent.snapshot.chapters[1].status).toBe('error')
    // The loop stops: chapter 2 (index 2) must never be attempted.
    expect(generateChapterSeriallyMock).toHaveBeenCalledTimes(2)
    expect(deps.background?.showFailed).toHaveBeenCalled()
  })

  it('aborts the running task and marks it aborted without notifying failure', async () => {
    generateChapterSeriallyMock.mockImplementation(
      ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          if (abortSignal?.aborted) {
            reject(new LearningGenerationAbortError('aborted'))
            return
          }
          abortSignal?.addEventListener('abort', () =>
            reject(new LearningGenerationAbortError('aborted')),
          )
        }),
    )
    const deps = createDeps()
    const service = new ProjectGenerationService(deps)

    service.startProjectGeneration(INPUT)
    service.abortCurrentTask()
    const abortedEvent = await waitForEvent(
      service,
      (e) => e.type === 'aborted',
    )

    expect(abortedEvent.snapshot.status).toBe('aborted')
    expect(deps.background?.clear).toHaveBeenCalled()
    expect(deps.background?.showFailed).not.toHaveBeenCalled()
  })

  it('disposes by aborting the running task and rejecting further starts', async () => {
    generateChapterSeriallyMock.mockImplementation(
      ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          if (abortSignal?.aborted) {
            reject(new LearningGenerationAbortError('aborted'))
            return
          }
          abortSignal?.addEventListener('abort', () =>
            reject(new LearningGenerationAbortError('aborted')),
          )
        }),
    )
    const deps = createDeps()
    const service = new ProjectGenerationService(deps)
    service.startProjectGeneration(INPUT)

    service.dispose()

    const abortedEvent = await waitForEvent(
      service,
      (e) => e.type === 'aborted',
    )
    expect(abortedEvent.snapshot.status).toBe('aborted')
    expect(deps.background?.clear).toHaveBeenCalled()
    expect(() => service.startProjectGeneration(INPUT)).toThrow(/disposed/)
  })

  it('is a no-op to dispose twice or abort with no running task', () => {
    const service = new ProjectGenerationService(createDeps())
    expect(() => service.abortCurrentTask()).not.toThrow()
    expect(() => service.dispose()).not.toThrow()
    expect(() => service.dispose()).not.toThrow()
  })

  describe('resumeProjectGeneration', () => {
    function chapterResumePlan(
      chapterIndex: number,
      state: ChapterResumePlan['state'],
    ): ChapterResumePlan {
      const chapterTitle = `Chapter ${chapterIndex}`
      return {
        chapterIndex,
        chapterTitle,
        chapterContract: `Contract ${chapterIndex}`,
        target: {
          chapterIndex,
          chapterTitle,
          chapterSlug: `chapter-${chapterIndex}`,
          chapterPath: `Learning/project/chapter-${chapterIndex}`,
          knowledgePath: `Learning/project/chapter-${chapterIndex}/knowledge.md`,
          cardsPath: `Learning/project/chapter-${chapterIndex}/cards.md`,
        },
        state,
        existingKnowledgePoints:
          state === 'needs-generation'
            ? []
            : [{ uuid: `kp-${chapterIndex}`, title: 'Existing KP' }],
      }
    }

    function resumePlanWith(chapters: ChapterResumePlan[]): ProjectResumePlan {
      return {
        projectPath: 'Learning/project',
        topic: 'Project',
        goal: 'Project goal',
        level: 'familiar',
        outputLanguage: 'English',
        chapters,
      }
    }

    it('skips complete chapters, resumes cards-only chapters, and reruns incomplete ones', async () => {
      const plan = resumePlanWith([
        chapterResumePlan(0, 'complete'),
        chapterResumePlan(1, 'cards-missing'),
        chapterResumePlan(2, 'needs-generation'),
      ])
      buildProjectResumePlanMock.mockResolvedValue(plan)
      const deps = createDeps()
      const service = new ProjectGenerationService(deps)

      const snapshot = await service.resumeProjectGeneration('Learning/project')
      expect(snapshot.chapters.map((c) => c.status)).toEqual([
        'completed',
        'pending',
        'pending',
      ])

      await waitForEvent(service, (event) => event.type === 'completed')

      // Chapter 0 was already complete: no agent call at all.
      expect(generateChapterSeriallyMock).toHaveBeenCalledTimes(2)
      const [cardsOnlyCall, fullCall] = generateChapterSeriallyMock.mock.calls
      expect(cardsOnlyCall[0]).toMatchObject({
        chapterIndex: 1,
        resumeKnowledgePoints: [{ uuid: 'kp-1', title: 'Existing KP' }],
      })
      expect(fullCall[0]).toMatchObject({
        chapterIndex: 2,
        resumeKnowledgePoints: undefined,
      })
      // markProjectStudying still runs once, for chapter-index-0 completion,
      // even though chapter 0 itself was skipped.
      expect(markProjectStudyingMock).toHaveBeenCalledTimes(1)
    })

    it('does not navigate the user to the project on resume', async () => {
      const plan = resumePlanWith([chapterResumePlan(0, 'cards-missing')])
      buildProjectResumePlanMock.mockResolvedValue(plan)
      const onProjectReady = jest.fn()
      const service = new ProjectGenerationService(
        createDeps({ onProjectReady }),
      )

      await service.resumeProjectGeneration('Learning/project')
      await waitForEvent(service, (event) => event.type === 'completed')

      expect(onProjectReady).not.toHaveBeenCalled()
    })

    it('rejects while a task is already running, without touching the vault', async () => {
      createProjectScaffoldMock.mockImplementation(() => new Promise(() => {}))
      const service = new ProjectGenerationService(createDeps())
      service.startProjectGeneration(INPUT)

      await expect(
        service.resumeProjectGeneration('Learning/project'),
      ).rejects.toBeInstanceOf(LearningProjectGenerationBusyError)
      expect(buildProjectResumePlanMock).not.toHaveBeenCalled()
    })

    it('propagates an unresumable-project error without creating a task', async () => {
      buildProjectResumePlanMock.mockRejectedValue(
        new LearningProjectResumeUnavailableError('missing persisted inputs'),
      )
      const service = new ProjectGenerationService(createDeps())

      await expect(
        service.resumeProjectGeneration('Learning/project'),
      ).rejects.toBeInstanceOf(LearningProjectResumeUnavailableError)
      expect(service.getCurrentTask()).toBeNull()
    })
  })

  describe('inspectResumability', () => {
    it('reports resumable with chapter counts when generation is unfinished', async () => {
      buildProjectResumePlanMock.mockResolvedValue(
        (function resumePlanWith(): ProjectResumePlan {
          return {
            projectPath: 'Learning/project',
            topic: 'Project',
            goal: 'Goal',
            level: 'familiar',
            outputLanguage: 'English',
            chapters: [
              {
                chapterIndex: 0,
                chapterTitle: 'Chapter 0',
                chapterContract: 'Contract',
                target: {
                  chapterIndex: 0,
                  chapterTitle: 'Chapter 0',
                  chapterSlug: 'chapter-0',
                  chapterPath: 'Learning/project/chapter-0',
                  knowledgePath: 'Learning/project/chapter-0/knowledge.md',
                  cardsPath: 'Learning/project/chapter-0/cards.md',
                },
                state: 'complete',
                existingKnowledgePoints: [],
              },
              {
                chapterIndex: 1,
                chapterTitle: 'Chapter 1',
                chapterContract: 'Contract',
                target: {
                  chapterIndex: 1,
                  chapterTitle: 'Chapter 1',
                  chapterSlug: 'chapter-1',
                  chapterPath: 'Learning/project/chapter-1',
                  knowledgePath: 'Learning/project/chapter-1/knowledge.md',
                  cardsPath: 'Learning/project/chapter-1/cards.md',
                },
                state: 'needs-generation',
                existingKnowledgePoints: [],
              },
            ],
          }
        })(),
      )
      const service = new ProjectGenerationService(createDeps())

      await expect(
        service.inspectResumability('Learning/project'),
      ).resolves.toEqual({
        resumable: true,
        completedChapters: 1,
        totalChapters: 2,
      })
    })

    it('reports not resumable when the project predates resume support', async () => {
      buildProjectResumePlanMock.mockRejectedValue(
        new LearningProjectResumeUnavailableError('missing persisted inputs'),
      )
      const service = new ProjectGenerationService(createDeps())

      await expect(
        service.inspectResumability('Learning/project'),
      ).resolves.toEqual({ resumable: false, reason: 'unavailable' })
    })
  })
})
