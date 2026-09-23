// The pdf-engine component's pure layout math, imported by relative path:
// `runtime-components/` is outside Jest's roots (see bashEngineReadOnly.test.ts).
import {
  capPixelRatio,
  mergeBoxesIntoLines,
} from '../../../runtime-components/pdf-engine/src/geometry'

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
})

describe('mergeBoxesIntoLines', () => {
  it('folds abutting fragments of one line into a single box', () => {
    expect(
      mergeBoxesIntoLines([
        box(10, 100, 40, 112),
        box(40, 100, 44, 112),
        box(44, 99, 90, 112),
      ]),
    ).toEqual([box(10, 99, 90, 112)])
  })

  it('keeps separate lines apart, in reading order', () => {
    expect(
      mergeBoxesIntoLines([box(10, 100, 90, 112), box(10, 114, 60, 126)]),
    ).toEqual([box(10, 100, 90, 112), box(10, 114, 60, 126)])
  })

  it('keeps a superscript on its line', () => {
    expect(
      mergeBoxesIntoLines([box(10, 100, 50, 112), box(50, 97, 55, 105)]),
    ).toEqual([box(10, 97, 55, 112)])
  })

  it('does not bridge a column gutter on the same baseline', () => {
    expect(
      mergeBoxesIntoLines([box(10, 100, 200, 112), box(260, 100, 450, 112)]),
    ).toHaveLength(2)
  })

  it('drops empty fragments such as line-break boxes', () => {
    expect(
      mergeBoxesIntoLines([box(90, 100, 90, 112), box(10, 100, 50, 100)]),
    ).toEqual([])
  })
})

describe('capPixelRatio', () => {
  it('keeps the requested ratio when the canvas fits', () => {
    expect(capPixelRatio(612, 792, 2)).toBe(2)
  })

  it('lowers the ratio just enough to fit the pixel budget', () => {
    const ratio = capPixelRatio(4000, 4000, 2, 1_000_000)
    expect(4000 * ratio * (4000 * ratio)).toBeCloseTo(1_000_000)
  })

  it('treats a missing or invalid ratio as 1', () => {
    expect(capPixelRatio(100, 100, Number.NaN)).toBe(1)
    expect(capPixelRatio(100, 100, 0)).toBe(1)
  })
})
