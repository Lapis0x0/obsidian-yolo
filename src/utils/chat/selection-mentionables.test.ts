/**
 * Tests for the shared annotation-number pool (see docs/plans/2026-08-16-pdf-
 * annotation-quotes.md, architecture decision A): `getMaxAssistantQuoteNumber`
 * must scan every mentionable kind that participates in "批注N" numbering —
 * not just `assistant-quote` — so assistant replies and PDF selections can
 * never be assigned the same number within one input.
 */

import type { TFile } from 'obsidian'

import type { Mentionable, MentionableBlock } from '../../types/mentionable'

import { getMaxAssistantQuoteNumber } from './selection-mentionables'

function makeMockFile(path: string): TFile {
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- test mock, not a real TFile instance
  return { path, name: path.split('/').pop() ?? path } as unknown as TFile
}

function pdfQuoteBlock(
  annotationNumber: number | undefined,
  overrides: Partial<MentionableBlock> = {},
): MentionableBlock {
  return {
    type: 'block',
    content: 'Selected PDF text',
    file: makeMockFile('notes/paper.pdf'),
    startLine: 0,
    endLine: 0,
    pageNumber: 1,
    source: 'selection-pinned',
    comment: '',
    annotationNumber,
    ...overrides,
  }
}

function assistantQuote(annotationNumber: number | undefined): Mentionable {
  return {
    type: 'assistant-quote',
    id: `quote-${String(annotationNumber)}`,
    annotationNumber,
    conversationId: 'conversation-1',
    messageId: 'assistant-1',
    content: 'Some reply text',
  }
}

describe('getMaxAssistantQuoteNumber', () => {
  test('returns 0 for an empty pool', () => {
    expect(getMaxAssistantQuoteNumber([])).toBe(0)
  })

  test('ignores plain blocks without annotationNumber', () => {
    const plainBlock: MentionableBlock = {
      type: 'block',
      content: 'markdown text',
      file: makeMockFile('notes/doc.md'),
      startLine: 1,
      endLine: 2,
      source: 'selection-pinned',
    }
    expect(getMaxAssistantQuoteNumber([plainBlock])).toBe(0)
  })

  test('scans assistant-quote mentionables', () => {
    const mentionables = [assistantQuote(1), assistantQuote(3)]
    expect(getMaxAssistantQuoteNumber(mentionables)).toBe(3)
  })

  test('scans PDF-quote blocks', () => {
    const mentionables = [pdfQuoteBlock(2)]
    expect(getMaxAssistantQuoteNumber(mentionables)).toBe(2)
  })

  test('shares one continuous pool across assistant quotes and PDF quotes', () => {
    const mentionables = [
      assistantQuote(1),
      pdfQuoteBlock(2),
      assistantQuote(3),
    ]
    expect(getMaxAssistantQuoteNumber(mentionables)).toBe(3)
    // The next assignment (max + 1) must not collide with any existing
    // number regardless of which kind holds the highest one.
    expect(getMaxAssistantQuoteNumber(mentionables) + 1).toBe(4)
  })

  test('a PDF quote can hold the highest number in the pool', () => {
    const mentionables = [assistantQuote(1), pdfQuoteBlock(5)]
    expect(getMaxAssistantQuoteNumber(mentionables)).toBe(5)
  })

  test('legacy assistant quotes without annotationNumber still reserve a slot per quote', () => {
    const mentionables = [assistantQuote(undefined), assistantQuote(undefined)]
    expect(getMaxAssistantQuoteNumber(mentionables)).toBe(2)
  })
})
