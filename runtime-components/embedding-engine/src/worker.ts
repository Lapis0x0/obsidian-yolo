/// <reference lib="webworker" />

import { env, pipeline } from '@huggingface/transformers'

import type {
  EmbeddingWorkerDisposeRequest,
  EmbeddingWorkerEmbedRequest,
  EmbeddingWorkerInitRequest,
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
  EmbeddingWorkerSpec,
} from './protocol'

declare const self: DedicatedWorkerGlobalScope

// A minimal function returned by `pipeline('feature-extraction', ...)`; typed
// narrowly here instead of importing Transformers.js's full pipeline types,
// which vary by task and aren't worth threading through this file.
type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean' | 'cls'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>

let extractor: FeatureExtractor | null = null
let spec: EmbeddingWorkerSpec | null = null
const wasmObjectUrls: string[] = []

function post(
  response: EmbeddingWorkerResponse,
  transfer: Transferable[] = [],
): void {
  self.postMessage(response, transfer)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
 */
function installCustomCache(
  modelFiles: Readonly<Record<string, ArrayBuffer>>,
): void {
  const files = new Map<string, Uint8Array>(
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
      const url = typeof request === 'string' ? request : request.url
      for (const [name, bytes] of files) {
        if (url.endsWith(name)) return new Response(bytes.slice())
      }
      return undefined
    },
    async put(): Promise<void> {
      // No-op: every file the worker needs was injected upfront in `init`;
      // there is nothing left to persist after a (guaranteed) cache hit.
    },
  } as typeof env.customCache
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
 * filename-keyed map, despite the shape being easy to mistake for one. The
 * caller must pick which build variant that pair points at: the JSEP build
 * (`ort-wasm-simd-threaded.jsep.{wasm,mjs}`) carries the WebGPU/WebNN
 * execution-provider glue and is required whenever WebGPU is requested; the
 * plain build is used otherwise.
 */
function installWasmPaths(
  wasm: Readonly<Record<string, ArrayBuffer>>,
  numThreads: number,
  device: 'wasm' | 'webgpu',
): void {
  const suffix = device === 'webgpu' ? '.jsep' : ''
  const wasmPaths = {
    wasm: urlForWasmAsset(wasm, `ort-wasm-simd-threaded${suffix}.wasm`),
    mjs: urlForWasmAsset(wasm, `ort-wasm-simd-threaded${suffix}.mjs`),
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
  try {
    installCustomCache(request.modelFiles)

    const requestedDevice = request.device ?? 'wasm'
    let resolvedDevice = requestedDevice
    installWasmPaths(request.wasm, request.numThreads, requestedDevice)
    try {
      extractor = (await pipeline(
        'feature-extraction',
        'yolo-local-embedding-model',
        {
          device: requestedDevice,
          dtype: 'q8',
        },
      )) as unknown as FeatureExtractor
    } catch (error) {
      if (requestedDevice !== 'webgpu') throw error
      // WebGPU init can fail for reasons `probeEnvironment` can't see ahead
      // of time (adapter request denied, lost device, etc.) — fall back to
      // wasm once, per the plan's "webgpu 失败回退 wasm 一次".
      resolvedDevice = 'wasm'
      installWasmPaths(request.wasm, request.numThreads, 'wasm')
      extractor = (await pipeline(
        'feature-extraction',
        'yolo-local-embedding-model',
        {
          device: 'wasm',
          dtype: 'q8',
        },
      )) as unknown as FeatureExtractor
    }
    spec = request.spec
    post({
      type: 'init-result',
      requestId: request.requestId,
      ok: true,
      device: resolvedDevice,
    })
  } catch (error) {
    post({
      type: 'init-result',
      requestId: request.requestId,
      ok: false,
      error: describeError(error),
    })
  }
}

async function handleEmbed(
  request: EmbeddingWorkerEmbedRequest,
): Promise<void> {
  try {
    if (!extractor || !spec) {
      throw new Error('Embedding session is not initialized')
    }
    const output = await extractor([...request.texts], {
      pooling: spec.pooling,
      normalize: spec.normalize,
    })
    const nested = output.tolist()
    const vectors = nested.map((row) => Float32Array.from(row).buffer)
    post(
      { type: 'embed-result', requestId: request.requestId, ok: true, vectors },
      vectors,
    )
  } catch (error) {
    post({
      type: 'embed-result',
      requestId: request.requestId,
      ok: false,
      error: describeError(error),
    })
  }
}

function handleDispose(request: EmbeddingWorkerDisposeRequest): void {
  extractor = null
  spec = null
  for (const url of wasmObjectUrls.splice(0)) URL.revokeObjectURL(url)
  post({ type: 'dispose-result', requestId: request.requestId, ok: true })
}

self.onmessage = (event: MessageEvent<EmbeddingWorkerRequest>): void => {
  const request = event.data
  if (request.type === 'init') void handleInit(request)
  else if (request.type === 'embed') void handleEmbed(request)
  else if (request.type === 'dispose') handleDispose(request)
}
