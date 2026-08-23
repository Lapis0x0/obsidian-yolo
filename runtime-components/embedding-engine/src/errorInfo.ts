import type {
  EmbeddingWorkerErrorInfo,
  EmbeddingWorkerErrorStage,
} from './protocol'

/**
 * Builds the RPC error payload `worker.ts` posts back on failure. A plain
 * `error.message` string (the old shape) loses which stage failed and which
 * device was in use — both matter for triage, since e.g. a WebGPU adapter
 * failure and a corrupt ONNX file surface as unrelated problems that need
 * different fixes.
 */
export function toErrorInfo(
  error: unknown,
  stage: EmbeddingWorkerErrorStage,
  device?: 'wasm' | 'webgpu',
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
