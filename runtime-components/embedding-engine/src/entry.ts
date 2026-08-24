import workerSource from 'virtual:embedding-worker-script'

import {
  type EmbeddingWorkerErrorInfo,
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
  pooling: 'mean' | 'cls' | 'last-token'
  normalize: boolean
  maxTokens: number
  dtype?: 'q8' | 'fp16'
}>
/**
 * The type stays a union for forward compatibility with the host's public
 * `EmbeddingEngineCreateSessionOptions.device` contract, but `createSession`
 * below only supports `'wasm'` in this release — a `'webgpu'` request is
 * rejected rather than silently downgraded, since this component doesn't
 * ship the JSEP/WebGPU wasm variant as a declared asset (see
 * `WASM_ASSET_NAMES` in `protocol.ts`). `dtype` is independent of device —
 * WebGPU support is what's planned to return in a future release.
 */
type EmbeddingEngineDevice = 'wasm' | 'webgpu'
type EmbeddingEngineEnvironmentProbe =
  | Readonly<{ ok: true; webgpu: boolean; threads: number }>
  | Readonly<{
      ok: false
      reason: 'no-wasm-simd' | 'no-worker' | 'no-response'
    }>
type EmbeddingEngineCreateSessionOptions = Readonly<{
  loadWasm(name: string, signal?: AbortSignal): Promise<Uint8Array>
  loadModelFile(file: string, signal?: AbortSignal): Promise<Uint8Array>
  spec: EmbeddingEngineSpec
  device?: EmbeddingEngineDevice
  signal?: AbortSignal
}>
type EmbeddingSession = Readonly<{
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
  dispose(): Promise<void>
}>
type EmbeddingEngineComponentApi = Readonly<{
  probeEnvironment(): EmbeddingEngineEnvironmentProbe
  createSession(
    options: EmbeddingEngineCreateSessionOptions,
  ): Promise<EmbeddingSession>
  dispose(): Promise<void>
}>

// Minimal WASM SIMD probe module: `(func (result v128) i32.const 0
// i8x16.splat)`. Same technique onnxruntime-web/Transformers.js use
// internally to gate their SIMD builds — if the runtime can't validate this,
// the SIMD-only wasm assets this component ships will fail to instantiate.
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
])

/** How long `dispose()` waits for the worker's own cleanup RPC to ack before force-terminating. */
const DISPOSE_TIMEOUT_MS = 3000

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

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

function workerErrorToError(info: EmbeddingWorkerErrorInfo): Error {
  const suffix = info.device
    ? ` (stage: ${info.stage}, device: ${info.device})`
    : ` (stage: ${info.stage})`
  const error = new Error(`${info.message}${suffix}`)
  error.name = info.name
  if (info.stack) error.stack = info.stack
  return error
}

function crashError(message: string): EmbeddingWorkerErrorInfo {
  return { name: 'WorkerCrashed', message, stage: 'unknown' }
}

/**
 * Carries everything an `ErrorEvent` knows into the RPC error payload.
 *
 * `event.message` alone is routinely useless here: a failure inside a nested
 * worker (the pthreads onnxruntime-web spawns for multi-threaded wasm)
 * reaches this handler as `"Uncaught [object ErrorEvent]"`, with the real
 * cause only in `filename`/`lineno` — and nothing else in the host ever sees
 * this event, so whatever is dropped here is lost for good. `event.error` is
 * usually null for cross-scope errors, but carries a real stack when the
 * throw happened in this worker's own scope.
 */
