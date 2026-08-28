import { ragChunkKey } from './ragEngine'

type RagRowForMerge = {
  path: string
  similarity: number
  metadata: { page?: number; startLine: number; endLine: number }
}

/**
 * Merges several knowledge bases' raw query rows into one ranked list: sort
 * by similarity (desc), dedupe by exact chunk position — two knowledge bases
 * whose scopes overlap can each return the identical chunk with identical
 * similarity — then cap to `limit`.
 *
 * Dedup happens *before* truncation and on the *raw* rows (using
 * `ragChunkKey`, the same key `dedupeRagQueryResults` uses for a single
 * knowledge base's own PDF-page duplicates) so a duplicate never displaces a
 * genuinely distinct lower-similarity chunk, and so two different chunks on
 * the same PDF page are never mistaken for the same chunk. Every
 * cross-knowledge-base merge site (`vault_search`, the bash `search`
 * command, and `$db.search`) must call this instead of rolling its own
 * sort+slice — see the Codex review that found `$db.search` skipping dedup
 * entirely and `vault_search` deduping on the already-page-collapsed display
 * shape, which silently over-merged distinct PDF chunks.
 */
export function mergeRagQueryResults<T extends RagRowForMerge>(
  rowGroups: T[][],
  limit: number,
  /**
   * What to rank by. Defaults to the raw similarity, which is comparable
   * across knowledge bases only when they share an embedding model *and* a
   * corpus — the similar-notes panel overrides it with a baseline-normalized
   * score so bases with different background similarity can be interleaved.
   */
  scoreOf: (row: T) => number = (row) => row.similarity ?? 0,
): T[] {
  const sorted = rowGroups.flat().sort((a, b) => scoreOf(b) - scoreOf(a))
  const seen = new Set<string>()
  const result: T[] = []
  for (const row of sorted) {
    const key = ragChunkKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(row)
    if (result.length >= limit) break
  }
  return result
}
