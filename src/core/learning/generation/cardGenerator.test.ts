import type {
  LearningVaultFile,
  LearningVaultReadApi,
} from '../learningVaultReadApi'
import type {
  LearningVaultFileSnapshot,
  LearningVaultWriteApi,
} from '../learningVaultWriteApi'

import {
  CARD_END_MARKER,
  CardStreamParser,
  generateCardsForChapter,
  parseCardDrafts,
  parseWrittenCardEntries,
  validateWrittenCards,
} from './cardGenerator'
import type { LearningGenerationHost } from './host'
import type { CardDraft, CardGenerationEvent } from './types'

const cardBlock = (title: string, kpUuid = 'aaaaaaaa') =>
  `## ${title} <!--kp:${kpUuid}-->\n\n${title}?\n\n---\n\n${title}!\n`

describe('CardStreamParser', () => {
  it('publishes multiple cards from arbitrary chunks exactly once', () => {
    const cards: CardDraft[] = []
    const parser = new CardStreamParser(new Set(['aaaaaaaa']), (card) =>
      cards.push(card),
    )
    const output = `${cardBlock('A')}${CARD_END_MARKER}\n${cardBlock('B')}${CARD_END_MARKER}\n`

    parser.push(output.slice(0, 17))
    parser.push(output.slice(17, output.indexOf(CARD_END_MARKER) + 8))
    parser.push(output.slice(output.indexOf(CARD_END_MARKER) + 8))

    expect(cards.map((card) => card.title)).toEqual(['A', 'B'])
    expect(parser.discardedCount).toBe(0)
  })

  it('supports CRLF and a marker split across deltas', () => {
    const cards: CardDraft[] = []
    const parser = new CardStreamParser(new Set(['aaaaaaaa']), (card) =>
      cards.push(card),
    )
    const output = `${cardBlock('CRLF')}${CARD_END_MARKER}\n`.replace(
      /\n/g,
      '\r\n',
    )
    const split = output.indexOf(CARD_END_MARKER) + 5

    parser.push(output.slice(0, split))
    expect(cards).toHaveLength(0)
    parser.push(output.slice(split))

    expect(cards).toHaveLength(1)
    expect(cards[0]?.title).toBe('CRLF')
  })

  it('publishes a closing marker at EOF without accepting an unmarked tail', () => {
    const cards: CardDraft[] = []
    const parser = new CardStreamParser(new Set(['aaaaaaaa']), (card) =>
      cards.push(card),
    )

    parser.push(`${cardBlock('Closed')}${CARD_END_MARKER}`)
    parser.finish()
    parser.push(cardBlock('Unclosed'))
    parser.finish()

    expect(cards.map((card) => card.title)).toEqual(['Closed'])
  })

  it('discards invalid, foreign-kp, and unclosed trailing cards', () => {
    const cards: CardDraft[] = []
    const parser = new CardStreamParser(new Set(['aaaaaaaa']), (card) =>
      cards.push(card),
    )

    parser.push(`## Invalid <!--kp:aaaaaaaa-->\n${CARD_END_MARKER}\n`)
    parser.push(`${cardBlock('Foreign', 'bbbbbbbb')}${CARD_END_MARKER}\n`)
    parser.push(cardBlock('Unclosed'))

    expect(cards).toEqual([])
    expect(parser.discardedCount).toBe(2)
  })

  it('does not treat marker text inside card content as a closing line', () => {
    const cards: CardDraft[] = []
    const parser = new CardStreamParser(new Set(['aaaaaaaa']), (card) =>
      cards.push(card),
    )

    parser.push(
      `${cardBlock('A').replace('A!', `包含 ${CARD_END_MARKER} 文本`)}${CARD_END_MARKER}\n`,
    )

    expect(cards).toHaveLength(1)
    expect(cards[0]?.back).toContain(CARD_END_MARKER)
  })
})

