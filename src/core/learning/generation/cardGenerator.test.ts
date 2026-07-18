import { TFile } from 'obsidian'

import type YoloPlugin from '../../../main'

import {
  CARD_END_MARKER,
  CardStreamParser,
  generateCardsForChapter,
  parseCardDrafts,
  parseWrittenCardEntries,
  validateWrittenCards,
} from './cardGenerator'
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
    ['generated', false],
    ['partial', true],
  ] as const)(
    'keeps published UUIDs identical in events, result, and disk for %s output',
    async (expectedStatus, interrupted) => {
      const knowledgePath = 'project/chapter/knowledge.md'
      const cardsPath = 'project/chapter/cards.md'
      const knowledgeFile = Object.assign(new TFile(), { path: knowledgePath })
      const files = new Map<string, object>([[knowledgePath, knowledgeFile]])
      const contents = new Map<string, string>([
        [knowledgePath, '## KP <!--kp:aaaaaaaa-->\n\nBody'],
      ])
      const create = jest.fn(async (path: string, content: string) => {
        const file = Object.assign(new TFile(), { path })
        files.set(path, file)
        contents.set(path, content)
        return file
      })
      const stream = jest.fn(async function* () {
        const text = `${cardBlock('A')}${CARD_END_MARKER}\n`
        yield { type: 'text' as const, delta: text, text }
        if (interrupted) {
          yield { type: 'error' as const, message: 'stream interrupted' }
        } else {
          yield { type: 'completed' as const, text }
        }
      })
      const plugin = {
        app: {
          vault: {
            getAbstractFileByPath: (path: string) => files.get(path) ?? null,
            getMarkdownFiles: () => [],
            read: async (file: { path: string }) =>
              contents.get(file.path) ?? '',
            cachedRead: async (file: { path: string }) =>
              contents.get(file.path) ?? '',
            create,
            modify: async (file: { path: string }, content: string) => {
              contents.set(file.path, content)
            },
            delete: async (file: { path: string }) => {
              files.delete(file.path)
              contents.delete(file.path)
            },
          },
        },
        agent: {
          stream,
        },
      } as unknown as YoloPlugin
      const events: CardGenerationEvent[] = []

      const result = await generateCardsForChapter({
        plugin,
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
      expect(written).toMatch(/^---\ntitle: Chapter\n---/)
      expect(written).toContain(
        `<!--card:${result.cards[0]?.cardUuid} kp:aaaaaaaa-->`,
      )
      expect(written).toContain('A?\n\n---\n\nA!')
      expect(written).not.toContain(CARD_END_MARKER)
      expect(create).toHaveBeenCalledTimes(1)
      expect(stream).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'learning-model' }),
      )
    },
  )
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
      'missing title',
      'missing front content before the separator',
      'missing back content after the separator',
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
        errors: ['duplicate card UUID'],
      }),
      expect.objectContaining({
        cardUuid: '22222222',
        errors: ['missing this card UUID'],
      }),
    ])
    expect(result.discardedCount).toBe(3)
  })
})

describe('generateCardsForChapter output language', () => {
  it('uses the user language and inherits it via contract and knowledge', async () => {
    const knowledgePath = 'project/chapter/knowledge.md'
    const cardsPath = 'project/chapter/cards.md'
    const knowledgeFile = Object.assign(new TFile(), { path: knowledgePath })
    const files = new Map<string, object>([[knowledgePath, knowledgeFile]])
    const contents = new Map<string, string>([
      [
        knowledgePath,
        '## KP <!--kp:aaaaaaaa-->\n\nknowledge body carries the language',
      ],
    ])
    const stream = jest.fn(async function* () {
      const text = `${cardBlock('A')}${CARD_END_MARKER}\n`
      yield { type: 'text' as const, delta: text, text }
      yield { type: 'completed' as const, text }
    })
    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: (path: string) => files.get(path) ?? null,
          getMarkdownFiles: () => [],
          read: async (file: { path: string }) => contents.get(file.path) ?? '',
          cachedRead: async (file: { path: string }) =>
            contents.get(file.path) ?? '',
          create: async (path: string, content: string) => {
            const file = Object.assign(new TFile(), { path })
            files.set(path, file)
            contents.set(path, content)
            return file
          },
          modify: async (file: { path: string }, content: string) => {
            contents.set(file.path, content)
          },
        },
      },
      agent: { stream },
    } as unknown as YoloPlugin

    await generateCardsForChapter({
      plugin,
      modelId: 'learning-model',
      chapterIndex: 0,
      projectTopic: 'Python',
      chapterTitle: 'Chapter',
      chapterContract: 'contract text carries the language',
      knowledgePath,
      cardsPath,
      level: 'beginner',
      usedCardUuids: new Set(),
      runId: 'run-1',
      projectId: 'project-1',
      chapterId: 'chapter-1',
    })

    const call = (stream.mock.calls as unknown[][])[0]?.[0]
    const request = call as { systemPromptOverride: string }
    // The card stage sends its prompt as a user message rather than a
    // top-level prompt field, so inspect the serialized request.
    const serialized = JSON.stringify(call)
    expect(request.systemPromptOverride).toContain('language used by the user')
    // Language propagation: both the chapter contract and the knowledge.md
    // content (in the user's language) must reach the card request.
    expect(serialized).toContain('contract text carries the language')
    expect(serialized).toContain('knowledge body carries the language')
  })
})