function crashErrorFromEvent(event: ErrorEvent): EmbeddingWorkerErrorInfo {
  const where = event.filename
    ? ` (${event.filename}:${event.lineno}:${event.colno})`
    : ''
  const cause = event.error instanceof Error ? event.error : null
  return {
    name: 'WorkerCrashed',
    message: `${event.message || 'Embedding worker crashed'}${where}`,
    ...(cause?.stack ? { stack: cause.stack } : {}),
    stage: 'unknown',
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Owns the Worker's lifecycle. Once `dead` (crashed, aborted, or disposed)
 * it never recovers — every subsequent call fails immediately instead of
 * silently hanging, which is what plain `postMessage` to a torn-down Worker
 * would otherwise do (the returned Promise would never settle).
 */
class EmbeddingWorkerClient {
  private readonly worker: Worker
  private readonly workerUrl: string
  private requestSeq = 0
  private dead = false
  private readonly pending = new Map<
    number,
    {
      resolve: (response: EmbeddingWorkerResponse) => void
      reject: (error: Error) => void
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
      this.invalidate(crashErrorFromEvent(event))
    }
    this.worker.onmessageerror = () => {
      this.invalidate(
        crashError('Embedding worker sent an unparseable message'),
      )
    }
  }

  /** Atomically tears the worker down and fails everything pending/future. */
  private invalidate(errorInfo: EmbeddingWorkerErrorInfo): void {
    if (this.dead) return
    this.dead = true
    try {
      this.worker.terminate()
    } catch {
      // Already gone; nothing to do.
    }
    URL.revokeObjectURL(this.workerUrl)
    const error = workerErrorToError(errorInfo)
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }

  private call(
    request: EmbeddingWorkerRequest,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
  ): Promise<EmbeddingWorkerResponse> {
    if (this.dead) {
      return Promise.reject(
        new Error('Embedding worker session is no longer usable'),
      )
    }
    if (signal?.aborted) {
      return Promise.reject(abortError('Embedding request aborted'))
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(request.requestId)
        reject(abortError('Embedding request aborted'))
        // ORT can't safely cancel a run already in flight, so an abort
        // invalidates the whole session rather than leaving it half-used.
        this.invalidate({
          name: 'AbortError',
          message: 'Embedding session aborted',
          stage: 'unknown',
        })
      }
      const settle = (fn: () => void): void => {
        signal?.removeEventListener('abort', onAbort)
        fn()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(request.requestId, {
        resolve: (response) => settle(() => resolve(response)),
        reject: (error) => settle(() => reject(error)),
      })
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
    signal?: AbortSignal,
  ): Promise<Extract<EmbeddingWorkerResponse, { ok: true }>> {
    const response = await this.call(request, transfer, signal)
    if (!response.ok) throw workerErrorToError(response.error)
    return response
  }

  /**
   * Real cleanup RPC: ask the worker to dispose the ORT/model session and
   * revoke its own Blob URLs, wait briefly for the ack, then terminate.
   * `terminate()` alone (the old behavior) reclaims the Worker's JS realm
   * but never runs the library's own `dispose()` lifecycle, and left a
   * "send dispose" step that nothing ever called.
   */
  async dispose(): Promise<void> {
    if (this.dead) return
    const ackOrTimeout = Promise.race([
      this.call({ type: 'dispose', requestId: this.nextRequestId() }).then(
        () => undefined,
        () => undefined,
      ),
      sleep(DISPOSE_TIMEOUT_MS),
    ])
    await ackOrTimeout
    this.invalidate({
      name: 'Error',
      message: 'Embedding session disposed',
      stage: 'dispose',
    })
  }
}

async function loadNamed(
  names: readonly string[],
  load: (name: string, signal?: AbortSignal) => Promise<Uint8Array>,
  required: boolean,
  signal?: AbortSignal,
): Promise<Array<readonly [string, Uint8Array]>> {
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        return [name, await load(name, signal)] as const
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

/** Rejects with an AbortError as soon as `signal` fires, otherwise never settles. */
function abortSignal(
  signal: AbortSignal | undefined,
  message: string,
): { promise: Promise<never>; cancel(): void } {
  if (!signal) return { promise: new Promise(() => undefined), cancel() {} }
  let onAbort: () => void = () => undefined
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(message))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    cancel: () => signal.removeEventListener('abort', onAbort),
  }
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

        const requestedDevice: EmbeddingEngineDevice = options.device ?? 'wasm'
        if (requestedDevice !== 'wasm') {
          throw new Error(
            `Embedding engine device "${requestedDevice}" is not supported in this release; only "wasm" is available (WebGPU support is planned for a future release)`,
          )
        }

        const abort = abortSignal(
          options.signal,
          'Embedding session creation aborted',
        )
        let wasmEntries: Array<readonly [string, Uint8Array]>
        let requiredModelEntries: Array<readonly [string, Uint8Array]>
        let optionalModelEntries: Array<readonly [string, Uint8Array]>
        try {
          ;[wasmEntries, requiredModelEntries, optionalModelEntries] =
            await Promise.race([
              Promise.all([
                loadNamed(
                  WASM_ASSET_NAMES,
                  options.loadWasm,
                  true,
                  options.signal,
                ),
                loadNamed(
                  REQUIRED_MODEL_FILES,
                  options.loadModelFile,
                  true,
                  options.signal,
                ),
                loadNamed(
                  OPTIONAL_MODEL_FILES,
                  options.loadModelFile,
                  false,
                  options.signal,
                ),
              ]),
              abort.promise,
            ])
        } finally {
          abort.cancel()
        }
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
              device: requestedDevice,
              numThreads: probe.threads,
            },
            transfer,
            options.signal,
          )
          if (initResponse.type !== 'init-result') {
            throw new Error('Unexpected embedding worker response to init')
          }
        } catch (error) {
          activeSessions.delete(client)
          await client.dispose()
          throw error instanceof DOMException && error.name === 'AbortError'
            ? error
            : new Error(
                `Embedding session initialization failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
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
            const response = await client.request(
              {
                type: 'embed',
                requestId: client.nextRequestId(),
                texts,
              },
              [],
              signal,
            )
            if (response.type !== 'embed-result') {
              throw new Error('Unexpected embedding worker response to embed')
            }
            return response.vectors.map((buffer) => new Float32Array(buffer))
          },
          async dispose(): Promise<void> {
            if (sessionDisposed) return
            sessionDisposed = true
            activeSessions.delete(client)
            await client.dispose()
          },
        })
      },

      async dispose(): Promise<void> {
        if (disposed) return
        disposed = true
        const clients = [...activeSessions]
        activeSessions.clear()
        await Promise.all(clients.map((client) => client.dispose()))
      },
    })
  },
})
