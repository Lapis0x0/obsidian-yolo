import type { YoloSettings } from '../../settings/schema/setting.types'
import { matchesIncludeExcludeScope } from '../../utils/scope-match'
import { isWithinYoloBaseDir } from '../paths/yoloPaths'

import type { RagKnowledgeAccess } from './ragAccess'
import type { RagQueryResult } from './ragEngine'
import { mergeRagQueryResults } from './ragQueryMerge'

/** Cards shown in the panel. Fixed — the panel has no "show more". */
export const SIMILAR_NOTES_MAX_NOTES = 6
/** Matched passages kept per card, revealed by the card's expand arrow. */
export const SIMILAR_NOTES_MAX_SNIPPETS = 3
/**
 * Chunk-level over-fetch before aggregating to files: one note can occupy
 * several of the top chunks, so ranking `MAX_NOTES` chunks would routinely
 * yield fewer than `MAX_NOTES` distinct notes.
 */
export const SIMILAR_NOTES_CHUNK_LIMIT = 60
/**
 * No similarity floor. Cosine scales differ per embedding model (some
 * cluster around 0.2, others around 0.8), so any fixed threshold would
 * silently empty the panel for some models. Ranking plus the fixed card
 * count carries the signal instead — see the design doc's "no percentages"
 * decision.
 */
export const SIMILAR_NOTES_MIN_SIMILARITY = 0

/**
 * Standard deviations above the knowledge base's background similarity at
 * which a result reads as barely related, and as strongly related. Measured
 * across a real vault: genuinely related notes land at 3-5σ, thin ones at
 * ~2.5σ. Expressed in σ rather than raw cosine on purpose — cosine's scale is
 * a property of the embedding model, σ is not.
 */
const STRENGTH_Z_FLOOR = 1.5
const STRENGTH_Z_CEILING = 4
/** Faintest a shown result is drawn: still visible, clearly not a match. */
const STRENGTH_MIN = 0.15

/**
 * How far above background a similarity sits, in standard deviations. Without
 * a baseline (an index too small to sample) there is nothing to normalize
 * against, so everything reads as mid-strength rather than pretending.
 */
export function zScore(
  similarity: number,
  baseline: { mean: number; std: number } | null,
): number {
  if (!baseline || baseline.std <= 0) {
    return (STRENGTH_Z_FLOOR + STRENGTH_Z_CEILING) / 2
  }
  return (similarity - baseline.mean) / baseline.std
}

/**
 * A z-score as a 0-1 display strength. This is deliberately *not* normalized
 * against the best result in the list: doing that pins the top card to full
 * strength whatever its absolute quality, so a set of six weak matches looks
 * exactly like a set of six strong ones.
 */
export function strengthFromZScore(z: number): number {
  const span = STRENGTH_Z_CEILING - STRENGTH_Z_FLOOR
  const clamped = Math.max(0, Math.min(1, (z - STRENGTH_Z_FLOOR) / span))
  return STRENGTH_MIN + clamped * (1 - STRENGTH_MIN)
}

/** A chunk row carrying its baseline-normalized display strength. */
export type ScoredChunk = RagQueryResult & { strength: number }

export type SimilarNoteSnippet = {
  content: string
  /** Raw cosine — kept for debugging; nothing user-facing reads it. */
  similarity: number
  /** 0-1 display strength, normalized against the corpus baseline. */
  strength: number
  startLine: number
  endLine: number
  page?: number
}

export type SimilarNote = {
  path: string
  /** The note's best chunk similarity — what the list is ranked by. */
  similarity: number
  /** 0-1 display strength of that best chunk. */
  strength: number
  snippets: SimilarNoteSnippet[]
}

export type SimilarNotesOutcome =
  | { kind: 'ready'; notes: SimilarNote[] }
  /**
   * No knowledge base in range holds vectors for the source note, so there
   * is no query vector at all. `indexableKbIds` separates the two reasons
   * the panel must word differently: non-empty means the note *does* fall
   * inside those bases' scope and simply hasn't been indexed yet (offer to
   * index it); empty means it falls outside every base's scope (send the
   * user to knowledge base settings).
   */
  | { kind: 'source-not-indexed'; indexableKbIds: string[] }

/** True when `settings.embeddingModelId` still resolves to a configured model. */
export function isEmbeddingModelConfigured(settings: YoloSettings): boolean {
  return settings.embeddingModels.some(
    (model) => model.id === settings.embeddingModelId,
  )
}

/**
 * Whether a knowledge base would index `path` at all — the same predicate
 * `VectorManager.listIndexableFiles` applies (extension, YOLO base
 * directory, include/exclude), minus the vault lookup the caller already
 * did.
 */
