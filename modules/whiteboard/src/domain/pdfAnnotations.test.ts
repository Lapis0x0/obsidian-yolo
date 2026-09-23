import {
  ANNOTATION_FILE_VERSION,
  type PdfAnnotation,
  annotationFilePath,
  displayColor,
  isAnnotationFilePath,
  parseAnnotationFile,
  serializeAnnotationFile,
} from './pdfAnnotations'

const highlight: PdfAnnotation = {
  id: 'a1',
  type: 'highlight',
  color: 'yellow',
  comment: 'why this matters',
  createdAt: '2026-09-23T10:00:00.000Z',
  updatedAt: '2026-09-23T10:05:00.000Z',
  anchor: {
    page: 2,
    quadPoints: [10, 700, 200, 700, 10, 688, 200, 688],
    quote: { exact: 'visual primitives', prefix: 'with ', suffix: '.' },
    selection: [3, 5, 3, 22],
  },
}

const area: PdfAnnotation = {
  id: 'a2',
  type: 'area',
  color: 'blue',
  createdAt: '2026-09-23T10:00:00.000Z',
  updatedAt: '2026-09-23T10:00:00.000Z',
  anchor: { page: 1, rect: [50, 400, 300, 600] },
}

describe('annotation file path', () => {
  it('sits next to the PDF under the PDF’s own name', () => {
    expect(annotationFilePath('papers/a b.pdf')).toBe(
      'papers/a b.pdf.annotations.json',
    )
    expect(isAnnotationFilePath('papers/A.PDF.ANNOTATIONS.JSON')).toBe(true)
    expect(isAnnotationFilePath('papers/a.pdf')).toBe(false)
  })
})

describe('parse / serialize', () => {
  it('round-trips every field', () => {
    const raw = serializeAnnotationFile([highlight, area])
    const parsed = parseAnnotationFile(raw)
    expect(parsed).toEqual({
      ok: true,
      annotations: [highlight, area],
      preserved: [],
    })
    expect(JSON.parse(raw).version).toBe(ANNOTATION_FILE_VERSION)
    expect(serializeAnnotationFile(parsed.annotations)).toBe(raw)
  })

  it('keeps records it cannot read and writes them back untouched', () => {
    const future = { id: 'x', type: 'ink', paths: [[1, 2]] }
    const broken = { ...highlight, id: 'b', anchor: { page: 0 } }
    const raw = JSON.stringify({
      version: 1,
      annotations: [highlight, future, broken],
    })
    const parsed = parseAnnotationFile(raw)
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.annotations).toEqual([highlight])
    expect(parsed.preserved).toEqual([future, broken])
    const again = JSON.parse(
      serializeAnnotationFile(parsed.annotations, parsed.preserved),
    )
    expect(again.annotations).toEqual([highlight, future, broken])
  })

  it('keeps unknown fields on records it can read', () => {
    const raw = JSON.stringify({
      version: 1,
      annotations: [{ ...area, author: 'someone' }],
    })
    const parsed = parseAnnotationFile(raw)
    expect(parsed.annotations[0]).toMatchObject({ author: 'someone' })
  })

  it('treats a bad selection hint as no hint', () => {
    const raw = JSON.stringify({
      version: 1,
      annotations: [
        { ...highlight, anchor: { ...highlight.anchor, selection: [1, -1] } },
      ],
    })
    const parsed = parseAnnotationFile(raw)
    if (highlight.type !== 'highlight') throw new Error('fixture')
    expect(parsed.annotations).toHaveLength(1)
    expect(parsed.annotations[0].anchor).not.toHaveProperty('selection')
  })

  it('rejects quad lists that are not whole quads', () => {
    const raw = JSON.stringify({
      version: 1,
      annotations: [
        { ...highlight, anchor: { ...highlight.anchor, quadPoints: [1, 2] } },
      ],
    })
    const parsed = parseAnnotationFile(raw)
    expect(parsed.annotations).toEqual([])
  })

  it('reads a newer version but says so, and rejects garbage', () => {
    const newer = parseAnnotationFile(
      JSON.stringify({ version: 2, annotations: [area] }),
    )
    expect(newer).toEqual({ ok: false, reason: 'newer', annotations: [area] })
    expect(parseAnnotationFile('not json')).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
    expect(parseAnnotationFile('{"annotations": []}')).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
  })

  it('draws an unknown colour as the default', () => {
    expect(displayColor('green')).toBe('green')
    expect(displayColor('#ff0000')).toBe('yellow')
  })
})
