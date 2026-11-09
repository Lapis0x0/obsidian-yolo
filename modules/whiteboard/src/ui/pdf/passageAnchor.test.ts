import type { PdfAnnotation } from '../../domain/pdfAnnotations'

import { passageAnchorFromAnnotation } from './passageAnchor'

const base = {
  id: 'a',
  color: 'yellow',
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
}

describe('passageAnchorFromAnnotation', () => {
  it('takes a highlight as the passage it marks', () => {
    const anchor = {
      page: 4,
      quadPoints: [0, 10, 50, 10, 0, 0, 50, 0],
      quote: { exact: 'marked' },
      selection: [1, 0, 1, 6] as const,
    }
    const annotation: PdfAnnotation = { ...base, type: 'highlight', anchor }
    expect(passageAnchorFromAnnotation(annotation)).toEqual({
      kind: 'pdf',
      ...anchor,
    })
  })

  it('takes a framed area as its rectangle, one quad and no text', () => {
    const annotation: PdfAnnotation = {
      ...base,
      type: 'area',
      anchor: { page: 2, rect: [10, 20, 110, 220] },
    }
    expect(passageAnchorFromAnnotation(annotation)).toEqual({
      kind: 'pdf',
      page: 2,
      quadPoints: [10, 220, 110, 220, 10, 20, 110, 20],
    })
  })
})
