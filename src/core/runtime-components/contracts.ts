export type RuntimeComponentId =
  | 'tokenizer'
  | 'pdf-engine'
  | 'bash-engine'
  | 'embedding-engine'

export type TokenizerComponentApi = Readonly<{
  count(text: string): number
  dispose(): void
}>

export type PdfSliceErrorKind =
  | 'invalid-range'
  | 'load-failed'
  | 'too-many-pages'
  | 'too-large'

export type PdfEngineComponentApi = Readonly<{
  extractPages(
    bytes: Uint8Array,
    options: { maxPages: number; signal?: AbortSignal },
  ): Promise<{
    totalPages: number
    pages: { page: number; text: string }[]
  }>
  getPageCount(bytes: Uint8Array, signal?: AbortSignal): Promise<number>
  extractPageText(
    bytes: Uint8Array,
    page: number,
    signal?: AbortSignal,
  ): Promise<string>
  renderPages(
    bytes: Uint8Array,
    range: { startPage: number; endPage?: number },
    signal?: AbortSignal,
  ): Promise<{
    totalPages: number
    rendered: { page: number; dataUrl: string }[]
  }>
  slicePages(
    bytes: Uint8Array,
    range: { startPage: number; endPage?: number },
  ): Promise<{
    bytes: Uint8Array
    totalSourcePages: number
    actualStart: number
    actualEnd: number
  }>
  dispose(): void
}>

export type VectorMetaData = {
  startLine: number
  endLine: number
  page?: number
}

export type VectorInsert = {
  id?: number
  path: string
  mtime: number
  content: string
  content_hash?: string | null
  model: string
  dimension: number
  embedding?: number[] | null
  metadata: VectorMetaData
}

export type VectorSelect = {
  id: number
  path: string
  mtime: number
  content: string
  content_hash: string | null
  model: string
  dimension: number
  metadata: VectorMetaData
}

export type VectorStore = Readonly<{
  getFileMtimes(modelId: string): Promise<Readonly<Record<string, number>>>
  listChunksForPaths(
    modelId: string,
    paths: string[],
  ): Promise<
    Array<
      Pick<VectorSelect, 'id' | 'path' | 'mtime' | 'content_hash' | 'metadata'>
    >
  >
  /**
   * Every stored chunk vector for one file, in insertion order. Vectors are
   * L2-normalized at write time (`insertVectors`), so callers can pool them
   * directly. Empty when the file has no rows for this model — i.e. it is
   * not indexed in this knowledge base.
   */
  listVectorsForPath(modelId: string, path: string): Promise<Float32Array[]>
  deleteVectorsByIds(ids: number[]): Promise<void>
  deleteVectorsByPaths(modelId: string, paths: string[]): Promise<void>
  bumpMtimeByIds(updates: Array<{ id: number; mtime: number }>): Promise<void>
  insertVectors(data: VectorInsert[]): Promise<void>
  truncateModel(modelId: string): Promise<void>
  clearVectorsByModelIds(modelIds: string[]): Promise<void>
  performSimilaritySearch(
    queryVector: number[],
    embeddingModel: { id: string; dimension: number },
    options: {
      minSimilarity: number
      limit: number
      /**
       * Declarative scan predicate applied while walking the in-memory
       * index (never a function, so it stays serializable across a future
       * Worker boundary). `exclude` uses the same equal-or-prefix rule
       * semantics as `workspaceScope.ts`'s `matchesRule` and always wins
       * over `files`/`folders` — a row matching any exclude rule is
       * dropped even if it also matches an explicit include entry.
       */
      scope?: { files: string[]; folders: string[]; exclude?: string[] }
    },
  ): Promise<Array<VectorSelect & { similarity: number }>>
  /**
   * How similar two *unrelated* chunks in this index typically are: the mean
   * and standard deviation of cosine similarity over a random sample of chunk
   * pairs. Cosine has no model-independent meaning — one embedding model's
   * "unrelated" sits at 0.37, another's at 0.8 — so a caller that wants to
   * say "this result is genuinely related" needs this corpus-level baseline
   * to normalize against.
   *
   * Deliberately a property of (model, index) rather than of a query: a
   * per-query baseline rewards a note for being uniformly far from
   * everything, which inflates the score of its merely-least-bad match.
   *
   * `null` when the index holds fewer than two vectors for the model, i.e.
   * there is no pair to sample.
   */
  getSimilarityBaseline(embeddingModel: {
    id: string
    dimension: number
  }): Promise<{ mean: number; std: number } | null>
  getEmbeddingStats(): Promise<
    Array<{ model: string; rowCount: number; vectorBytes: number }>
  >
}>

