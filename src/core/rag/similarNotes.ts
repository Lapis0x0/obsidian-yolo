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

export type SimilarNoteSnippet = {
  content: string
  similarity: number
  startLine: number
  endLine: number
  page?: number
}

export type SimilarNote = {
  path: string
  /** The note's best chunk similarity — what the list is ranked by. */
  similarity: number
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
  rows: readonly RagQueryResult[],
  options: { maxNotes: number; maxSnippets: number },
): SimilarNote[] {
  const byPath = new Map<string, RagQueryResult[]>()
  for (const row of rows) {
    const existing = byPath.get(row.path)
    if (existing) existing.push(row)
    else byPath.set(row.path, [row])
  }

  const notes: SimilarNote[] = []
  for (const [path, pathRows] of byPath) {
    const ranked = [...pathRows].sort((a, b) => b.similarity - a.similarity)
    const snippets = ranked
      .slice(0, options.maxSnippets)
      .sort((a, b) => a.metadata.startLine - b.metadata.startLine)
      .map((row) => ({
        content: row.content,
        similarity: row.similarity,
        startLine: row.metadata.startLine,
        endLine: row.metadata.endLine,
        page: row.metadata.page,
      }))
    notes.push({ path, similarity: ranked[0].similarity, snippets })
  }

  return notes
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, options.maxNotes)
}

/**
 * "Which notes are similar to this one", across the knowledge bases in
 * range. Costs no embedding call: every base reuses the source note's own
 * stored chunk vectors (see `RAGEngine.findSimilarChunks`).
 *
 * `scopeKbId` of `undefined` — the default — means every configured base;
 * a base id that no longer exists degrades to the same thing rather than
 * failing, since the id only lives in settings and can outlive its base.
 */
export async function findSimilarNotes({
  ragAccess,
  settings,
  path,
  scopeKbId,
}: {
  ragAccess: RagKnowledgeAccess
  settings: YoloSettings
  path: string
  scopeKbId?: string
}): Promise<SimilarNotesOutcome> {
  const allKnowledgeBases = ragAccess.listKnowledgeBases()
  const selected = scopeKbId
    ? allKnowledgeBases.filter((kb) => kb.id === scopeKbId)
    : []
  const knowledgeBases = selected.length > 0 ? selected : allKnowledgeBases

  const rowGroups: RagQueryResult[][] = []
  // Sequential on purpose: each base loads its own in-memory vector index on
  // first query, and this panel stays open, so serializing keeps the load
  // peak to one base at a time.
  for (const kb of knowledgeBases) {
    const engine = await ragAccess.getRagEngine(kb.id)
    const rows = await engine.findSimilarChunks({
      path,
      limit: SIMILAR_NOTES_CHUNK_LIMIT,
      minSimilarity: SIMILAR_NOTES_MIN_SIMILARITY,
    })
    if (rows === null) continue
    rowGroups.push(rows)
  }

  if (rowGroups.length === 0) {
    return {
      kind: 'source-not-indexed',
      indexableKbIds: knowledgeBases
        .filter((kb) => isPathIndexableByKnowledgeBase(path, kb, settings))
        .map((kb) => kb.id),
    }
  }

  const merged = mergeRagQueryResults(rowGroups, SIMILAR_NOTES_CHUNK_LIMIT)
  return {
    kind: 'ready',
    notes: aggregateSimilarNotes(merged, {
      maxNotes: SIMILAR_NOTES_MAX_NOTES,
      maxSnippets: SIMILAR_NOTES_MAX_SNIPPETS,
    }),
  }
}
