export type RuntimeComponentId = 'tokenizer' | 'pdf-engine' | 'pglite-engine'

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
      scope?: { files: string[]; folders: string[] }
    },
  ): Promise<Array<VectorSelect & { similarity: number }>>
  getEmbeddingStats(): Promise<
    Array<{ model: string; rowCount: number; totalDataBytes: number }>
  >
}>

export type PgliteRuntimeResources = Readonly<{
  fsBundle: Blob
  pgliteWasmModule: WebAssembly.Module
  initdbWasmModule: WebAssembly.Module
  vectorExtensionBlob: Blob
  vectorExtensionBundlePath: URL
}>

export type PgliteEngineSession = Readonly<{
  vectorStore: VectorStore
  migrationChanged: boolean
  cleanupLegacyStaging(): Promise<number>
  vacuum(): Promise<void>
  dump(): Promise<Blob>
  close(): Promise<void>
}>

export type PgliteEngineComponentApi = Readonly<{
  createSession(options: {
    resources: PgliteRuntimeResources
    snapshot?: Blob
  }): Promise<PgliteEngineSession>
  dispose(): Promise<void>
}>

export type RuntimeComponentApiMap = {
  tokenizer: TokenizerComponentApi
  'pdf-engine': PdfEngineComponentApi
  'pglite-engine': PgliteEngineComponentApi
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