/**
 * Minimal filesystem surface the bash-engine component needs from its host.
 * Deliberately host-agnostic (no Obsidian/Vault types) so the component stays
 * decoupled from vault semantics — the host adapter (see
 * `src/core/agent/bash/vaultBashFileSystem.ts`) owns path mounting and vault
 * mapping; this type only describes the callback shapes it must implement.
 *
 * Content mutation (`writeFile`/`appendFile`/`cp`) is intentionally absent:
 * the component always rejects those internally and never calls out to the
 * host for them — content edits stay on the `fs_edit`/`fs_write` tools.
 */
export type BashFsStat = Readonly<{
  isFile: boolean
  isDirectory: boolean
  /** Milliseconds since epoch. */
  mtimeMs: number
  size: number
}>

export type BashFsDirentEntry = Readonly<{
  name: string
  isFile: boolean
  isDirectory: boolean
}>

export type BashFsRmResult = Readonly<{
  targetKind: 'file' | 'folder'
}>

export type BashFsCallbacks = Readonly<{
  readFile(path: string): Promise<string>
  readFileBuffer(path: string): Promise<Uint8Array>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<BashFsStat>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<BashFsDirentEntry[]>
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<BashFsRmResult>
  mv(oldPath: string, newPath: string): Promise<void>
  /** All known paths under the mount, for glob/find matching. */
  getAllPaths(): string[]
}>

export type BashDangerousOperationKind = 'rm' | 'mv'

/**
 * Host-provided gate consulted before an `rm`/`mv` target actually touches
 * the filesystem. The component collects every target belonging to a single
 * command invocation before calling this once, then performs the operation
 * per target only if it resolves `true`. Policy (which tier is active,
 * whether to prompt the user) is entirely the host's decision — the
 * component has no notion of approval tiers.
 */
export type BashConfirmDangerousOperation = (
  kind: BashDangerousOperationKind,
  targets: readonly string[],
) => Promise<boolean>

/**
 * One line of `search` command output. `path` is vault-relative; the
 * component owns mapping it back to `/vault/...` display form, mirroring how
 * `BashFsCallbacks` paths work.
 */
export type BashSearchResultEntry = Readonly<{
  kind: 'file' | 'dir' | 'content'
  path: string
  startLine?: number
  endLine?: number
  /** PDF hit: source page (1-based), shown instead of line numbers. */
  page?: number
  snippet?: string
}>

export type BashSearchOutcome =
  | Readonly<{
      status: 'success'
      results: readonly BashSearchResultEntry[]
      /** Non-fatal note (e.g. RAG-unavailable fallback), printed to stderr. */
      notice?: string
    }>
  | Readonly<{ status: 'error'; message: string }>

/**
 * Host-provided semantic retrieval behind the custom `search` command. The
 * component only parses arguments and formats output; ranking (hybrid
 * RAG + keyword fusion, keyword fallback) is entirely the host's concern.
 * `scopePath` is vault-relative (undefined = whole vault).
 */
export type BashSearchCallback = (
  request: Readonly<{
    query: string
    scopePath?: string
    maxResults: number
    /** `--kb <name>`: restrict to one knowledge base by name (case-
     * insensitive). Undefined = merge results across every knowledge base. */
    knowledgeBase?: string
  }>,
) => Promise<BashSearchOutcome>

export type BashSessionOptions = Readonly<{
  fs: BashFsCallbacks
  confirmDangerousOperation: BashConfirmDangerousOperation
  /**
   * When provided, registers the custom `search` command (semantic vault
   * retrieval). Available in read-only sessions too — search is a read.
   */
  search?: BashSearchCallback
  cwd?: string
  signal?: AbortSignal
  /**
   * When true, the session structurally cannot perform path writes: `mkdir`,
   * `mv`, `rm`, and `rmdir` are excluded from the command set entirely
   * (command not found) and the underlying `fs.mkdir`/`fs.rm`/`fs.mv`
   * callbacks are never invoked, even if some other command reaches them
   * unexpectedly. `confirmDangerousOperation` is never consulted in this
   * mode — there is nothing to approve. Defaults to false.
   */
  readOnly?: boolean
}>

