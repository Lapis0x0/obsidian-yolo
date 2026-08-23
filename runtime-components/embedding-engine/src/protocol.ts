/**
 * Message protocol between the main-thread shim (`entry.ts`) and the inlined
 * inference worker (`worker.ts`). Internal to this component — not part of
 * the host-facing API surface (`EmbeddingEngineComponentApi` in
 * `src/core/runtime-components/contracts.ts`), so it's free to change
 * without touching the host.
 */

export type EmbeddingWorkerSpec = Readonly<{
  dimension: number
  pooling: 'mean' | 'cls'
  normalize: boolean
  maxTokens: number
}>

export type EmbeddingWorkerInitRequest = Readonly<{
  type: 'init'
  requestId: number
  /** WASM asset name -> raw bytes (transferred). */
  wasm: Readonly<Record<string, ArrayBuffer>>
  /** Model file name (e.g. `config.json`, `onnx/model_quantized.onnx`) -> raw bytes (transferred). */
  modelFiles: Readonly<Record<string, ArrayBuffer>>
  spec: EmbeddingWorkerSpec
  device?: 'wasm' | 'webgpu'
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

export type EmbeddingWorkerResponse =
  | Readonly<{
      type: 'init-result'
      requestId: number
      ok: true
      device: 'wasm' | 'webgpu'
    }>
  | Readonly<{
      type: 'init-result'
      requestId: number
      ok: false
      error: string
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
      error: string
    }>
  | Readonly<{ type: 'dispose-result'; requestId: number; ok: true }>

/**
 * The fixed file set a "standard" Transformers.js text-embedding ONNX export
 * carries (HF repos following the Xenova/onnx-community convention). P2's
 * catalog (`src/core/rag/local-embedding/catalog.ts`) must publish exactly
 * these names in each entry's `files` list for `loadModelFile` to satisfy
 * them. `config.json` / `tokenizer.json` / the q8 ONNX weight are required;
 * the rest are optional (fast tokenizers commonly fold everything into
 * tokenizer.json, so `tokenizer_config.json` / `special_tokens_map.json` are
 * requested best-effort and simply omitted from the worker's cache if
 * missing).
 */
export const REQUIRED_MODEL_FILES: readonly string[] = [
  'config.json',
  'tokenizer.json',
  'onnx/model_quantized.onnx',
]
export const OPTIONAL_MODEL_FILES: readonly string[] = [
  'tokenizer_config.json',
  'special_tokens_map.json',
]

/**
 * Matches `component.config.json`'s declared `assets` names. onnxruntime-web
 * dynamically `import()`s the `.mjs` loader alongside its `.wasm` binary
 * (see `ju()`/`instantiateWasm` in `ort.min.mjs`) — both must be present for
 * either the plain-wasm or the WebGPU/JSEP backend to initialize.
 */
export const WASM_ASSET_NAMES: readonly string[] = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]
