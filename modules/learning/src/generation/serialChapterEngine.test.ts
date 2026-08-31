import type { LearningVaultReadApi } from '../domain/learningVaultReadApi'
import type {
  LearningVaultFileSnapshot,
  LearningVaultWriteApi,
  LearningVaultWrittenFile,
} from '../domain/learningVaultWriteApi'

import { LearningGenerationAbortError } from './abortError'
import type {
  LearningGenerationAgentEvent,
  LearningGenerationAgentRequest,
  LearningGenerationHost,
  LearningGenerationTool,
} from './host'
import type { ChapterWriteTarget } from './projectWriter'
import {
  ChapterGenerationError,
  generateChapterSerially,
} from './serialChapterEngine'

const NO_DELAY = () => 0

function createInMemoryFiles(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const vault: Pick<LearningVaultReadApi, 'getEntry' | 'readText'> = {
    getEntry: (path) =>
      files.has(path)
        ? { kind: 'file', path, name: path, ctime: 0, mtime: 0 }
        : null,
    readText: async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`Not found: ${path}`)
      return content
    },
  }
  const writer: Pick<LearningVaultWriteApi, 'writeText'> = {
    writeText: async (path, content): Promise<LearningVaultWrittenFile> => {
      files.set(path, content)
      return { path, mtime: Date.now() }
    },
  }
  const vaultWriter: Pick<
    LearningVaultWriteApi,
    'readTextSnapshot' | 'createTextIfAbsent'
  > = {
    readTextSnapshot: async (
      path,
    ): Promise<LearningVaultFileSnapshot | null> => {
      const content = files.get(path)
      if (content === undefined) return null
      return { path, content }
    },
    createTextIfAbsent: async (
      path,
      content,
    ): Promise<LearningVaultFileSnapshot | null> => {
      if (files.has(path)) return null
      files.set(path, content)
      return { path, content }
    },
  }
  return { files, vault, writer, vaultWriter }
}

function createTarget(
  overrides: Partial<ChapterWriteTarget> = {},
): ChapterWriteTarget {
  return {
    chapterIndex: 0,
    chapterTitle: 'Chapter One',
    chapterSlug: '01-chapter-one',
    chapterPath: 'Learning/project/01-chapter-one',
    knowledgePath: 'Learning/project/01-chapter-one/knowledge.md',
    cardsPath: 'Learning/project/01-chapter-one/cards.md',
    ...overrides,
  }
}

function baseOptions(overrides: {
  files: ReturnType<typeof createInMemoryFiles>
  target: ChapterWriteTarget
  stream: (
    request: LearningGenerationAgentRequest,
  ) => AsyncIterable<LearningGenerationAgentEvent>
  generateCards?: boolean
  abortSignal?: AbortSignal
  onKnowledgePoint?: (event: {
    chapterIndex: number
    chapterTitle: string
    kpIndex: number
    kpId: string
    title: string
  }) => void
  onCard?: (event: unknown) => void
}) {
  const host: LearningGenerationHost = {
    vault: overrides.files.vault as LearningVaultReadApi,
    vaultWriter: overrides.files.vaultWriter as LearningVaultWriteApi,
    agent: { stream: overrides.stream },
  }
  return {
    host,
    projectTopic: 'React',
    projectGoal: 'Build real apps',
    outputLanguage: 'English',
    level: 'beginner',
    outline: [
      { title: 'Chapter One', contract: 'Covers the basics' },
      { title: 'Chapter Two', contract: 'Covers the advanced bits' },
    ],
    chapterIndex: overrides.target.chapterIndex,
    target: overrides.target,
    projectPath: 'Learning/project',
    priorChapterKnowledgeTitles: [],
    generateCards: overrides.generateCards ?? true,
    usedCardUuids: new Set<string>(),
    vault: overrides.files.vault as LearningVaultReadApi,
    writer: overrides.files.writer as LearningVaultWriteApi,
    abortSignal: overrides.abortSignal,
    activities: {
      knowledgePoints: (detail: string) => ({
        title: 'Generating knowledge',
        detail,
      }),
      cards: (detail: string) => ({ title: 'Generating cards', detail }),
    },
    runId: 'run-1',
    projectId: 'Learning/project',
    onKnowledgePoint: overrides.onKnowledgePoint,
    onCard: overrides.onCard as never,
    retryDelayMs: NO_DELAY,
  }
}

