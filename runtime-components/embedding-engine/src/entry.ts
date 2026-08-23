import workerSource from 'virtual:embedding-worker-script'

import {
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerResponse,
  OPTIONAL_MODEL_FILES,
  REQUIRED_MODEL_FILES,
  WASM_ASSET_NAMES,
} from './protocol'

// The component-facing API contract lives in host code
// (`src/core/runtime-components/contracts.ts`) so the host never needs to
// import this component's source. Re-declared locally instead of imported —
// see bash-engine's entry.ts for why the build boundary forbids a component
// from importing host source.
type EmbeddingEngineSpec = Readonly<{
  dimension: number
  pooling: 'mean' | 'cls'
  normalize: boolean
  maxTokens: number
}>
type EmbeddingEngineDevice = 'wasm' | 'webgpu'
type EmbeddingEngineEnvironmentProbe =
  | Readonly<{ ok: true; webgpu: boolean; threads: number }>
  | Readonly<{
      ok: false
      reason: 'no-wasm-simd' | 'no-worker' | 'no-response'
    }>
type EmbeddingEngineCreateSessionOptions = Readonly<{
  loadWasm(name: string): Promise<Uint8Array>
  loadModelFile(file: string): Promise<Uint8Array>
  spec: EmbeddingEngineSpec
  device?: EmbeddingEngineDevice
  signal?: AbortSignal
}>
type EmbeddingSession = Readonly<{
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
  dispose(): void
}>
type EmbeddingEngineComponentApi = Readonly<{
  probeEnvironment(): EmbeddingEngineEnvironmentProbe
  createSession(
    options: EmbeddingEngineCreateSessionOptions,
  ): Promise<EmbeddingSession>
  dispose(): void
}>

// Minimal WASM SIMD probe module: `(func (result v128) i32.const 0
// i8x16.splat)`. Same technique onnxruntime-web/Transformers.js use
// internally to gate their SIMD builds — if the runtime can't validate this,
// the SIMD-only wasm assets this component ships will fail to instantiate.
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
])

function probeEnvironment(): EmbeddingEngineEnvironmentProbe {
  if (typeof Worker === 'undefined') return { ok: false, reason: 'no-worker' }
  if (typeof Response === 'undefined') {
    return { ok: false, reason: 'no-response' }
  }
  if (
    typeof WebAssembly === 'undefined' ||
    typeof WebAssembly.validate !== 'function' ||
    !WebAssembly.validate(WASM_SIMD_PROBE)
  ) {
    return { ok: false, reason: 'no-wasm-simd' }
  }
  const isolated = globalThis.crossOriginIsolated === true
  const hardwareThreads =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 1
  const threads = isolated ? Math.max(1, Math.min(4, hardwareThreads)) : 1
  const webgpu =
    typeof navigator !== 'undefined' &&
    (navigator as { gpu?: unknown }).gpu !== undefined
  return { ok: true, webgpu, threads }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

class EmbeddingWorkerClient {
  private readonly worker: Worker
  private readonly workerUrl: string
  private requestSeq = 0
  private disposed = false
  private readonly pending = new Map<
    number,
    {
      resolve: (response: EmbeddingWorkerResponse) => void
      reject: (error: unknown) => void
    }
  >()

  constructor() {
    this.workerUrl = URL.createObjectURL(
      new Blob([workerSource], { type: 'text/javascript' }),
    )
    this.worker = new Worker(this.workerUrl)
    this.worker.onmessage = (event: MessageEvent<EmbeddingWorkerResponse>) => {
      const response = event.data
      const waiter = this.pending.get(response.requestId)
      if (!waiter) return
      this.pending.delete(response.requestId)
      waiter.resolve(response)
    }
    this.worker.onerror = (event: ErrorEvent) => {
      const error = new Error(event.message || 'Embedding worker crashed')
      for (const waiter of this.pending.values()) waiter.reject(error)
      this.pending.clear()
    }
  }

  private call(
    request: EmbeddingWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<EmbeddingWorkerResponse> {
    if (this.disposed) {
      return Promise.reject(new Error('Embedding worker is disposed'))
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject })
      this.worker.postMessage(request, transfer)
    })
  }

  nextRequestId(): number {
    this.requestSeq += 1
    return this.requestSeq
  }

  async request(
    request: EmbeddingWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<Extract<EmbeddingWorkerResponse, { ok: true }>> {
    const response = await this.call(request, transfer)
    if (!response.ok) throw new Error(response.error)
    return response
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker.terminate()
    URL.revokeObjectURL(this.workerUrl)
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error('Embedding session disposed'))
    }
    this.pending.clear()
  }
}

