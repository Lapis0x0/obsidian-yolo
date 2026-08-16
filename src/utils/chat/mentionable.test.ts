/**
 * Tests for serialization / deserialization round-trips and getMentionableKey,
 * focusing on the new optional `pageNumber` field added to MentionableBlock.
 */

import type { TFile } from 'obsidian'

import type {
  Mentionable,
  SerializedMentionableAssistantQuote,
  SerializedMentionableBlock,
} from '../../types/mentionable'

import {
  deserializeMentionable,
  getMentionableKey,
  serializeMentionable,
} from './mentionable'

// ──────────────────────────────────────────────────────────────────────────────
// Minimal mock for TFile / vault
// ──────────────────────────────────────────────────────────────────────────────

function makeMockFile(path: string): TFile {
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- test mock, not a real TFile instance
  return { path, name: path.split('/').pop() ?? path } as unknown as TFile
}

function makeMockApp(file: TFile | null = null) {
  return {
    vault: {
      getFileByPath: (_p: string) => file,
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// serializeMentionable – MentionableBlock with pageNumber
// ──────────────────────────────────────────────────────────────────────────────

describe('serializeMentionable – block with pageNumber', () => {
  const file = makeMockFile('notes/paper.pdf')

  test('serializes pageNumber when present', () => {
    const mentionable: Mentionable = {
      type: 'block',
      content: 'Selected PDF text',
      file,
      startLine: 0,
      endLine: 0,
      pageNumber: 5,
      source: 'selection-sync',
    }
    const serialized = serializeMentionable(mentionable)
    expect(serialized.type).toBe('block')
    if (serialized.type === 'block') {
      expect(serialized.pageNumber).toBe(5)
    }
  })

  test('serializes without pageNumber for normal markdown blocks', () => {
    const mentionable: Mentionable = {
      type: 'block',
      content: 'Markdown text',
      file,
      startLine: 10,
      endLine: 15,
      source: 'selection-sync',
    }
    const serialized = serializeMentionable(mentionable)
    if (serialized.type === 'block') {
      expect(serialized.pageNumber).toBeUndefined()
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// deserializeMentionable – round-trip for pageNumber
// ──────────────────────────────────────────────────────────────────────────────

describe('deserializeMentionable – block with pageNumber round-trip', () => {
  const file = makeMockFile('notes/paper.pdf')
  const app = makeMockApp(file)

  test('round-trips pageNumber through serialize → deserialize', () => {
    const original: Mentionable = {
      type: 'block',
      content: 'Round-trip content',
      file,
      startLine: 0,
      endLine: 0,
      pageNumber: 7,
      source: 'selection-sync',
    }

    const serialized = serializeMentionable(original)

    const restored = deserializeMentionable(serialized, app as any)

    expect(restored).not.toBeNull()
    expect(restored?.type).toBe('block')
    if (restored?.type === 'block') {
      expect(restored.pageNumber).toBe(7)
      expect(restored.content).toBe('Round-trip content')
    }
  })

  test('round-trips undefined pageNumber (markdown block)', () => {
    const original: Mentionable = {
      type: 'block',
      content: 'Markdown content',
      file,
      startLine: 3,
      endLine: 5,
      source: 'selection',
    }

    const serialized = serializeMentionable(original)

    const restored = deserializeMentionable(serialized, app as any)

    expect(restored?.type).toBe('block')
    if (restored?.type === 'block') {
      expect(restored.pageNumber).toBeUndefined()
      expect(restored.startLine).toBe(3)
      expect(restored.endLine).toBe(5)
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// getMentionableKey – pageNumber makes keys distinct
// ──────────────────────────────────────────────────────────────────────────────

describe('getMentionableKey – block with pageNumber', () => {
  const baseBlock: SerializedMentionableBlock = {
    type: 'block',
    content: 'same content',
    file: 'notes/doc.pdf',
    startLine: 0,
    endLine: 0,
    contentHash: 'abc123',
  }

  test('block without pageNumber has expected key format', () => {
    const key = getMentionableKey(baseBlock)
    expect(key).toBe('block:notes/doc.pdf:0:0:abc123')
  })

  test('block with pageNumber embeds page in key', () => {
    const key = getMentionableKey({ ...baseBlock, pageNumber: 3 })
    expect(key).toBe('block:notes/doc.pdf:0:0:p3:abc123')
  })

  test('different pages produce different keys', () => {
    const key1 = getMentionableKey({ ...baseBlock, pageNumber: 1 })
    const key2 = getMentionableKey({ ...baseBlock, pageNumber: 2 })
    expect(key1).not.toBe(key2)
  })

  test('page 1 and no page produce different keys', () => {
    const keyWithPage = getMentionableKey({ ...baseBlock, pageNumber: 1 })
    const keyWithoutPage = getMentionableKey(baseBlock)
    expect(keyWithPage).not.toBe(keyWithoutPage)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// getMentionableKey – annotationNumber makes keys distinct (PDF multi-quote
// annotation, docs/plans/2026-08-16-pdf-annotation-quotes.md). Two PDF
// annotations that select the same repeated substring on the same page
// otherwise collide on identical file/line/page/contentHash — see bug 3 of
// that plan's review.
// ──────────────────────────────────────────────────────────────────────────────

describe('getMentionableKey – block with annotationNumber', () => {
  const baseBlock: SerializedMentionableBlock = {
    type: 'block',
    content: 'same content',
    file: 'notes/paper.pdf',
    startLine: 0,
    endLine: 0,
    pageNumber: 1,
    contentHash: 'abc123',
  }

  test('block without annotationNumber has the same key format as today (backward compatible)', () => {
    const key = getMentionableKey(baseBlock)
    expect(key).toBe('block:notes/paper.pdf:0:0:p1:abc123')
  })

  test('two annotations with identical file/line/page/contentHash but different annotationNumber get distinct keys', () => {
    const key1 = getMentionableKey({ ...baseBlock, annotationNumber: 1 })
    const key2 = getMentionableKey({ ...baseBlock, annotationNumber: 2 })
    expect(key1).not.toBe(key2)
  })

  test('annotationNumber and no annotationNumber produce different keys', () => {
    const keyWithAnnotation = getMentionableKey({
      ...baseBlock,
      annotationNumber: 1,
    })
    const keyWithoutAnnotation = getMentionableKey(baseBlock)
    expect(keyWithAnnotation).not.toBe(keyWithoutAnnotation)
  })

  test('historical (pre-annotation) blocks without annotationNumber are unaffected by unrelated fields like comment', () => {
    // Deserialized history / existing add-to-sidebar references never set
    // annotationNumber; the key must stay identical regardless of `comment`
    // (which also predates this feature on assistant-quote but is new on
    // block) so their identity never drifts across a reload.
    const key = getMentionableKey({ ...baseBlock, comment: 'unused' })
    expect(key).toBe('block:notes/paper.pdf:0:0:p1:abc123')
  })
})

describe('web selection mentionables', () => {
  test('round-trips through serialize → deserialize', () => {
    const original: Mentionable = {
      type: 'web-selection',
      content: 'Selected web text',
      url: 'https://example.com/article',
      title: 'Example Article',
      pageId: 'page_abcdefgh_1234abcd',
      source: 'web-selection-sync',
    }

    const serialized = serializeMentionable(original)
    expect(serialized.type).toBe('web-selection')

    const restored = deserializeMentionable(serialized, makeMockApp() as any)

    expect(restored).not.toBeNull()
    expect(restored?.type).toBe('web-selection')
    if (restored?.type === 'web-selection') {
      expect(restored.content).toBe('Selected web text')
      expect(restored.url).toBe('https://example.com/article')
      expect(restored.title).toBe('Example Article')
      expect(restored.source).toBe('web-selection-sync')
      expect(restored.contentHash).toBeDefined()
    }
  })

  test('keys are based on URL and selected content', () => {
    const serialized = serializeMentionable({
      type: 'web-selection',
      content: 'same selected text',
      url: 'https://example.com/article',
      title: 'Example Article',
      source: 'web-selection-sync',
    })

    expect(serialized.type).toBe('web-selection')
    if (serialized.type === 'web-selection') {
      expect(getMentionableKey(serialized)).toBe(
        `web-selection:https://example.com/article:${serialized.contentHash}`,
      )
    }
  })
})

describe('assistant quote annotations', () => {
  const quote: Mentionable = {
    type: 'assistant-quote',
    id: 'annotation-1',
    annotationNumber: 4,
    conversationId: 'conversation-1',
    messageId: 'assistant-1',
    content: 'Selected reply text',
    comment: 'Rewrite this more directly.',
    selector: {
      start: 10,
      end: 29,
      exact: 'Selected reply text',
      prefix: 'Context: ',
      suffix: ' after',
    },
  }

  test('round-trips the comment and selector', () => {
    const serialized = serializeMentionable(quote)
    const restored = deserializeMentionable(serialized, makeMockApp() as any)

    expect(restored).toMatchObject(quote)
  })

  test('uses the annotation id as stable identity', () => {
    const serialized = serializeMentionable(
      quote,
    ) as SerializedMentionableAssistantQuote
    expect(getMentionableKey(serialized)).toBe('assistant-quote:annotation-1')
    expect(
      getMentionableKey({ ...serialized, comment: 'Updated feedback' }),
    ).toBe('assistant-quote:annotation-1')
  })

  test('distinguishes legacy quotes at different rendered positions', () => {
    const base: SerializedMentionableAssistantQuote = {
      type: 'assistant-quote',
      conversationId: 'conversation-1',
      messageId: 'assistant-1',
      content: 'Repeated text',
      contentHash: 'same-hash',
    }
    expect(
      getMentionableKey({
        ...base,
        selector: { start: 0, end: 13, exact: 'Repeated text' },
      }),
    ).not.toBe(
      getMentionableKey({
        ...base,
        selector: { start: 20, end: 33, exact: 'Repeated text' },
      }),
    )
  })
})
