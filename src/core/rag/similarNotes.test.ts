import type { YoloSettings } from '../../settings/schema/setting.types'

import type { RagQueryResult } from './ragEngine'
import {
  aggregateSimilarNotes,
  findSimilarNotes,
  isPathIndexableByKnowledgeBase,
} from './similarNotes'

function row(
  overrides: Partial<RagQueryResult> & { path: string; similarity: number },
): RagQueryResult {
  return {
    id: overrides.id ?? Math.random(),
    path: overrides.path,
    mtime: 0,
    content: overrides.content ?? `chunk of ${overrides.path}`,
    content_hash: null,
    model: 'model-a',
    dimension: 3,
    metadata: overrides.metadata ?? { startLine: 1, endLine: 2 },
    similarity: overrides.similarity,
  }
}

// Only the fields `similarNotes` actually reads. `yolo.baseDir` is left
// unset so `isWithinYoloBaseDir` uses its default base ("YOLO").
const settings = {
  ragOptions: { indexPdf: true },
} as unknown as YoloSettings

describe('aggregateSimilarNotes', () => {
  it('ranks files by their best chunk and keeps snippets in document order', () => {
    const notes = aggregateSimilarNotes(
      [
        row({
          path: 'a.md',
          similarity: 0.5,
          metadata: { startLine: 90, endLine: 95 },
        }),
        row({
          path: 'a.md',
          similarity: 0.9,
          metadata: { startLine: 10, endLine: 15 },
        }),
        row({
          path: 'a.md',
          similarity: 0.7,
          metadata: { startLine: 50, endLine: 55 },
        }),
        row({ path: 'b.md', similarity: 0.8 }),
      ],
      { maxNotes: 6, maxSnippets: 3 },
    )

    expect(notes.map((n) => n.path)).toEqual(['a.md', 'b.md'])
    expect(notes[0].similarity).toBe(0.9)
    expect(notes[0].snippets.map((s) => s.startLine)).toEqual([10, 50, 90])
  })

  it('keeps the strongest snippets, not the first ones', () => {
    const notes = aggregateSimilarNotes(
      [
        row({
          path: 'a.md',
          similarity: 0.1,
          metadata: { startLine: 1, endLine: 2 },
        }),
        row({
          path: 'a.md',
          similarity: 0.9,
          metadata: { startLine: 30, endLine: 31 },
        }),
      ],
      { maxNotes: 6, maxSnippets: 1 },
    )

    expect(notes[0].snippets.map((s) => s.startLine)).toEqual([30])
  })

  it('caps the number of notes', () => {
    const notes = aggregateSimilarNotes(
      [
        row({ path: 'a.md', similarity: 0.9 }),
        row({ path: 'b.md', similarity: 0.8 }),
        row({ path: 'c.md', similarity: 0.7 }),
      ],
      { maxNotes: 2, maxSnippets: 3 },
    )

    expect(notes.map((n) => n.path)).toEqual(['a.md', 'b.md'])
  })
})

describe('isPathIndexableByKnowledgeBase', () => {
  const kb = { include: ['notes'], exclude: ['notes/private'] }

  it('accepts a markdown file inside the include scope', () => {
    expect(isPathIndexableByKnowledgeBase('notes/a.md', kb, settings)).toBe(
      true,
    )
  })

  it('rejects excluded paths, unsupported extensions, and the YOLO base dir', () => {
    expect(
      isPathIndexableByKnowledgeBase('notes/private/a.md', kb, settings),
    ).toBe(false)
    expect(isPathIndexableByKnowledgeBase('notes/a.canvas', kb, settings)).toBe(
      false,
    )
    expect(
      isPathIndexableByKnowledgeBase(
        'YOLO/chats/a.md',
        { ...kb, include: [] },
        settings,
      ),
    ).toBe(false)
  })
})

describe('findSimilarNotes', () => {
  const makeAccess = (
    bases: Array<{
      id: string
      include?: string[]
      exclude?: string[]
      rows: RagQueryResult[] | null
    }>,
  ) => ({
    listKnowledgeBases: () =>
      bases.map((base) => ({
        id: base.id,
        name: base.id,
        description: '',
        include: base.include ?? [],
        exclude: base.exclude ?? [],
      })),
    getRagEngine: (kbId: string) =>
      Promise.resolve({
        findSimilarChunks: () =>
          Promise.resolve(bases.find((b) => b.id === kbId)?.rows ?? null),
      } as never),
  })

  it('merges every knowledge base by default', async () => {
    const outcome = await findSimilarNotes({
      ragAccess: makeAccess([
        { id: 'kb1', rows: [row({ path: 'a.md', similarity: 0.5 })] },
        { id: 'kb2', rows: [row({ path: 'b.md', similarity: 0.9 })] },
      ]),
      settings,
      path: 'source.md',
    })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.notes.map((n) => n.path)).toEqual(['b.md', 'a.md'])
  })

  it('restricts to one knowledge base when scoped', async () => {
    const outcome = await findSimilarNotes({
      ragAccess: makeAccess([
        { id: 'kb1', rows: [row({ path: 'a.md', similarity: 0.5 })] },
        { id: 'kb2', rows: [row({ path: 'b.md', similarity: 0.9 })] },
      ]),
      settings,
      path: 'source.md',
      scopeKbId: 'kb1',
    })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.notes.map((n) => n.path)).toEqual(['a.md'])
  })

  it('falls back to every knowledge base when the scoped one is gone', async () => {
    const outcome = await findSimilarNotes({
      ragAccess: makeAccess([
        { id: 'kb1', rows: [row({ path: 'a.md', similarity: 0.5 })] },
      ]),
      settings,
      path: 'source.md',
      scopeKbId: 'deleted-kb',
    })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.notes.map((n) => n.path)).toEqual(['a.md'])
  })

  it('reports the source as indexable when it falls inside a base scope', async () => {
    const outcome = await findSimilarNotes({
      ragAccess: makeAccess([
        { id: 'kb1', include: ['notes'], rows: null },
        { id: 'kb2', include: ['other'], rows: null },
      ]),
      settings,
      path: 'notes/source.md',
    })

    expect(outcome).toEqual({
      kind: 'source-not-indexed',
      indexableKbIds: ['kb1'],
    })
  })

  it('reports no indexable base when the source is outside every scope', async () => {
    const outcome = await findSimilarNotes({
      ragAccess: makeAccess([{ id: 'kb1', include: ['notes'], rows: null }]),
      settings,
      path: 'elsewhere/source.md',
    })

    expect(outcome).toEqual({ kind: 'source-not-indexed', indexableKbIds: [] })
  })
})
