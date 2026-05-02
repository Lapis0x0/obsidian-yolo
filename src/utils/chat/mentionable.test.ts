/**
 * Tests for serialization / deserialization round-trips and getMentionableKey,
 * focusing on the new optional `pageNumber` field added to MentionableBlock.
 */

import type { TFile } from 'obsidian'

import type { Mentionable, SerializedMentionableBlock } from '../../types/mentionable'

import {
  deserializeMentionable,
  getMentionableKey,
  serializeMentionable,
} from './mentionable'

// ──────────────────────────────────────────────────────────────────────────────
// Minimal mock for TFile / vault
// ──────────────────────────────────────────────────────────────────────────────

function makeMockFile(path: string): TFile {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
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
