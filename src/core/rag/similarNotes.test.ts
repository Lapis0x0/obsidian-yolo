import type { YoloSettings } from '../../settings/schema/setting.types'

import type { RagQueryResult } from './ragEngine'
import {
  type ScoredChunk,
  aggregateSimilarNotes,
  findSimilarNotes,
  isPathIndexableByKnowledgeBase,
  strengthFromZScore,
  zScore,
} from './similarNotes'

/**
 * Aggregation ranks by `strength`; these fixtures keep it equal to
 * `similarity` so the expectations read as the raw scores they set.
 */
function row(
  overrides: Partial<RagQueryResult> & { path: string; similarity: number },
): ScoredChunk {
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
    strength: overrides.similarity,
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

describe('strengthFromZScore', () => {
  it('bottoms out below the floor and saturates above the ceiling', () => {
    expect(strengthFromZScore(0)).toBeCloseTo(0.15)
    expect(strengthFromZScore(1.5)).toBeCloseTo(0.15)
    expect(strengthFromZScore(4)).toBeCloseTo(1)
    expect(strengthFromZScore(9)).toBeCloseTo(1)
  })

  it('rises monotonically between the anchors', () => {
    expect(strengthFromZScore(2)).toBeGreaterThan(strengthFromZScore(1.6))
    expect(strengthFromZScore(3)).toBeGreaterThan(strengthFromZScore(2))
  })

  it('does not pin the best of a weak set to full strength', () => {
    // The whole point of the change: a set topping out at 2 sigma must look
    // weak, where a list-relative scale would have drawn it full.
    expect(strengthFromZScore(2)).toBeLessThan(0.5)
  })
})

describe('zScore', () => {
  it('measures distance above background in standard deviations', () => {
    expect(zScore(0.8, { mean: 0.35, std: 0.1 })).toBeCloseTo(4.5)
  })

  it('falls back to mid-strength when there is no usable baseline', () => {
    expect(zScore(0.9, null)).toBe(zScore(0.1, null))
    expect(zScore(0.9, { mean: 0.3, std: 0 })).toBe(zScore(0.1, null))
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
      rows: ScoredChunk[] | null
      baseline?: { mean: number; std: number } | null
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
        findSimilarChunks: () => {
          const base = bases.find((b) => b.id === kbId)
          if (!base?.rows) return Promise.resolve(null)
          // Default baseline maps the fixtures' 0.5-0.9 similarities into
          // the middle of the strength ramp, so ordering survives and scope
          // expectations stay about scope rather than about clamping.
          return Promise.resolve({
            rows: base.rows,
            baseline: base.baseline ?? { mean: 0, std: 0.25 },
          })
        },
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
      scopeKbIds: ['kb1'],
    })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.notes.map((n) => n.path)).toEqual(['a.md'])
  })

  it('searches exactly the selected subset of knowledge bases', async () => {
    const outcome = await findSimilarNotes({
      ragAccess: makeAccess([
        { id: 'kb1', rows: [row({ path: 'a.md', similarity: 0.5 })] },
        { id: 'kb2', rows: [row({ path: 'b.md', similarity: 0.9 })] },
        { id: 'kb3', rows: [row({ path: 'c.md', similarity: 0.7 })] },
      ]),
      settings,
      path: 'source.md',
      scopeKbIds: ['kb1', 'kb3'],
    })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.notes.map((n) => n.path)).toEqual(['c.md', 'a.md'])
  })

  it('drops ids whose knowledge base is gone but keeps the survivors', async () => {
    const outcome = await findSimilarNotes({
      ragAccess: makeAccess([
        { id: 'kb1', rows: [row({ path: 'a.md', similarity: 0.5 })] },
        { id: 'kb2', rows: [row({ path: 'b.md', similarity: 0.9 })] },
      ]),
      settings,
      path: 'source.md',
      scopeKbIds: ['kb1', 'deleted-kb'],
    })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.notes.map((n) => n.path)).toEqual(['a.md'])
  })

  it('falls back to every knowledge base when no selected id survives', async () => {
    const outcome = await findSimilarNotes({
      ragAccess: makeAccess([
        { id: 'kb1', rows: [row({ path: 'a.md', similarity: 0.5 })] },
      ]),
      settings,
      path: 'source.md',
      scopeKbIds: ['deleted-kb'],
    })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.notes.map((n) => n.path)).toEqual(['a.md'])
  })

  it('falls back to every knowledge base when the selection is empty', async () => {
    const outcome = await findSimilarNotes({
      ragAccess: makeAccess([
        { id: 'kb1', rows: [row({ path: 'a.md', similarity: 0.5 })] },
        { id: 'kb2', rows: [row({ path: 'b.md', similarity: 0.9 })] },
      ]),
      settings,
      path: 'source.md',
      scopeKbIds: [],
    })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    expect(outcome.notes.map((n) => n.path)).toEqual(['b.md', 'a.md'])
  })

  it('ranks by strength relative to each base, not by raw similarity', async () => {
    const outcome = await findSimilarNotes({
      ragAccess: makeAccess([
        {
          id: 'kb1',
          rows: [row({ path: 'weak.md', similarity: 0.9 })],
          // A base where everything scores high: 0.9 is barely above its own
          // background, so it is a poor match despite the large cosine.
          baseline: { mean: 0.8, std: 0.05 },
        },
        {
          id: 'kb2',
          rows: [row({ path: 'strong.md', similarity: 0.5 })],
          // A base where 0.5 is far above background — a genuine match.
          baseline: { mean: 0.1, std: 0.1 },
        },
      ]),
      settings,
      path: 'source.md',
    })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') return
    // Raw similarity would put weak.md (0.9) first.
    expect(outcome.notes.map((n) => n.path)).toEqual(['strong.md', 'weak.md'])
    expect(outcome.notes[0].strength).toBeGreaterThan(outcome.notes[1].strength)
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
