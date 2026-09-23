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

/** `[x, y]`. PDF user space (y up) or viewport CSS pixels (y down). */
export type PdfPoint = readonly [x: number, y: number]

/** Two opposite corners in PDF user space, in any order. */
export type PdfRect = readonly [x1: number, y1: number, x2: number, y2: number]

/**
 * Obsidian's native `#page=N&selection=a,b,c,d` tuple: `a`/`c` are the start
 * and end text-layer span indices (`data-idx`, the span's index among the
 * page's text content items), `b`/`d` the character offsets within those
 * spans; `d` is exclusive.
 */
export type PdfTextSelectionTuple = readonly [
  startIndex: number,
  startOffset: number,
  endIndex: number,
  endOffset: number,
]

export type PdfTextSelection = Readonly<{
  pageNumber: number
  /** The selected text, `\n` at the page's line breaks, Unicode-normalized. */
  text: string
  /**
   * One quadrilateral per visual line, 8 numbers each — top-left, top-right,
   * bottom-left, bottom-right as seen on screen — in PDF user space (the
   * order PDF Highlight annotations use).
   */
  quadPoints: readonly number[]
  tuple: PdfTextSelectionTuple
}>

export type PdfTask<T> = Readonly<{
  /** Rejects with an `AbortError` `DOMException` once cancelled. */
  promise: Promise<T>
  cancel(): void
}>

export type PdfTextLayer = Readonly<{
  pageNumber: number
  /**
   * The part of `range` inside this layer, or null when none of it is.
   * A selection spanning pages is described one layer at a time.
   */
  describeRange(range: Range): PdfTextSelection | null
  /** The DOM range a tuple names in this layer, or null when it names none. */
  createRange(tuple: PdfTextSelectionTuple): Range | null
  /** Re-lays the existing spans out for a new scale without refetching text. */
  setScale(scale: number): void
  /** Cancels a pending build and empties the container. */
  destroy(): void
}>

/** One text content item of a page — one text-layer span. */
export type PdfTextItem = Readonly<{
  /** The item's text exactly as the span holds it (not normalized). */
  text: string
  /** A line ends after this item. */
  endsLine: boolean
}>

export type PdfEnginePage = Readonly<{
  pageNumber: number
  /** Viewport size at scale 1 (PDF units, page rotation applied). */
  width: number
  height: number
  rotation: 0 | 90 | 180 | 270
  /**
   * Renders the page at `scale` CSS pixels per PDF unit. The canvas backing
   * store is sized to `scale * pixelRatio` (pixel ratio defaults to the
   * canvas window's `devicePixelRatio`, and is lowered if the canvas would
   * be too large; the effective ratio is returned); CSS sizing stays with
   * the caller. The canvas is only touched once rendering succeeds, so it
   * keeps its previous picture while a re-render is pending or cancelled.
   * A new render into the same canvas cancels the previous one.
   */
  render(
    options: Readonly<{
      canvas: HTMLCanvasElement
      scale: number
      pixelRatio?: number
    }>,
  ): PdfTask<Readonly<{ pixelRatio: number }>>
  /**
   * Builds the page's selectable text layer into `container` (emptied
   * first), sized and positioned for `scale` exactly as `render` draws it;
   * the container is expected to sit over the rendered page at the same
   * CSS size. Spans carry `data-idx` in Obsidian's native numbering.
   */
  renderTextLayer(
    options: Readonly<{ container: HTMLElement; scale: number }>,
  ): PdfTask<PdfTextLayer>
  /** PNG bytes of `rect` (PDF user space) rendered at `scale`. */
  renderRegion(
    rect: PdfRect,
    options: Readonly<{ scale: number }>,
  ): Promise<ArrayBuffer>
  toViewportPoint(point: PdfPoint, scale: number): PdfPoint
  toPdfPoint(point: PdfPoint, scale: number): PdfPoint
  /** Frees the page's operator list and decoded images once no render of it
   * is in flight (pdf.js `PDFPageProxy.cleanup`); the page stays usable. */
  cleanup(): void
  /**
   * The page's text, one entry per text-layer span in `data-idx` order — so
   * an entry's index and a character offset into its text are the
   * coordinates a selection tuple names. Fetched once per page and kept.
   */
  getTextItems(): Promise<readonly PdfTextItem[]>
}>

export type PdfEngineDocument = Readonly<{
  pageCount: number
  getPage(pageNumber: number): Promise<PdfEnginePage>
  destroy(): Promise<void>
}>

/**
 * A standard PDF annotation to write into a document. Geometry is PDF user
 * space of the page, exactly as `describeRange` / `toPdfPoint` give it —
 * the page's own rotation and box offsets are the viewer's business.
 */
export type PdfAnnotationInput = Readonly<
  (
    | {
        /** A text highlight (`/Highlight`), painted with a multiply blend. */
        type: 'highlight'
        /** Eight numbers per line: top-left, top-right, bottom-left,
         * bottom-right as the text reads (PDF `/QuadPoints` order). */
        quadPoints: readonly number[]
      }
    | {
        /** A rectangle outline (`/Square`) around `rect`. */
        type: 'square'
        rect: PdfRect
        /** Stroke width in PDF units; default 1. Drawn outside `rect`. */
        borderWidth?: number
      }
  ) & {
    /** 1-based. */
    page: number
    /** `#rrggbb`. */
    color: string
    /** The annotation's note (`/Contents`). */
    contents?: string
    /** The note's author (`/T`). */
    author?: string
    /** A name unique on the page (`/NM`), e.g. the caller's own id. */
    id?: string
    /** ISO 8601 (`/CreationDate`, `/M`). */
    createdAt?: string
    modifiedAt?: string
  }
>

export type PdfEngineComponentApi = Readonly<{
  /** A long-lived document for interactive use; the caller destroys it. */
  openDocument(bytes: Uint8Array): Promise<PdfEngineDocument>
  /**
   * A new PDF: `bytes` with `annotations` added after each page's existing
   * ones, every one carrying its own appearance stream. `bytes` is not
   * modified. Rejects on an annotation it cannot write and on a document it
   * cannot rewrite (encrypted, damaged).
   */
  addAnnotations(
    bytes: Uint8Array,
    annotations: readonly PdfAnnotationInput[],
  ): Promise<Uint8Array>
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
  /** Also destroys every document still open. */
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

export type BashSessionOptions = Readonly<{
  fs: BashFsCallbacks
  confirmDangerousOperation: BashConfirmDangerousOperation
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
 * `LocalEmbeddingModelManager`-owned model directory (host-only). Both
 * receive `createSession`'s own `signal` so a caller that aborts while
 * assets/model files are still loading (network fetch, vault read) can
 * cancel that work instead of it running to completion unobserved.
 */
export type EmbeddingEngineCreateSessionOptions = Readonly<{
  loadWasm(name: string, signal?: AbortSignal): Promise<Uint8Array>
  loadModelFile(file: string, signal?: AbortSignal): Promise<Uint8Array>
  spec: EmbeddingEngineSpec
  /**
   * Defaults to `'wasm'`. A `'webgpu'` session that fails to initialize
   * rejects instead of falling back to `'wasm'` — choosing a device is the
   * caller's decision. Only worthwhile for fp16 weights: q8 on WebGPU is
   * slower than on wasm.
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
