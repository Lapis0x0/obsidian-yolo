/// <reference lib="webworker" />

// Must be evaluated before Transformers.js and onnxruntime-web — keep this
// import first; see the module for why.
import './browserEnv'

import {
  AutoModel,
  AutoTokenizer,
  type Tensor,
  env,
  mean_pooling,
} from '@huggingface/transformers'

import { toErrorInfo } from './errorInfo'
import { matchDeclaredModelFile } from './modelFileMatcher'
import type {
  EmbeddingWorkerDisposeRequest,
  EmbeddingWorkerEmbedRequest,
  EmbeddingWorkerErrorStage,
  EmbeddingWorkerInitRequest,
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
  EmbeddingWorkerSpec,
} from './protocol'
import { createRequestQueue } from './requestQueue'

declare const self: DedicatedWorkerGlobalScope

/**
 * Arbitrary but fixed `pretrained_model_name_or_path` handed to
 * `AutoTokenizer.from_pretrained` / `AutoModel.from_pretrained`. Never
 * resolves to a real HF repo — `installCustomCache` intercepts every file
 * Transformers.js tries to load for it (see `modelFileMatcher.ts` for why
 * the exact value doesn't matter, only its presence as a path segment).
 */
const MODEL_ID = 'yolo-local-embedding-model'

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>
type Model = Awaited<ReturnType<typeof AutoModel.from_pretrained>>

type Session = Readonly<{
  tokenizer: Tokenizer
  model: Model
  spec: EmbeddingWorkerSpec
  device: 'wasm'
}>

let session: Session | null = null
let disposed = false
const wasmObjectUrls: string[] = []
const queue = createRequestQueue()

function post(
  response: EmbeddingWorkerResponse,
  transfer: Transferable[] = [],
): void {
  self.postMessage(response, transfer)
}

function postError(
  base: { requestId: number },
  type: 'init-result' | 'embed-result' | 'dispose-result',
  error: unknown,
  stage: EmbeddingWorkerErrorStage,
  device?: 'wasm',
): void {
  post({
    type,
    requestId: base.requestId,
    ok: false,
    error: toErrorInfo(error, stage, device),
  } as EmbeddingWorkerResponse)
}

/**
 * Redirects Transformers.js's model-file loading through injected bytes
 * instead of the network. `getModelFile` in Transformers.js tries the cache
 * (`customCache.match`) with both a "local path" and a "remote URL" key
 * before ever consulting `env.allowLocalModels`/`env.allowRemoteModels`, so
 * a cache hit here means the network path is never reached regardless of
 * those flags — but Transformers.js's own startup assertion still requires
 * `env.allowLocalModels=true` when `env.allowRemoteModels=false` (otherwise
 * it throws "both local and remote models are disabled" before ever trying
 * the cache), so that flag combination below is intentional, not a network
 * escape hatch.
 *
 * Returns a `release()` callback: once `AutoTokenizer.from_pretrained` and
 * `AutoModel.from_pretrained` both resolve, every file they need has
 * already been read out of `files` (both calls are fully awaited before
 * `release()` runs), so the raw injected bytes — which can be a
 * non-trivial fraction of a large model's total memory footprint — no
 * longer need to stay resident for the life of the session.
 */
function installCustomCache(
  modelFiles: Readonly<Record<string, ArrayBuffer>>,
): () => void {
  let files: Map<string, Uint8Array> | null = new Map(
    Object.entries(modelFiles).map(([name, buffer]) => [
      name,
      new Uint8Array(buffer),
    ]),
  )
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.useBrowserCache = false
  env.useFSCache = false
  env.useFS = false
  env.useCustomCache = true
  env.customCache = {
    async match(request: RequestInfo | string): Promise<Response | undefined> {
      if (!files) return undefined
      const url = typeof request === 'string' ? request : request.url
      const name = matchDeclaredModelFile(url, files.keys())
      if (name === undefined) return undefined
      const bytes = files.get(name)
      if (!bytes) return undefined
      // Each declared file is matched by exactly one candidate string per
      // `getModelFile` call (the local-path candidate always hits first),
      // so handing back the live backing bytes without copying is safe:
      // no other in-flight `match()` result aliases the same buffer.
      return new Response(bytes)
    },
    async put(): Promise<void> {
      // No-op: every file the worker needs was injected upfront in `init`;
      // there is nothing left to persist after a (guaranteed) cache hit.
    },
  } as typeof env.customCache
  return () => {
    files = null
  }
}

const wasmUrlCache = new Map<string, string>()

function urlForWasmAsset(
  wasm: Readonly<Record<string, ArrayBuffer>>,
  name: string,
): string {
  const cached = wasmUrlCache.get(name)
  if (cached) return cached
  const buffer = wasm[name]
  if (!buffer) throw new Error(`Missing WASM asset "${name}"`)
  // onnxruntime-web `import()`s the `.mjs` loader (must be a real
  // JavaScript MIME type for a module Blob URL) and `fetch()`s the `.wasm`
  // binary.
  const type = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'
  const url = URL.createObjectURL(new Blob([buffer], { type }))
  wasmObjectUrls.push(url)
  wasmUrlCache.set(name, url)
  return url
}

/**
 * onnxruntime-web's `env.wasm.wasmPaths` takes a single `{ wasm, mjs }` pair
 * (`WasmFilePaths` in `onnxruntime-common`'s `env.d.ts`) — NOT a
 * filename-keyed map, despite the shape being easy to mistake for one. Only
 * the plain-wasm build variant is shipped in this release (see
 * `WASM_ASSET_NAMES` in `protocol.ts`); the JSEP/WebGPU variant
 * (`ort-wasm-simd-threaded.jsep.{wasm,mjs}`) returns alongside WebGPU
 * device support in a future release.
 */
