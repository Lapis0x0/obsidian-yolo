import type {
  EmbeddingWorkerDevice,
  EmbeddingWorkerErrorInfo,
  EmbeddingWorkerErrorStage,
} from './protocol'

/**
 * Builds the RPC error payload `worker.ts` posts back on failure. A plain
 * `error.message` string (the old shape) loses which stage failed and which
 * device was in use — both matter for triage (e.g. a corrupt ONNX file vs.
 * a WASM instantiation failure surface as unrelated problems that need
 * different fixes).
 */
export function toErrorInfo(
  error: unknown,
  stage: EmbeddingWorkerErrorStage,
  device?: EmbeddingWorkerDevice,
): EmbeddingWorkerErrorInfo {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      stage,
      ...(device ? { device } : {}),
    }
  }
  return {
    name: 'Error',
    message: String(error),
    stage,
    ...(device ? { device } : {}),
  }
}
