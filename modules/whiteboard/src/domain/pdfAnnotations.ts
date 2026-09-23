// The annotation file that sits next to a PDF: what a highlight or a framed
// area on a page is, and how a list of them is written to and read from disk.
//
// One file per PDF, `<pdf path>.annotations.json`, in the PDF's own folder.
// It describes the PDF and nothing else — no board, no card, no reader — so
// whatever reads that PDF can read its annotations: a board today, and later
// a read-only layer in Obsidian's own PDF view, or the export that writes
// them into a copy of the PDF (the geometry below is already the PDF's own:
// user-space points, and highlight quads in the order PDF /QuadPoints use).
//
// Positions are PDF coordinates, not screen or text-layer positions, so they
// hold whatever the reader's zoom, width or pdf.js version. A highlight also
// keeps the text it covers with a little context either side, and the text
// layer's selection tuple it was made from: the tuple is exact for as long
// as the text layer splits the page the same way, and the quote is how it is
// found again when it does not (../ui/pdf/annotationGeometry.ts).
//
// Pure: no DOM, no host.

export const ANNOTATION_FILE_SUFFIX = '.annotations.json'
export const ANNOTATION_FILE_VERSION = 1

/** The palette, in the order a picker shows it. A file may carry a name that
 * is not here (a later version's); it is kept, and drawn as the first. */
export const ANNOTATION_COLORS = [
  'yellow',
  'green',
  'blue',
  'pink',
  'purple',
] as const
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number]
export const DEFAULT_ANNOTATION_COLOR: AnnotationColor = 'yellow'

/** `[x1, y1, x2, y2]` in PDF user space (points, y up). */
export type PdfRectTuple = readonly [number, number, number, number]

/** `[startItem, startOffset, endItem, endOffset]`: the text layer's
 * `data-idx` spans and UTF-16 offsets within them, end exclusive — the same
 * four numbers as Obsidian's `#page=N&selection=a,b,c,d`. */
export type SelectionTuple = readonly [number, number, number, number]

export type AnnotationQuote = Readonly<{
  exact: string
  prefix?: string
  suffix?: string
}>

export type HighlightAnchor = Readonly<{
  /** 1-based. */
  page: number
  /** Eight numbers per line: the line's corners top-left, top-right,
   * bottom-left, bottom-right, each as x then y. */
  quadPoints: readonly number[]
  quote: AnnotationQuote
  /** A hint, not the anchor: right while the text layer splits the page as
   * it did when the highlight was made. */
  selection?: SelectionTuple
}>

export type AreaAnchor = Readonly<{
  page: number
  rect: PdfRectTuple
}>

type AnnotationBase = Readonly<{
  id: string
  color: string
  comment?: string
  /** ISO 8601. */
  createdAt: string
  updatedAt: string
}>

export type HighlightAnnotation = AnnotationBase &
  Readonly<{ type: 'highlight'; anchor: HighlightAnchor }>

export type AreaAnnotation = AnnotationBase &
  Readonly<{ type: 'area'; anchor: AreaAnchor }>

export type PdfAnnotation = HighlightAnnotation | AreaAnnotation

export type AnnotationParseResult =
  | Readonly<{
      ok: true
      annotations: readonly PdfAnnotation[]
      /** Records this version does not understand (a kind added later, a
       * damaged one), not shown but written back as they were, so saving an
       * edit never deletes what this version cannot read. */
      preserved: readonly unknown[]
    }>
  | Readonly<{
      ok: false
      /** `newer`: written by a later version — shown as far as it can be
       * read, never overwritten. `invalid`: not an annotation file at all. */
      reason: 'newer' | 'invalid'
      annotations: readonly PdfAnnotation[]
    }>

/** Where the annotations of `pdfPath` live. */
export function annotationFilePath(pdfPath: string): string {
  return `${pdfPath}${ANNOTATION_FILE_SUFFIX}`
}

export function isAnnotationFilePath(path: string): boolean {
  return path.toLowerCase().endsWith(ANNOTATION_FILE_SUFFIX)
}

export function isAnnotationColor(value: string): value is AnnotationColor {
  return (ANNOTATION_COLORS as readonly string[]).includes(value)
}

/** The palette entry a stored colour is drawn as. */
export function displayColor(color: string): AnnotationColor {
  return isAnnotationColor(color) ? color : DEFAULT_ANNOTATION_COLOR
}

export function parseAnnotationFile(raw: string): AnnotationParseResult {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'invalid', annotations: [] }
  }
  if (!isObject(data) || !Array.isArray(data.annotations)) {
    return { ok: false, reason: 'invalid', annotations: [] }
  }
  const version = data.version
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, reason: 'invalid', annotations: [] }
  }
  const annotations: PdfAnnotation[] = []
  const preserved: unknown[] = []
  const seen = new Set<string>()
  for (const record of data.annotations as unknown[]) {
    const annotation = parseAnnotation(record)
    if (!annotation || seen.has(annotation.id)) {
      preserved.push(record)
      continue
    }
    seen.add(annotation.id)
    annotations.push(annotation)
  }
  if (version > ANNOTATION_FILE_VERSION) {
    return { ok: false, reason: 'newer', annotations }
  }
  if (version < 1) return { ok: false, reason: 'invalid', annotations: [] }
  return { ok: true, annotations, preserved }
}

export function serializeAnnotationFile(
  annotations: readonly PdfAnnotation[],
  preserved: readonly unknown[] = [],
): string {
  const file = {
    version: ANNOTATION_FILE_VERSION,
    annotations: [...annotations, ...preserved],
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * One record, validated field by field. Fields this version does not know
 * are kept as they were, so a record a later version added to survives being
 * read and written back by this one.
 */
function parseAnnotation(record: unknown): PdfAnnotation | null {
  if (!isObject(record)) return null
  const { id, type, color, comment, createdAt, updatedAt, anchor } = record
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof color !== 'string' || color.length === 0) return null
  if (comment !== undefined && typeof comment !== 'string') return null
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) return null
  if (!isObject(anchor)) return null
  if (!(Number.isInteger(anchor.page) && (anchor.page as number) >= 1)) {
    return null
  }
  if (type === 'highlight') {
    const parsed = parseHighlightAnchor(anchor)
    if (!parsed) return null
    return { ...record, type, anchor: parsed } as HighlightAnnotation
  }
  if (type === 'area') {
    if (!isRect(anchor.rect)) return null
    return { ...record, type, anchor } as unknown as AreaAnnotation
  }
  return null
}

function parseHighlightAnchor(
  anchor: Record<string, unknown>,
): HighlightAnchor | null {
  const { quadPoints, quote, selection } = anchor
  if (
    !Array.isArray(quadPoints) ||
    quadPoints.length === 0 ||
    quadPoints.length % 8 !== 0 ||
    !quadPoints.every(isFiniteNumber)
  ) {
    return null
  }
  if (!isObject(quote) || typeof quote.exact !== 'string') return null
  if (quote.prefix !== undefined && typeof quote.prefix !== 'string') {
    return null
  }
  if (quote.suffix !== undefined && typeof quote.suffix !== 'string') {
    return null
  }
  // A malformed hint is only a missing hint: the quote finds the text.
  const { selection: _dropped, ...rest } = anchor
  return (isSelectionTuple(selection) ? anchor : rest) as HighlightAnchor
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isRect(value: unknown): value is PdfRectTuple {
  return (
    Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber)
  )
}

function isSelectionTuple(value: unknown): value is SelectionTuple {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => Number.isInteger(n) && (n as number) >= 0)
  )
}
