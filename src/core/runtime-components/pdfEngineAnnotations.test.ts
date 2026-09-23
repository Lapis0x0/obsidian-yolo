// The pdf-engine component's annotation writer, imported by relative path:
// `runtime-components/` is outside Jest's roots (see pdfEngineGeometry.test.ts).
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
  degrees,
} from 'pdf-lib'

import {
  addAnnotationsToPdf,
  highlightAppearance,
  parseHexColor,
  quadPointsBounds,
  squareAppearance,
  squareRect,
  validateAnnotation,
} from '../../../runtime-components/pdf-engine/src/annotations'

import type { PdfAnnotationInput } from './contracts'

describe('annotation geometry', () => {
  it('reads #rrggbb as PDF colour components', () => {
    expect(parseHexColor('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(parseHexColor('#FFFFFF')).toEqual([1, 1, 1])
    expect(() => parseHexColor('yellow')).toThrow('#rrggbb')
    expect(() => parseHexColor('#fff')).toThrow('#rrggbb')
  })

  it('bounds quads whatever corner order a rotated page gives them', () => {
    // Two lines on an upright page: top-left, top-right, bottom-left,
    // bottom-right, y up.
    expect(
      quadPointsBounds([
        10, 700, 200, 700, 10, 688, 200, 688, 10, 686, 120, 686, 10, 674, 120,
        674,
      ]),
    ).toEqual([10, 674, 200, 700])
    // One line as a page with /Rotate 90 delivers it: the corners run along
    // user-space y.
    expect(quadPointsBounds([100, 50, 100, 250, 112, 50, 112, 250])).toEqual([
      100, 50, 112, 250,
    ])
  })

  it('fills each quad around its edge, all lines in one path', () => {
    expect(
      highlightAppearance(
        [10, 700, 200, 700, 10, 688, 200, 688.5],
        parseHexColor('#ffff00'),
      ),
    ).toBe(
      [
        '/GS0 gs',
        '1 1 0 rg',
        '10 700 m',
        '200 700 l',
        '200 688.5 l',
        '10 688 l',
        'h',
        'f',
      ].join('\n'),
    )
  })

  it('draws a square border outside the framed area', () => {
    expect(squareRect([50, 60, 10, 20], 2)).toEqual([8, 18, 52, 62])
    expect(squareAppearance([10, 20, 50, 60], 2, [0, 0, 1])).toBe(
      ['2 w', '0 0 1 RG', '9 19 42 42 re', 'S'].join('\n'),
    )
  })

  it('rejects what would not make a well-formed annotation', () => {
    const base = { page: 1, color: '#ffff00' } as const
    const highlight = (quadPoints: number[]): PdfAnnotationInput => ({
      ...base,
      type: 'highlight',
      quadPoints,
    })
    expect(() => validateAnnotation(highlight([1, 2, 3, 4]), 1)).toThrow(
      '8 numbers',
    )
    expect(() => validateAnnotation(highlight([]), 1)).toThrow('8 numbers')
    expect(() =>
      validateAnnotation({ ...highlight(Array(8).fill(1)), page: 2 }, 1),
    ).toThrow('outside 1-1')
    expect(() =>
      validateAnnotation(
        { ...base, type: 'square', rect: [0, 0, 1, Number.NaN] },
        1,
      ),
    ).toThrow('four numbers')
    expect(() =>
      validateAnnotation(
        { ...base, type: 'square', rect: [0, 0, 1, 1], borderWidth: 0 },
        1,
      ),
    ).toThrow('borderWidth')
    expect(() =>
      validateAnnotation(
        { ...highlight(Array(8).fill(1)), modifiedAt: 'yesterday' },
        1,
      ),
    ).toThrow('not a date')
  })
})

describe('addAnnotationsToPdf', () => {
  /** Page 1 upright at the origin with one annotation of its own; page 2
   * rotated 90° with a MediaBox that does not start at (0, 0). */
  async function samplePdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const first = doc.addPage([612, 792])
    const existing = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [20, 20, 40, 40],
        Contents: PDFHexString.fromText('already here'),
      }),
    )
    first.node.addAnnot(existing)
    const second = doc.addPage()
    second.setMediaBox(100, 200, 400, 500)
    second.setRotation(degrees(90))
    return doc.save()
  }

  const annots = (doc: PDFDocument, index: number): PDFDict[] => {
    const array =
      doc.getPage(index).node.Annots() ?? PDFArray.withContext(doc.context)
    return array.asArray().map((ref) => doc.context.lookup(ref, PDFDict))
  }
  const numbers = (dict: PDFDict, key: string): number[] =>
    dict
      .lookup(PDFName.of(key), PDFArray)
      .asArray()
      .map((value) => (value as PDFNumber).asNumber())
  const textOf = (dict: PDFDict, key: string): string | undefined => {
    const value = dict.lookup(PDFName.of(key))
    return value instanceof PDFHexString || value instanceof PDFString
      ? value.decodeText()
      : undefined
  }

  it('writes highlights and squares with appearances, keeping what was there', async () => {
    const source = await samplePdf()
    const before = source.slice()
    // Quads in PDF user space as a 90°-rotated, offset page yields them: one
    // line reading down the screen runs along user-space +y.
    const rotatedQuads = [150, 250, 150, 350, 162, 250, 162, 350]
    const output = await addAnnotationsToPdf(source, [
      {
        type: 'highlight',
        page: 1,
        quadPoints: [72, 700, 300, 700, 72, 686, 300, 686],
        color: '#f1da8c',
        contents: '批注 with ünïcode',
        id: 'h-1',
        createdAt: '2026-09-20T08:00:00.000Z',
        modifiedAt: '2026-09-21T09:30:00.000Z',
      },
      {
        type: 'highlight',
        page: 2,
        quadPoints: rotatedQuads,
        color: '#ffff00',
      },
      {
        type: 'square',
        page: 2,
        rect: [300, 450, 120, 220],
        borderWidth: 1.5,
        color: '#086ddd',
        contents: 'figure',
        id: 'a-1',
      },
    ])
    expect(source).toEqual(before)

    const doc = await PDFDocument.load(output)
    const [kept, highlight] = annots(doc, 0)
    expect(textOf(kept, 'Contents')).toBe('already here')
    expect(kept.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Text'))

    expect(highlight.lookup(PDFName.of('Subtype'))).toBe(
      PDFName.of('Highlight'),
    )
    expect(numbers(highlight, 'QuadPoints')).toEqual([
      72, 700, 300, 700, 72, 686, 300, 686,
    ])
    expect(numbers(highlight, 'Rect')).toEqual([72, 686, 300, 700])
    expect(numbers(highlight, 'C')).toEqual(
      [0xf1 / 255, 0xda / 255, 0x8c / 255].map((c) => expect.closeTo(c, 5)),
    )
    expect(textOf(highlight, 'Contents')).toBe('批注 with ünïcode')
    expect(textOf(highlight, 'NM')).toBe('h-1')
    expect(highlight.lookup(PDFName.of('CA'))).toBeUndefined()
    expect(
      highlight.lookup(PDFName.of('M'), PDFString).decodeDate().toISOString(),
    ).toBe('2026-09-21T09:30:00.000Z')
    expect(highlight.get(PDFName.of('P'))).toBe(doc.getPage(0).ref)

    const appearance = highlight
      .lookup(PDFName.of('AP'), PDFDict)
      .lookup(PDFName.of('N')) as PDFRawStream
    expect(appearance.dict.lookup(PDFName.of('Subtype'))).toBe(
      PDFName.of('Form'),
    )
    expect(
      appearance.dict
        .lookup(PDFName.of('BBox'), PDFArray)
        .asArray()
        .map((n: unknown) => (n as PDFNumber).asNumber()),
    ).toEqual([72, 686, 300, 700])
    const gs = appearance.dict
      .lookup(PDFName.of('Resources'), PDFDict)
      .lookup(PDFName.of('ExtGState'), PDFDict)
      .lookup(PDFName.of('GS0'), PDFDict)
    expect(gs.lookup(PDFName.of('BM'))).toBe(PDFName.of('Multiply'))
    const content = new TextDecoder().decode(
      decodePDFRawStream(appearance).decode(),
    )
    expect(content).toContain('72 700 m')
    expect(content).toContain('300 686 l')

    const [rotated, square] = annots(doc, 1)
    expect(numbers(rotated, 'QuadPoints')).toEqual(rotatedQuads)
    expect(numbers(rotated, 'Rect')).toEqual([150, 250, 162, 350])
    expect(square.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Square'))
    expect(numbers(square, 'Rect')).toEqual([118.5, 218.5, 301.5, 451.5])
    expect(
      square
        .lookup(PDFName.of('BS'), PDFDict)
        .lookup(PDFName.of('W'), PDFNumber)
        .asNumber(),
    ).toBe(1.5)
    expect(square.lookup(PDFName.of('IC'))).toBeUndefined()
    expect(textOf(square, 'Contents')).toBe('figure')
    // The page's own geometry is left as it was.
    expect(doc.getPage(1).getRotation().angle).toBe(90)
    expect(doc.getPage(1).getMediaBox()).toEqual({
      x: 100,
      y: 200,
      width: 400,
      height: 500,
    })
  })

  it('refuses the whole batch when one annotation is malformed', async () => {
    await expect(
      addAnnotationsToPdf(await samplePdf(), [
        {
          type: 'highlight',
          page: 3,
          quadPoints: Array(8).fill(1),
          color: '#000000',
        },
      ]),
    ).rejects.toThrow('outside 1-2')
  })

  it('rejects bytes that are not a PDF', async () => {
    await expect(
      addAnnotationsToPdf(new TextEncoder().encode('not a pdf'), []),
    ).rejects.toThrow()
  })
})