async function expectChapterGenerationError(
  promise: Promise<unknown>,
  stage: 'knowledge' | 'cards',
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ChapterGenerationError)
  try {
    await promise
    throw new Error('expected promise to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(ChapterGenerationError)
    expect((error as ChapterGenerationError).stage).toBe(stage)
  }
}

/** Drives `tool.handler` with a fixed sequence of inputs, then completes. */
async function* driveTool(
  request: LearningGenerationAgentRequest,
  inputs: Record<string, unknown>[],
): AsyncIterable<LearningGenerationAgentEvent> {
  const tool = request.tools?.[0]
  if (!tool) throw new Error('No tool registered')
  for (const input of inputs) {
    if (request.abortSignal?.aborted) {
      yield { type: 'aborted' }
      return
    }
    await tool.handler(input)
  }
  yield { type: 'completed', text: '' }
}

describe('generateChapterSerially', () => {
  it('writes knowledge points as they are emitted and builds the prompt from the outline and rolling context', async () => {
    const files = createInMemoryFiles({
      'Learning/project/01-chapter-one/knowledge.md':
        '---\ntitle: Chapter One\n---\n\n',
    })
    let capturedRequest: LearningGenerationAgentRequest | undefined
    const stream = async function* (
      request: LearningGenerationAgentRequest,
    ): AsyncGenerator<LearningGenerationAgentEvent> {
      capturedRequest = request
      yield* driveTool(request, [
        {
          title: 'What is JSX',
          body: 'JSX is syntax sugar for createElement.',
        },
      ])
    }
    const emitted: { kpIndex: number; kpId: string; title: string }[] = []
    const target = createTarget()

    const outcome = await generateChapterSerially(
      baseOptions({
        files,
        target,
        stream,
        generateCards: false,
        onKnowledgePoint: (event) => emitted.push(event),
      }) as never,
    )

    expect(outcome.cardResult).toBeNull()
    expect(outcome.knowledgePoints).toEqual([
      { uuid: expect.any(String), title: 'What is JSX' },
    ])
    expect(emitted).toEqual([
      {
        chapterIndex: 0,
        chapterTitle: 'Chapter One',
        kpIndex: 0,
        kpId: outcome.knowledgePoints[0].uuid,
        title: 'What is JSX',
      },
    ])
    expect(files.files.get(target.knowledgePath)).toContain('## What is JSX')
    expect(files.files.get(target.knowledgePath)).toContain(
      `<!--kp:${outcome.knowledgePoints[0].uuid}-->`,
    )

    expect(capturedRequest?.tools?.[0]?.name).toBe('emit_knowledge_point')
    expect(capturedRequest?.prompt).toContain('React')
    expect(capturedRequest?.prompt).toContain('Chapter One')
    expect(capturedRequest?.prompt).toContain('Chapter Two')
    expect(capturedRequest?.prompt).toContain('<- current chapter')
    expect(capturedRequest?.capability).toBe('none')
  })

  it('includes prior chapters knowledge-point titles in the rolling context', async () => {
    const files = createInMemoryFiles({
      'Learning/project/02-chapter-two/knowledge.md':
        '---\ntitle: Chapter Two\n---\n\n',
    })
    let capturedRequest: LearningGenerationAgentRequest | undefined
    const stream = async function* (
      request: LearningGenerationAgentRequest,
    ): AsyncGenerator<LearningGenerationAgentEvent> {
      capturedRequest = request
      yield* driveTool(request, [
        { title: 'Hooks', body: 'Hooks let you use state.' },
      ])
    }
    const target = createTarget({
      chapterIndex: 1,
      chapterTitle: 'Chapter Two',
      knowledgePath: 'Learning/project/02-chapter-two/knowledge.md',
      cardsPath: 'Learning/project/02-chapter-two/cards.md',
    })

    await generateChapterSerially({
      ...baseOptions({ files, target, stream, generateCards: false }),
      chapterIndex: 1,
      priorChapterKnowledgeTitles: [
        { chapterTitle: 'Chapter One', titles: ['What is JSX', 'Components'] },
      ],
    } as never)

    expect(capturedRequest?.prompt).toContain('What is JSX, Components')
  })

  it('rejects invalid emit_knowledge_point calls with isError and keeps them out of the result', async () => {
    const files = createInMemoryFiles({
      'Learning/project/01-chapter-one/knowledge.md':
        '---\ntitle: Chapter One\n---\n\n',
    })
    const results: { content: string; isError?: boolean }[] = []
    const stream = async function* (
      request: LearningGenerationAgentRequest,
    ): AsyncGenerator<LearningGenerationAgentEvent> {
      const tool = request.tools?.[0] as LearningGenerationTool
      results.push(await tool.handler({ title: '', body: '' }))
      results.push(await tool.handler({ title: 'Valid', body: 'Body text' }))
      yield { type: 'completed', text: '' }
    }
    const target = createTarget()

    const outcome = await generateChapterSerially(
      baseOptions({ files, target, stream, generateCards: false }) as never,
    )

    expect(results[0]).toEqual({
      content: expect.any(String),
      isError: true,
    })
    expect(results[1].isError).toBeUndefined()
    expect(outcome.knowledgePoints).toHaveLength(1)
    expect(outcome.knowledgePoints[0].title).toBe('Valid')
  })

  it('aborts the run and fails the chapter after too many invalid emit calls', async () => {
    const files = createInMemoryFiles({
      'Learning/project/01-chapter-one/knowledge.md':
        '---\ntitle: Chapter One\n---\n\n',
    })
    const stream = (request: LearningGenerationAgentRequest) =>
      driveTool(
        request,
        Array.from({ length: 12 }, () => ({ title: '', body: '' })),
      )
    const target = createTarget()

    await expectChapterGenerationError(
      generateChapterSerially(
        baseOptions({ files, target, stream, generateCards: false }) as never,
      ),
      'knowledge',
    )
  })

  it('retries the same stage on an infrastructure error, resetting knowledge.md before retrying', async () => {
    const baseline = '---\ntitle: Chapter One\n---\n\n'
    const files = createInMemoryFiles({
      'Learning/project/01-chapter-one/knowledge.md': baseline,
    })
    const writeTextSpy = jest.spyOn(files.writer, 'writeText')
    let attempt = 0
    const stream = async function* (
      request: LearningGenerationAgentRequest,
    ): AsyncGenerator<LearningGenerationAgentEvent> {
      attempt += 1
      const tool = request.tools?.[0] as LearningGenerationTool
      if (attempt === 1) {
        // Partially emits, then the run fails with an infra error before completing.
        await tool.handler({
          title: 'Half-written',
          body: 'Should be discarded',
        })
        throw new Error('network blip')
      }
      await tool.handler({ title: 'Final point', body: 'Good body' })
      yield { type: 'completed', text: '' }
    }
    const target = createTarget()

    const outcome = await generateChapterSerially(
      baseOptions({ files, target, stream, generateCards: false }) as never,
    )

    expect(attempt).toBe(2)
    expect(outcome.knowledgePoints).toEqual([
      { uuid: expect.any(String), title: 'Final point' },
    ])
    // The half-written point from the failed attempt must not survive.
    expect(files.files.get(target.knowledgePath)).not.toContain('Half-written')
    expect(files.files.get(target.knowledgePath)).toContain('Final point')
    // Reset happened once, between the failed attempt and the retry.
    expect(writeTextSpy).toHaveBeenCalledWith(target.knowledgePath, baseline)
  })

  it('gives up after exhausting infra retries', async () => {
    const files = createInMemoryFiles({
      'Learning/project/01-chapter-one/knowledge.md':
        '---\ntitle: Chapter One\n---\n\n',
    })
    let attempts = 0
    const stream =
      async function* (): AsyncGenerator<LearningGenerationAgentEvent> {
        attempts += 1
        throw new Error('still broken')

        yield { type: 'completed', text: '' }
      }
    const target = createTarget()

    await expectChapterGenerationError(
      generateChapterSerially(
        baseOptions({ files, target, stream, generateCards: false }) as never,
      ),
      'knowledge',
    )
    expect(attempts).toBe(3) // initial attempt + 2 retries
  })

  it('propagates an outer abort without retrying', async () => {
    const files = createInMemoryFiles({
      'Learning/project/01-chapter-one/knowledge.md':
        '---\ntitle: Chapter One\n---\n\n',
    })
    const controller = new AbortController()
    let attempts = 0
    const stream = async function* (
      request: LearningGenerationAgentRequest,
    ): AsyncGenerator<LearningGenerationAgentEvent> {
      attempts += 1
      controller.abort()
      if (request.abortSignal?.aborted) {
        yield { type: 'aborted' }
        return
      }
      yield { type: 'completed', text: '' }
    }
    const target = createTarget()

    await expect(
      generateChapterSerially(
        baseOptions({
          files,
          target,
          stream,
          generateCards: false,
          abortSignal: controller.signal,
        }) as never,
      ),
    ).rejects.toBeInstanceOf(LearningGenerationAbortError)
    expect(attempts).toBe(1)
  })

  it('runs the card stage after knowledge points, using the emitted kpIds, and writes cards.md once', async () => {
    const files = createInMemoryFiles({
      'Learning/project/01-chapter-one/knowledge.md':
        '---\ntitle: Chapter One\n---\n\n',
    })
    const requests: LearningGenerationAgentRequest[] = []
    const target = createTarget()
    const usedCardUuids = new Set<string>()

    // The card stage must reference the kpId the knowledge stage handed
    // back, so the fake stream captures it from the first tool call and
    // feeds it back into the second.
    let knownKpId = ''
    const streamWithRealKpId = async function* (
      request: LearningGenerationAgentRequest,
    ): AsyncGenerator<LearningGenerationAgentEvent> {
      requests.push(request)
      const tool = request.tools?.[0] as LearningGenerationTool
      if (request.tools?.[0]?.name === 'emit_knowledge_point') {
        const result = await tool.handler({
          title: 'What is JSX',
          body: 'JSX body',
        })
        knownKpId = (JSON.parse(result.content) as { kpId: string }).kpId
        yield { type: 'completed', text: '' }
        return
      }
      const result = await tool.handler({
        kpId: knownKpId,
        title: 'Card title',
        front: 'Front?',
        back: 'Back.',
      })
      expect(result.isError).toBeUndefined()
      yield { type: 'completed', text: '' }
    }

    const outcome = await generateChapterSerially({
      ...baseOptions({
        files,
        target,
        stream: streamWithRealKpId,
        generateCards: true,
      }),
      usedCardUuids,
    } as never)

    expect(requests).toHaveLength(2)
    expect(requests[0].tools?.[0]?.name).toBe('emit_knowledge_point')
    expect(requests[1].tools?.[0]?.name).toBe('emit_card')
    expect(requests[1].capability).toBe('none')
    expect(requests[1].prompt).toContain('What is JSX')
    expect(requests[1].prompt).toContain(knownKpId)

    expect(outcome.cardResult?.status).toBe('generated')
    expect(outcome.cardResult?.cards).toHaveLength(1)
    expect(usedCardUuids.size).toBe(1)
    const cardsFile = files.files.get(target.cardsPath)
    expect(cardsFile).toContain('## Card title')
    expect(cardsFile).toContain('Front?')
    expect(cardsFile).toContain('Back.')
  })

  it('rejects emit_card calls referencing an unknown kpId', async () => {
    const files = createInMemoryFiles({
      'Learning/project/01-chapter-one/knowledge.md':
        '---\ntitle: Chapter One\n---\n\n',
    })
    const cardResults: { content: string; isError?: boolean }[] = []
    const stream = async function* (
      request: LearningGenerationAgentRequest,
    ): AsyncGenerator<LearningGenerationAgentEvent> {
      const tool = request.tools?.[0] as LearningGenerationTool
      if (request.tools?.[0]?.name === 'emit_knowledge_point') {
        await tool.handler({ title: 'KP', body: 'Body' })
        yield { type: 'completed', text: '' }
        return
      }
      // Every attempt rejects the same way (unknown kpId), so the run never
      // produces a card and the infra-retry ladder eventually gives up.
      cardResults.push(
        await tool.handler({
          kpId: 'not-a-real-id',
          title: 'Card',
          front: 'Front',
          back: 'Back',
        }),
      )
      yield { type: 'completed', text: '' }
    }
    const target = createTarget()

    await expectChapterGenerationError(
      generateChapterSerially(
        baseOptions({
          files,
          target,
          stream,
          generateCards: true,
        }) as never,
      ),
      'cards',
    )
    expect(cardResults.length).toBeGreaterThan(0)
    expect(cardResults.every((result) => result.isError)).toBe(true)
  })

  it('skips the card stage entirely when generateCards is false', async () => {
    const files = createInMemoryFiles({
      'Learning/project/01-chapter-one/knowledge.md':
        '---\ntitle: Chapter One\n---\n\n',
    })
    let callCount = 0
    const stream = async function* (
      request: LearningGenerationAgentRequest,
    ): AsyncGenerator<LearningGenerationAgentEvent> {
      callCount += 1
      const tool = request.tools?.[0] as LearningGenerationTool
      await tool.handler({ title: 'KP', body: 'Body' })
      yield { type: 'completed', text: '' }
    }
    const target = createTarget()

    const outcome = await generateChapterSerially(
      baseOptions({ files, target, stream, generateCards: false }) as never,
    )

    expect(callCount).toBe(1)
    expect(outcome.cardResult).toBeNull()
  })
})
