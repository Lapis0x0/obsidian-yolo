import type { PdfAnnotation } from './pdfAnnotations'
import {
  ANNOTATION_RGB,
  AREA_BORDER_WIDTH,
  tint,
  toExportedAnnotations,
  toHex,
} from './pdfExport'

const times = {
  createdAt: '2026-09-20T08:00:00.000Z',
  updatedAt: '2026-09-21T09:30:00.000Z',
}

describe('toExportedAnnotations', () => {
  it('keeps geometry, ids, dates and comments as the file has them', () => {
    const annotations: PdfAnnotation[] = [
      {
        id: 'h1',
        type: 'highlight',
        color: 'yellow',
        comment: '重要',
        ...times,
        anchor: {
          page: 2,
          quadPoints: [72, 700, 300, 700, 72, 686, 300, 686],
          quote: { exact: 'text' },
        },
      },
      {
        id: 'a1',
        type: 'area',
        color: 'blue',
        ...times,
        anchor: { page: 3, rect: [10, 20, 110, 220] },
      },
    ]
    expect(toExportedAnnotations(annotations)).toEqual([
      {
        type: 'highlight',
        page: 2,
        id: 'h1',
        contents: '重要',
        createdAt: times.createdAt,
        modifiedAt: times.updatedAt,
        quadPoints: [72, 700, 300, 700, 72, 686, 300, 686],
        color: '#f1da8c',
      },
      {
        type: 'square',
        page: 3,
        id: 'a1',
        createdAt: times.createdAt,
        modifiedAt: times.updatedAt,
        rect: [10, 20, 110, 220],
        borderWidth: AREA_BORDER_WIDTH,
        color: '#086ddd',
      },
    ])
  })

  it('writes an unknown colour name as the default one', () => {
    const [exported] = toExportedAnnotations([
      {
        id: 'x',
        type: 'area',
        color: 'teal',
        ...times,
        anchor: { page: 1, rect: [0, 0, 1, 1] },
      },
    ])
    expect(exported.color).toBe(toHex(ANNOTATION_RGB.yellow))
  })
})

describe('tint', () => {
  it('is the colour laid over white at that strength', () => {
    expect(tint([0, 0, 0], 0.5)).toEqual([128, 128, 128])
    expect(tint([255, 255, 255], 0.45)).toEqual([255, 255, 255])
    expect(tint([224, 172, 0], 1)).toEqual([224, 172, 0])
  })
})