export type BashSessionResult = Readonly<{
  stdout: string
  stderr: string
  exitCode: number
}>

export type BashSession = Readonly<{
  exec(command: string): Promise<BashSessionResult>
  dispose(): void
}>

export type BashEngineComponentApi = Readonly<{
  createSession(options: BashSessionOptions): BashSession
  dispose(): void
}>

/**
 * Result of `EmbeddingEngineComponentApi.probeEnvironment()`, checked before
 * `createSession` is attempted. Synchronous and side-effect free — it only
 * inspects capability flags (`crossOriginIsolated`, `navigator.gpu`, WASM
 * SIMD support) already available on `globalThis`, mirroring the old PGlite
 * component's "capability probe before install-time failure" precedent.
 */
export type EmbeddingEngineEnvironmentProbe =
  | Readonly<{ ok: true; webgpu: boolean; threads: number }>
  | Readonly<{
      ok: false
      reason: 'no-wasm-simd' | 'no-worker' | 'no-response'
    }>

export type EmbeddingEngineSpec = Readonly<{
  dimension: number
  pooling: 'mean' | 'cls' | 'last-token'
  normalize: boolean
  maxTokens: number
  dtype?: 'q8' | 'fp16'
}>

/**
 * Callbacks injected by the host so the component never touches the network
 * or the vault directly. `loadWasm` reads a runtime-component asset (see
 * `readRuntimeComponentAsset`); `loadModelFile` reads a file from the
 * `LocalEmbeddingModelManager`-owned model directory (host-only, P2). Both
 * receive `createSession`'s own `signal` so a caller that aborts while
 * assets/model files are still loading (network fetch, vault read) can
 * cancel that work instead of it running to completion unobserved.
 */
export type EmbeddingEngineCreateSessionOptions = Readonly<{
  loadWasm(name: string, signal?: AbortSignal): Promise<Uint8Array>
  loadModelFile(file: string, signal?: AbortSignal): Promise<Uint8Array>
  spec: EmbeddingEngineSpec
  /**
   * `'webgpu'` is kept in the type for forward compatibility but is not
   * supported in this release — `createSession` rejects it rather than
   * silently falling back to `'wasm'`, since the component doesn't ship the
   * JSEP/WebGPU wasm variant as a declared asset. Omit this option (or pass
   * `'wasm'` explicitly) until WebGPU support returns in a future release.
   * `dtype` (on `EmbeddingEngineSpec` above) is independent of device and
   * already supported on `'wasm'`.
   */
  device?: 'wasm' | 'webgpu'
  signal?: AbortSignal
}>

export type EmbeddingSession = Readonly<{
  /** Returns vectors already pooled/normalized per `EmbeddingEngineSpec`. */
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
  /**
   * Resolves once the underlying ORT/WebGPU session and Worker have been
   * torn down. Async because real cleanup is: ask the Worker to dispose the
   * model, wait for its ack (bounded by a short timeout), then terminate —
   * not just `Worker.terminate()`, which reclaims the JS realm without ever
   * running the library's own resource-release lifecycle.
   */
  dispose(): Promise<void>
}>

export type EmbeddingEngineComponentApi = Readonly<{
  probeEnvironment(): EmbeddingEngineEnvironmentProbe
  createSession(
    options: EmbeddingEngineCreateSessionOptions,
  ): Promise<EmbeddingSession>
  /** Disposes every session still open under this engine instance. */
  dispose(): Promise<void>
}>

export type RuntimeComponentApiMap = {
  tokenizer: TokenizerComponentApi
  'pdf-engine': PdfEngineComponentApi
  'bash-engine': BashEngineComponentApi
  'embedding-engine': EmbeddingEngineComponentApi
}

export type RuntimeComponentDefinition<
  I extends RuntimeComponentId = RuntimeComponentId,
> = Readonly<{
  id: I
  create(): RuntimeComponentApiMap[I] | Promise<RuntimeComponentApiMap[I]>
}>

export type RuntimeComponentLease<I extends RuntimeComponentId> = Readonly<{
  api: RuntimeComponentApiMap[I]
  release(): void
}>
