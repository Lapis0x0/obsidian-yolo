import type { PdfAnnotationInput } from '../../core/runtime-components/contracts'
import { acquireRuntimeComponent } from '../../core/runtime-components/runtimeComponentAccess'

/**
 * A copy of `bytes` with `annotations` written in as standard PDF
 * annotations (pdf-engine's `addAnnotations`); `bytes` is not modified.
 */
export async function addPdfAnnotations(
  bytes: Uint8Array,
  annotations: readonly PdfAnnotationInput[],
): Promise<Uint8Array> {
  const lease = await acquireRuntimeComponent('pdf-engine')
  try {
    return await lease.api.addAnnotations(bytes, annotations)
  } finally {
    lease.release()
  }
}
