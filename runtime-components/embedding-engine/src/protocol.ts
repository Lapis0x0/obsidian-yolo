/**
 * Message protocol between the main-thread shim (`entry.ts`) and the inlined
 * inference worker (`worker.ts`). Internal to this component — not part of
 * the host-facing API surface (`EmbeddingEngineComponentApi` in
 * `src/core/runtime-components/contracts.ts`), so it's free to change
 * without touching the host.
 */

export type EmbeddingWorkerSpec = Readonly<{
  dimension: number
  pooling: 'mean' | 'cls' | 'last-token'
  normalize: boolean
  maxTokens: number
  dtype?: 'q8' | 'fp16'
}>

export type EmbeddingWorkerInitRequest = Readonly<{
  type: 'init'
  requestId: number
  /** WASM asset name -> raw bytes (transferred). */
  wasm: Readonly<Record<string, ArrayBuffer>>
  /** Model file name (e.g. `config.json`, `onnx/model_quantized.onnx`) -> raw bytes (transferred). */
  modelFiles: Readonly<Record<string, ArrayBuffer>>
  spec: EmbeddingWorkerSpec
  /**
   * Only `'wasm'` is supported in this release — the JSEP/WebGPU wasm
   * variant is not shipped as a declared asset (see `WASM_ASSET_NAMES`
   * below), so there is nothing for a `'webgpu'` request to load. `entry.ts`
   * rejects a `'webgpu'` `createSession` request before a worker is ever
   * spun up. `dtype` (see `EmbeddingDtype` below) is independent of device —
   * WebGPU support is what's planned to return in a future release, at which
   * point this widens back to `'wasm' | 'webgpu'`.
   */
  device: 'wasm'
  numThreads: number
}>

export type EmbeddingWorkerEmbedRequest = Readonly<{
  type: 'embed'
  requestId: number
  texts: readonly string[]
}>

export type EmbeddingWorkerDisposeRequest = Readonly<{
  type: 'dispose'
  requestId: number
}>

export type EmbeddingWorkerRequest =
  | EmbeddingWorkerInitRequest
  | EmbeddingWorkerEmbedRequest
  | EmbeddingWorkerDisposeRequest

/**
 * Every stage a worker-side failure can be attributed to, threaded through
 * `describeError()` in `worker.ts` so the main thread (and whatever surfaces
 * the error to the user/logs) gets more than a bare message string.
 */
export type EmbeddingWorkerErrorStage =
  | 'install-cache'
  | 'install-wasm'
  | 'load-tokenizer'
  | 'load-model'
  | 'tokenize'
  | 'inference'
  | 'pooling'
  | 'dispose'
  | 'unknown'

export type EmbeddingWorkerErrorInfo = Readonly<{
  name: string
  message: string
  stack?: string
  stage: EmbeddingWorkerErrorStage
  device?: 'wasm'
}>

export type EmbeddingWorkerResponse =
  | Readonly<{
      type: 'init-result'
      requestId: number
      ok: true
      device: 'wasm'
    }>
  | Readonly<{
      type: 'init-result'
      requestId: number
      ok: false
      error: EmbeddingWorkerErrorInfo
    }>
  | Readonly<{
      type: 'embed-result'
      requestId: number
      ok: true
      /** One ArrayBuffer per input text, each a Float32Array's backing buffer (transferred). */
      vectors: readonly ArrayBuffer[]
    }>
  | Readonly<{
      type: 'embed-result'
      requestId: number
      ok: false
      error: EmbeddingWorkerErrorInfo
    }>
  | Readonly<{ type: 'dispose-result'; requestId: number; ok: true }>
  | Readonly<{
      type: 'dispose-result'
      requestId: number
      ok: false
      error: EmbeddingWorkerErrorInfo
    }>

/**
 * The fixed file set a "standard" Transformers.js text-embedding ONNX export
 * carries (HF repos following the Xenova/onnx-community convention). P2's
 * catalog (`src/core/rag/local-embedding/catalog.ts`) must publish exactly
 * these names in each entry's `files` list for `loadModelFile` to satisfy
 * them. `config.json` / `tokenizer.json` are always required; the ONNX
 * weight file(s) are dtype-dependent (see `DTYPE_WEIGHT_FILES` below) so
 * they're declared optional here and each catalog entry brings whichever
 * ones its own `dtype` needs. The rest are optional too (fast tokenizers
 * commonly fold everything into tokenizer.json, so `tokenizer_config.json` /
 * `special_tokens_map.json` are requested best-effort and simply omitted
 * from the worker's cache if missing).
 */
export const REQUIRED_MODEL_FILES: readonly string[] = [
  'config.json',
  'tokenizer.json',
]
export const OPTIONAL_MODEL_FILES: readonly string[] = [
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
  'onnx/model_fp16.onnx',
  'onnx/model_fp16.onnx_data',
]

export type EmbeddingDtype = 'q8' | 'fp16'
/**
 * transformers.js 按 dtype 请求的 ONNX 权重文件名后缀不同
 * （见 @huggingface/transformers 的 DEFAULT_DTYPE_SUFFIX_MAPPING）。
 * catalog 条目必须按自己声明的 dtype 在 files 里带上对应文件。
 */
export const DTYPE_WEIGHT_FILES: Readonly<
  Record<EmbeddingDtype, readonly string[]>
> = {
  q8: ['onnx/model_quantized.onnx'],
  fp16: ['onnx/model_fp16.onnx', 'onnx/model_fp16.onnx_data'],
}

/**
 * Matches `component.config.json`'s declared `assets` names. onnxruntime-web
 * dynamically `import()`s the `.mjs` loader alongside its `.wasm` binary
 * (see `ju()`/`instantiateWasm` in `ort.min.mjs`) — both must be present for
 * the plain-wasm backend to initialize.
 *
 * The JSEP/WebGPU variant (`ort-wasm-simd-threaded.jsep.{wasm,mjs}`, ~21MB)
 * is deliberately not declared here in this release — `device` is `'wasm'`
 * only (see `EmbeddingWorkerInitRequest`), so shipping it would just be
 * unused weight. It returns as a declared asset alongside WebGPU support.
 */
export const WASM_ASSET_NAMES: readonly string[] = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
]