export function isPathIndexableByKnowledgeBase(
  path: string,
  knowledgeBase: { include: string[]; exclude: string[] },
  settings: YoloSettings,
): boolean {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  const isSupported =
    extension === 'md' || (extension === 'pdf' && settings.ragOptions.indexPdf)
  if (!isSupported) return false
  if (isWithinYoloBaseDir(path, settings)) return false
  return matchesIncludeExcludeScope(
    path,
    knowledgeBase.include,
    knowledgeBase.exclude,
  )
}

/**
 * Collapses chunk rows into one card per file: a file ranks by its single
 * best chunk, and keeps its strongest snippets — displayed in document
 * order, because inside one note reading order beats score order.
 */
export function aggregateSimilarNotes(
  rows: readonly ScoredChunk[],
  options: { maxNotes: number; maxSnippets: number },
): SimilarNote[] {
  const byPath = new Map<string, ScoredChunk[]>()
  for (const row of rows) {
    const existing = byPath.get(row.path)
    if (existing) existing.push(row)
    else byPath.set(row.path, [row])
  }

  const notes: SimilarNote[] = []
  for (const [path, pathRows] of byPath) {
    const ranked = [...pathRows].sort((a, b) => b.strength - a.strength)
    const snippets = ranked
      .slice(0, options.maxSnippets)
      .sort((a, b) => a.metadata.startLine - b.metadata.startLine)
      .map((row) => ({
        content: row.content,
        similarity: row.similarity,
        strength: row.strength,
        startLine: row.metadata.startLine,
        endLine: row.metadata.endLine,
        page: row.metadata.page,
      }))
    notes.push({
      path,
      similarity: ranked[0].similarity,
      strength: ranked[0].strength,
      snippets,
    })
  }

  return notes
    .sort((a, b) => b.strength - a.strength)
    .slice(0, options.maxNotes)
}

/**
 * "Which notes are similar to this one", across the knowledge bases in
 * range. Costs no embedding call: every base reuses the source note's own
 * stored chunk vectors (see `RAGEngine.findSimilarChunks`).
 *
 * `scopeKbIds` of `undefined` — the default — means every configured base,
 * and keeps meaning that as bases are added: "all" is a rule, not a snapshot
 * of the ids that existed when the user picked it. Ids whose bases no longer
 * exist are dropped rather than failing, since ids live in settings and can
 * outlive their base; a selection that ends up empty degrades to every base,
 * so the panel never silently searches nothing.
 */
export async function findSimilarNotes({
  ragAccess,
  settings,
  path,
  scopeKbIds,
}: {
  ragAccess: RagKnowledgeAccess
  settings: YoloSettings
  path: string
  scopeKbIds?: string[]
}): Promise<SimilarNotesOutcome> {
  const allKnowledgeBases = ragAccess.listKnowledgeBases()
  const selected = scopeKbIds
    ? allKnowledgeBases.filter((kb) => scopeKbIds.includes(kb.id))
    : []
  const knowledgeBases = selected.length > 0 ? selected : allKnowledgeBases

  const rowGroups: ScoredChunk[][] = []
  // Sequential on purpose: each base loads its own in-memory vector index on
  // first query, and this panel stays open, so serializing keeps the load
  // peak to one base at a time.
  for (const kb of knowledgeBases) {
    const engine = await ragAccess.getRagEngine(kb.id)
    const found = await engine.findSimilarChunks({
      path,
      limit: SIMILAR_NOTES_CHUNK_LIMIT,
      minSimilarity: SIMILAR_NOTES_MIN_SIMILARITY,
    })
    if (found === null) continue
    // Normalize inside the base that produced the row: each knowledge base
    // has its own background level, and only the normalized score is
    // comparable across them.
    rowGroups.push(
      found.rows.map((row) => ({
        ...row,
        strength: strengthFromZScore(zScore(row.similarity, found.baseline)),
      })),
    )
  }

  if (rowGroups.length === 0) {
    return {
      kind: 'source-not-indexed',
      indexableKbIds: knowledgeBases
        .filter((kb) => isPathIndexableByKnowledgeBase(path, kb, settings))
        .map((kb) => kb.id),
    }
  }

  const merged = mergeRagQueryResults(
    rowGroups,
    SIMILAR_NOTES_CHUNK_LIMIT,
    (row) => row.strength,
  )
  return {
    kind: 'ready',
    notes: aggregateSimilarNotes(merged, {
      maxNotes: SIMILAR_NOTES_MAX_NOTES,
      maxSnippets: SIMILAR_NOTES_MAX_SNIPPETS,
    }),
  }
}