async function loadNamed(
  names: readonly string[],
  load: (name: string) => Promise<Uint8Array>,
  required: boolean,
): Promise<Array<readonly [string, Uint8Array]>> {
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        return [name, await load(name)] as const
      } catch (error) {
        if (required) throw error
        return null
      }
    }),
  )
  return entries.filter(
    (entry): entry is readonly [string, Uint8Array] => entry !== null,
  )
}

globalThis.__yolo_register_runtime_component__({
  id: 'embedding-engine',
  create(): EmbeddingEngineComponentApi {
    let disposed = false
    const activeSessions = new Set<EmbeddingWorkerClient>()

    return Object.freeze({
      probeEnvironment,

      async createSession(
        options: EmbeddingEngineCreateSessionOptions,
      ): Promise<EmbeddingSession> {
        if (disposed) throw new Error('Embedding engine is disposed')
        const probe = probeEnvironment()
        if (!probe.ok) {
          throw new Error(
            `Embedding engine environment probe failed: ${probe.reason}`,
          )
        }
        if (options.signal?.aborted) {
          throw abortError('Embedding session creation aborted')
        }

        const [wasmEntries, requiredModelEntries, optionalModelEntries] =
          await Promise.all([
            loadNamed(WASM_ASSET_NAMES, options.loadWasm, true),
            loadNamed(REQUIRED_MODEL_FILES, options.loadModelFile, true),
            loadNamed(OPTIONAL_MODEL_FILES, options.loadModelFile, false),
          ])
        if (options.signal?.aborted) {
          throw abortError('Embedding session creation aborted')
        }

        const wasm: Record<string, ArrayBuffer> = {}
        const modelFiles: Record<string, ArrayBuffer> = {}
        const transfer: Transferable[] = []
        for (const [name, bytes] of wasmEntries) {
          const buffer = toArrayBuffer(bytes)
          wasm[name] = buffer
          transfer.push(buffer)
        }
        for (const [name, bytes] of [
          ...requiredModelEntries,
          ...optionalModelEntries,
        ]) {
          const buffer = toArrayBuffer(bytes)
          modelFiles[name] = buffer
          transfer.push(buffer)
        }

        const client = new EmbeddingWorkerClient()
        activeSessions.add(client)
        try {
          const initResponse = await client.request(
            {
              type: 'init',
              requestId: client.nextRequestId(),
              wasm,
              modelFiles,
              spec: options.spec,
              device: options.device,
              numThreads: probe.threads,
            },
            transfer,
          )
          if (initResponse.type !== 'init-result') {
            throw new Error('Unexpected embedding worker response to init')
          }
        } catch (error) {
          activeSessions.delete(client)
          client.dispose()
          throw new Error(
            `Embedding session initialization failed: ${describeError(error)}`,
          )
        }

        let sessionDisposed = false
        return Object.freeze({
          async embed(
            texts: string[],
            signal?: AbortSignal,
          ): Promise<Float32Array[]> {
            if (sessionDisposed) {
              throw new Error('Embedding session is disposed')
            }
            if (signal?.aborted) throw abortError('Embedding aborted')
            const response = await client.request({
              type: 'embed',
              requestId: client.nextRequestId(),
              texts,
            })
            if (response.type !== 'embed-result') {
              throw new Error('Unexpected embedding worker response to embed')
            }
            return response.vectors.map((buffer) => new Float32Array(buffer))
          },
          dispose(): void {
            if (sessionDisposed) return
            sessionDisposed = true
            activeSessions.delete(client)
            client.dispose()
          },
        })
      },

      dispose(): void {
        if (disposed) return
        disposed = true
        for (const client of [...activeSessions]) client.dispose()
        activeSessions.clear()
      },
    })
  },
})
