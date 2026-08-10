import { acquireRuntimeComponent } from '../../core/runtime-components/runtimeComponentAccess'

/**
 * Hard limits aligned with Anthropic's native-PDF constraints (32 MB whole
 * request payload). Inline base64 inflates raw bytes by ~33%, so we cap raw
 * slice output at 24 MB to keep the encoded request comfortably under the API
 * ceiling — matches `PDF_UPLOAD_MAX_BYTES` for parity.
 */
/**
 * Thrown when a slice cannot be produced. The `kind` field tells the caller
 * how to react:
 *   • 'invalid-range'  — caller-supplied startPage/endPage violates document
 *     bounds. Surface this as a hard error to the model (it asked for a page
 *     that doesn't exist); do NOT silently fall back to text.
 *   • 'load-failed'    — source PDF couldn't be parsed (encrypted, corrupt,
 *     unsupported). Falling back to text extraction is reasonable.
 *   • 'too-many-pages' — requested range is valid but exceeds the per-slice
 *     page cap. Caller can fall back to text.
 *   • 'too-large'      — sliced output exceeds the byte cap. Caller can fall
 *     back to text.
 */
export type PdfSliceErrorKind =
  | 'invalid-range'
  | 'load-failed'
  | 'too-many-pages'
  | 'too-large'

export class PdfSliceError extends Error {
  readonly kind: PdfSliceErrorKind
  constructor(kind: PdfSliceErrorKind, message: string) {
    super(message)
    this.name = 'PdfSliceError'
    this.kind = kind
  }
}

export type SlicePdfPagesRange = {
  /** 1-based inclusive start page. */
  startPage: number
  /** 1-based inclusive end page. Defaults to the last page of the document. */
  endPage?: number
}

export type SlicePdfPagesResult = {
  /** The sliced PDF bytes. Pages are renumbered 1..N internally by pdf-lib. */
  bytes: Uint8Array
  /** Total page count of the original source document. */
  totalSourcePages: number
  /** Clamped 1-based start page actually included in the slice. */
  actualStart: number
  /** Clamped 1-based end page actually included in the slice. */
  actualEnd: number
}

/**
 * Extract a contiguous page range from a PDF document into a new PDF. The
 * source document is loaded exactly once; total page count and clamped range
 * are returned so callers don't need a separate probe.
 *
 * @throws {PdfSliceError} If the source cannot be loaded, the range is invalid,
 *   the page count exceeds {@link MAX_SLICE_PAGES}, or the output exceeds the
 *   byte size cap.
 */
export async function slicePdfPages(
  rawData: Uint8Array,
  range: SlicePdfPagesRange,
): Promise<SlicePdfPagesResult> {
  const lease = await acquireRuntimeComponent('pdf-engine')
  try {
    return await lease.api.slicePages(rawData, range)
  } catch (error) {
    const candidate = error as { kind?: unknown; message?: unknown }
    if (
      candidate.kind === 'invalid-range' ||
      candidate.kind === 'load-failed' ||
      candidate.kind === 'too-many-pages' ||
      candidate.kind === 'too-large'
    ) {
      throw new PdfSliceError(
        candidate.kind,
        typeof candidate.message === 'string'
          ? candidate.message
          : 'PDF slice failed',
      )
    }
    throw error
  } finally {
    lease.release()
  }
}