describe('generateCardsForChapter streaming', () => {
  it.each([
    ['generated', false, false, false],
    ['partial', true, false, false],
    ['generated', false, true, false],
    ['generated', false, false, true],
  ] as const)(
    'keeps published UUIDs identical in events, result, and disk for %s output',
    async (
      expectedStatus,
      interrupted,
      preexistingRollbackShell,
      retryWithExternalEdit,
    ) => {
      const knowledgePath = 'project/chapter/knowledge.md'
      const cardsPath = 'project/chapter/cards.md'
      const knowledgeFile = { path: knowledgePath }
      const files = new Map<string, object>([[knowledgePath, knowledgeFile]])
      const contents = new Map<string, string>([
        [knowledgePath, '## KP <!--kp:aaaaaaaa-->\n\nBody'],
      ])
      if (preexistingRollbackShell) {
        const cardsFile = { path: cardsPath }
        files.set(cardsPath, cardsFile)
        contents.set(cardsPath, '---\ntitle: Chapter - 卡片\n---\n')
      }
      let generatedContent = ''
      const create = jest.fn(async (path: string, content: string) => {
        const file = { path }
        generatedContent = content
        const written = retryWithExternalEdit
          ? `${content}\n${content.slice(content.indexOf('## '))}`
          : content
        files.set(path, file)
        contents.set(path, written)
        return { path, content: written, identity: file }
      })
      let streamRun = 0
      const stream = jest.fn(async function* () {
        streamRun += 1
        if (retryWithExternalEdit && streamRun === 2) {
          contents.set(cardsPath, `${generatedContent}\nuser edit\n`)
        }
        const text = `${cardBlock('A')}${CARD_END_MARKER}\n`
        yield { type: 'text' as const, delta: text, text }
        if (interrupted) {
          yield { type: 'error' as const, message: 'stream interrupted' }
        } else {
          yield { type: 'completed' as const, text }
        }
      })
      const getFile = (path: string): LearningVaultFile | null => {
        if (!files.has(path)) return null
        return {
          kind: 'file',
          path,
          name: path.split('/').at(-1) ?? path,
          ctime: 0,
          mtime: 0,
        }
      }
      const readSnapshot = async (
        path: string,
      ): Promise<LearningVaultFileSnapshot | null> => {
        const identity = files.get(path)
        if (!identity) return null
        return { path, content: contents.get(path) ?? '', identity }
      }
      const vault = {
        getEntry: getFile,
        listMarkdownFiles: () => [],
        readText: async (path: string) => contents.get(path) ?? '',
      } as unknown as LearningVaultReadApi
      const vaultWriter = {
        readTextSnapshot: readSnapshot,
        createTextIfAbsent: async (path: string, content: string) => {
          if (files.has(path)) return null
          return create(path, content)
        },
        replaceTextIfUnchanged: async (
          expected: LearningVaultFileSnapshot,
          content: string,
        ) => {
          const current = await readSnapshot(expected.path)
          if (
            !current ||
            current.identity !== expected.identity ||
            current.content !== expected.content
          ) {
            return null
          }
          contents.set(expected.path, content)
          return { ...expected, content }
        },
        revertOwnedCreatedTextIfUnchanged: async (
          created: LearningVaultFileSnapshot,
          expected: LearningVaultFileSnapshot,
          fallbackContent: string,
        ) => {
          const current = await readSnapshot(expected.path)
          if (
            !current ||
            current.identity !== created.identity ||
            current.identity !== expected.identity ||
            current.content !== expected.content
          ) {
            return null
          }
          contents.set(expected.path, fallbackContent)
          return { ...expected, content: fallbackContent }
        },
      } as unknown as LearningVaultWriteApi
      const host: LearningGenerationHost = {
        vault,
        vaultWriter,
        isDebugEnabled: () => false,
        agent: {
          stream: stream as LearningGenerationHost['agent']['stream'],
        },
      }
      const events: CardGenerationEvent[] = []

      const result = await generateCardsForChapter({
        host,
        modelId: 'learning-model',
        chapterIndex: 2,
        projectTopic: 'Topic',
        chapterTitle: 'Chapter',
        chapterContract: 'Contract',
        knowledgePath,
        cardsPath,
        level: 'beginner',
        usedCardUuids: new Set(),
        runId: 'run-1',
        projectId: 'project-1',
        chapterId: 'chapter-1',
        onCard: (event) => events.push(event),
      })

      expect(result.status).toBe(expectedStatus)
      expect(events).toHaveLength(1)
      expect(result.cards).toHaveLength(1)
      expect(events[0]).toMatchObject({
        runId: 'run-1',
        projectId: 'project-1',
        chapterId: 'chapter-1',
        chapterIndex: 2,
        cardIndex: 0,
        cardUuid: result.cards[0]?.cardUuid,
      })
      const written = contents.get(cardsPath) ?? ''
      expect(written).toContain(
        `<!--card:${result.cards[0]?.cardUuid} kp:aaaaaaaa-->`,
      )
      expect(written).toContain('A?\n\n---\n\nA!')
      expect(written).not.toContain(CARD_END_MARKER)
      if (retryWithExternalEdit) expect(written).toContain('user edit')
      expect(create).toHaveBeenCalledTimes(preexistingRollbackShell ? 0 : 1)
      expect(stream).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'learning-model',
          capability: 'edit-vault',
        }),
      )
    },
  )

  it('rejects an explicit abort before writing streamed cards', async () => {
    const knowledgePath = 'project/chapter/knowledge.md'
    const cardsPath = 'project/chapter/cards.md'
    const knowledgeIdentity = { path: knowledgePath }
    const createTextIfAbsent = jest.fn()
    const host: LearningGenerationHost = {
      vault: {
        getEntry: () => ({
          kind: 'file',
          path: knowledgePath,
          name: 'knowledge.md',
          ctime: 0,
          mtime: 0,
        }),
      } as unknown as LearningVaultReadApi,
      vaultWriter: {
        readTextSnapshot: async () => ({
          path: knowledgePath,
          content: '## KP <!--kp:aaaaaaaa-->\n\nBody',
          identity: knowledgeIdentity,
        }),
        createTextIfAbsent,
      } as unknown as LearningVaultWriteApi,
      isDebugEnabled: () => false,
      agent: {
        stream: async function* () {
          const text = `${cardBlock('Partial')}${CARD_END_MARKER}\n`
          yield { type: 'text' as const, text, delta: text }
          yield { type: 'aborted' as const }
        },
      },
    }

    await expect(
      generateCardsForChapter({
        host,
        chapterIndex: 0,
        projectTopic: 'Topic',
        chapterTitle: 'Chapter',
        chapterContract: 'Contract',
        knowledgePath,
        cardsPath,
        level: 'beginner',
        usedCardUuids: new Set(),
        runId: 'run',
        projectId: 'project',
        chapterId: 'chapter',
      }),
    ).rejects.toThrow('Card generation aborted: Chapter')
    expect(createTextIfAbsent).not.toHaveBeenCalled()
  })

  it.each([
    ['owned content', false],
    ['externally edited content', true],
  ] as const)('handles cleanup safely for %s', async (_label, externalEdit) => {
    const knowledgePath = 'project/chapter/knowledge.md'
    const cardsPath = 'project/chapter/cards.md'
    const knowledgeFile = { path: knowledgePath }
    const cardsFile = { path: cardsPath }
    const files = new Map<string, object>([[knowledgePath, knowledgeFile]])
    const contents = new Map<string, string>([
      [knowledgePath, '## KP <!--kp:aaaaaaaa-->\n\nBody'],
    ])
    let knowledgeReads = 0
    const readSnapshot = async (
      path: string,
    ): Promise<LearningVaultFileSnapshot | null> => {
      const identity = files.get(path)
      if (!identity) return null
      if (path === knowledgePath) {
        knowledgeReads += 1
        if (knowledgeReads === 3) {
          contents.set(knowledgePath, 'externally changed knowledge')
          if (externalEdit) {
            contents.set(cardsPath, `${contents.get(cardsPath)}user edit\n`)
          }
        }
      }
      return { path, content: contents.get(path) ?? '', identity }
    }
    const revert = jest.fn(
      async (
        created: LearningVaultFileSnapshot,
        expected: LearningVaultFileSnapshot,
        fallbackContent: string,
      ): Promise<LearningVaultFileSnapshot | null> => {
        if (
          created !== expected ||
          contents.get(expected.path) !== expected.content
        ) {
          return null
        }
        contents.set(expected.path, fallbackContent)
        return { ...expected, content: fallbackContent }
      },
    )
    const vaultWriter = {
      readTextSnapshot: readSnapshot,
      createTextIfAbsent: async (path: string, content: string) => {
        if (files.has(path)) return null
        files.set(path, cardsFile)
        contents.set(path, content)
        return { path, content, identity: cardsFile }
      },
      revertOwnedCreatedTextIfUnchanged: revert,
    } as unknown as LearningVaultWriteApi
    const host = {
      vault: {
        getEntry: (path: string) =>
          files.has(path)
            ? {
                kind: 'file' as const,
                path,
                name: path.split('/').at(-1) ?? path,
                ctime: 0,
                mtime: 0,
              }
            : null,
      } as unknown as LearningVaultReadApi,
      vaultWriter,
      isDebugEnabled: () => false,
      agent: {
        stream: async function* () {
          const text = `${cardBlock('A')}${CARD_END_MARKER}\n`
          yield { type: 'text' as const, delta: text, text }
          yield { type: 'completed' as const, text }
        },
      },
    } as LearningGenerationHost

    const generation = generateCardsForChapter({
      host,
      chapterIndex: 0,
      projectTopic: 'Topic',
      chapterTitle: 'Chapter',
      chapterContract: 'Contract',
      knowledgePath,
      cardsPath,
      level: 'beginner',
      usedCardUuids: new Set(),
      runId: 'run',
      projectId: 'project',
      chapterId: 'chapter',
    })

    if (externalEdit) {
      await expect(generation).rejects.toThrow(
        `Card generation failed and cleanup was incomplete: ${cardsPath}; original error: Knowledge file changed during generation: ${knowledgePath}`,
      )
      expect(contents.get(cardsPath)).toContain('user edit')
    } else {
      await expect(generation).rejects.toThrow(
        `Knowledge file changed during generation: ${knowledgePath}`,
      )
      expect(contents.get(cardsPath)).toBe('---\ntitle: Chapter - 卡片\n---\n')
    }
  })
})

