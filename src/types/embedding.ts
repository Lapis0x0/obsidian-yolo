export type EmbeddingModelClient = {
  id: string
  dimension: number
  /**
   * `kind` distinguishes a query embedding from a document/chunk embedding
   * for models whose HF model card requires different task-instruction
   * prefixes for each (e.g. E5's `"query: "` / `"passage: "` — see
   * `core/rag/local-embedding/catalog.ts`). Remote providers ignore it.
   * `ragEngine.ts` passes `'query'`; `VectorManager.ts` passes `'document'`.
   */
  getEmbedding: (
    text: string,
    options?: { kind?: 'query' | 'document' },
  ) => Promise<number[]>
  /**
   * Present only for stateful clients (currently: local embedding models —
   * see `core/rag/local-embedding/client.ts`) that hold a live Worker
   * session and runtime-component lease between calls. Callers that
   * discard an `EmbeddingModelClient` (settings change, RAG engine
   * rebuild/model switch — see `ragEngine.ts`) must call this so the
   * session is released immediately rather than left to its own idle
   * timeout.
   */
  dispose?: () => void | Promise<void>
  /**
   * Present only for local embedding clients — tears down the live Worker
   * session immediately without invalidating the client (unlike `dispose`,
   * a subsequent `getEmbedding` call transparently recreates a session).
   * Callers that abort/cancel an in-progress index run should call this so
   * a heavy model's session doesn't sit at full memory for the rest of its
   * idle-teardown window (`IDLE_DISPOSE_MS` in `local-embedding/client.ts`)
   * after the work it was loaded for stopped.
   */
  releaseIdleSession?: () => void | Promise<void>
}

export type EmbeddingDbStats = {
  model: string
  rowCount: number
  /** `rowCount * dimension * 4` — the on-disk float32 vector payload's estimated size in bytes. */
  vectorBytes: number
}