function installWasmPaths(
  wasm: Readonly<Record<string, ArrayBuffer>>,
  numThreads: number,
): void {
  const wasmPaths = {
    wasm: urlForWasmAsset(wasm, 'ort-wasm-simd-threaded.wasm'),
    mjs: urlForWasmAsset(wasm, 'ort-wasm-simd-threaded.mjs'),
  }
  const onnx = env.backends.onnx as unknown as {
    wasm: {
      wasmPaths: { wasm: string; mjs: string }
      numThreads: number
      proxy: boolean
      simd: boolean
    }
  }
  onnx.wasm.wasmPaths = wasmPaths
  onnx.wasm.numThreads = numThreads
  // We already run inside a dedicated Worker; onnxruntime-web's own "proxy"
  // mode would spawn a *second*, nested Worker to run WASM off the calling
  // thread, which is both unnecessary here and a separate bundling problem
  // (it loads its own worker script by URL). Disabled.
  onnx.wasm.proxy = false
  onnx.wasm.simd = true
}

async function handleInit(request: EmbeddingWorkerInitRequest): Promise<void> {
  let releaseModelBytes: (() => void) | null = null
  try {
    releaseModelBytes = installCustomCache(request.modelFiles)
  } catch (error) {
    postError(request, 'init-result', error, 'install-cache')
    return
  }

  let tokenizer: Tokenizer
  try {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)
  } catch (error) {
    releaseModelBytes()
    postError(request, 'init-result', error, 'load-tokenizer')
    return
  }

  let model: Model
  try {
    installWasmPaths(request.wasm, request.numThreads)
    model = await AutoModel.from_pretrained(MODEL_ID, {
      device: 'wasm',
      dtype: request.spec.dtype ?? 'q8',
    })
  } catch (error) {
    releaseModelBytes()
    postError(request, 'init-result', error, 'load-model', 'wasm')
    return
  }

  releaseModelBytes()
  session = { tokenizer, model, spec: request.spec, device: 'wasm' }
  post({
    type: 'init-result',
    requestId: request.requestId,
    ok: true,
    device: 'wasm',
  })
}

async function handleEmbed(
  request: EmbeddingWorkerEmbedRequest,
): Promise<void> {
  const active = session
  if (!active) {
    postError(
      request,
      'embed-result',
      new Error('Embedding session is not initialized'),
      'inference',
    )
    return
  }
  const { tokenizer, model, spec, device } = active
  try {
    const inputs: { attention_mask: Tensor } = tokenizer([...request.texts], {
      padding: true,
      truncation: true,
      max_length: spec.maxTokens,
    })

    const outputs: {
      last_hidden_state?: Tensor
      logits?: Tensor
      token_embeddings?: Tensor
    } = await model(inputs)
    let result =
      outputs.last_hidden_state ?? outputs.logits ?? outputs.token_embeddings
    if (!result) {
      throw new Error('Model produced no usable output tensor')
    }

    if (spec.pooling === 'mean') {
      result = mean_pooling(result, inputs.attention_mask)
    } else if (spec.pooling === 'last-token') {
      // Positional index, not attention-mask-aware — only correct when the
      // tokenizer pads on the left (every row's real last token then lands
      // at index -1 regardless of its length). Catalog entries using this
      // pooling must ship a `tokenizer_config.json` with `padding_side:
      // "left"` (see catalog.test.ts's per-entry assertion for this).
      result = result.slice(null, -1)
    } else {
      result = result.slice(null, 0)
    }
    if (spec.normalize) result = result.normalize(2, -1)

    const nested = result.tolist() as number[][]
    if (nested.length !== request.texts.length) {
      throw new Error(
        `Embedding worker returned ${nested.length} vectors for ${request.texts.length} input texts`,
      )
    }
    const vectors = nested.map((row, index) => {
      const vector = Float32Array.from(row)
      if (vector.length !== spec.dimension) {
        throw new Error(
          `Embedding dimension mismatch at index ${index}: expected ${spec.dimension}, got ${vector.length}`,
        )
      }
      return vector.buffer
    })
    post(
      { type: 'embed-result', requestId: request.requestId, ok: true, vectors },
      vectors,
    )
  } catch (error) {
    postError(request, 'embed-result', error, 'inference', device)
  }
}

async function handleDispose(
  request: EmbeddingWorkerDisposeRequest,
): Promise<void> {
  const active = session
  session = null
  try {
    if (active) await active.model.dispose()
    for (const url of wasmObjectUrls.splice(0)) URL.revokeObjectURL(url)
    disposed = true
    post({ type: 'dispose-result', requestId: request.requestId, ok: true })
  } catch (error) {
    disposed = true
    postError(request, 'dispose-result', error, 'dispose', active?.device)
  }
}

self.onmessage = (event: MessageEvent<EmbeddingWorkerRequest>): void => {
  const request = event.data
  if (disposed && request.type !== 'dispose') {
    postError(
      request,
      request.type === 'init' ? 'init-result' : 'embed-result',
      new Error('Embedding worker session is disposed'),
      'unknown',
    )
    return
  }
  void queue.enqueue(() => {
    if (request.type === 'init') return handleInit(request)
    if (request.type === 'embed') return handleEmbed(request)
    return handleDispose(request)
  })
}