describe('cardGenerator validation', () => {
  it('parses the strict draft format', () => {
    expect(
      parseCardDrafts(`## 所有权 <!--kp:aaaaaaaa-->

什么是所有权？

---

值在任一时刻只有一个所有者。`),
    ).toEqual([
      {
        title: '所有权',
        kpUuid: 'aaaaaaaa',
        front: '什么是所有权？',
        back: '值在任一时刻只有一个所有者。',
        startLine: 1,
      },
    ])
  })

  it('keeps empty fields invalid instead of accepting placeholders', () => {
    const entries = parseWrittenCardEntries(`---
title: 测试
---

## <!--card:11111111 kp:aaaaaaaa-->

---`)
    const result = validateWrittenCards(
      entries,
      new Set(['11111111']),
      new Set(['aaaaaaaa']),
    )

    expect(result.valid).toHaveLength(0)
    expect(result.invalid[0]?.errors).toEqual([
      '缺少标题',
      '分隔线前缺少正面内容',
      '分隔线后缺少背面内容',
    ])
  })

  it('rejects duplicate, missing, and unexpected card UUIDs', () => {
    const entries =
      parseWrittenCardEntries(`## A <!--card:11111111 kp:aaaaaaaa-->

A?

---

A

## B <!--card:11111111 kp:aaaaaaaa-->

B?

---

B

## C <!--card:33333333 kp:aaaaaaaa-->

C?

---

C`)
    const result = validateWrittenCards(
      entries,
      new Set(['11111111', '22222222']),
      new Set(['aaaaaaaa']),
    )

    expect(result.valid).toHaveLength(0)
    expect(result.invalid).toEqual([
      expect.objectContaining({
        cardUuid: '11111111',
        errors: ['card UUID 重复'],
      }),
      expect.objectContaining({
        cardUuid: '22222222',
        errors: ['缺少该 card UUID'],
      }),
    ])
    expect(result.discardedCount).toBe(3)
  })
})
