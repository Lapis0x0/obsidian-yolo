import {
  EXPORT_PADDING,
  exportPixelSize,
  exportRegion,
  exportRows,
  fitsOneCanvas,
} from './exportLayout'

describe('exportRegion', () => {
  it('covers every rectangle with room round them', () => {
    expect(
      exportRegion([
        { x: 0, y: 0, w: 100, h: 50 },
        { x: 200, y: -30, w: 10, h: 10 },
      ]),
    ).toEqual({
      x: -EXPORT_PADDING,
      y: -30 - EXPORT_PADDING,
      w: 210 + EXPORT_PADDING * 2,
      h: 80 + EXPORT_PADDING * 2,
    })
    expect(exportRegion([])).toBeNull()
  })
})

describe('fitsOneCanvas', () => {
  it('holds what one canvas can, by side and by area', () => {
    expect(fitsOneCanvas({ width: 16384, height: 16384 })).toBe(true)
    expect(fitsOneCanvas({ width: 16385, height: 10 })).toBe(false)
    expect(
      fitsOneCanvas(exportPixelSize({ x: 0, y: 0, w: 9000, h: 100 }, 2)),
    ).toBe(false)
  })
})

describe('exportRows', () => {
  const region = { x: 100, y: 50, w: 1000, h: 700 }

  it('cuts the picture into parts no larger than the viewport', () => {
    const rows = exportRows(region, 2, { w: 400, h: 300 })
    // 2000 x 1400 pixels in 800 x 600 parts.
    expect(rows.map((row) => [row.y, row.h])).toEqual([
      [0, 600],
      [600, 600],
      [1200, 200],
    ])
    expect(rows[0].tiles.map((tile) => tile.px.w)).toEqual([800, 800, 400])
    expect(rows[2].tiles[1].world).toEqual({ x: 500, y: 650, w: 400, h: 100 })
  })

  it('covers every pixel exactly once', () => {
    const rows = exportRows(region, 1.5, { w: 333, h: 211 })
    const { width, height } = exportPixelSize(region, 1.5)
    let area = 0
    for (const row of rows) {
      let x = 0
      for (const tile of row.tiles) {
        expect(tile.px.x).toBe(x)
        expect(tile.px.y).toBe(row.y)
        x += tile.px.w
        area += tile.px.w * tile.px.h
      }
      expect(x).toBe(width)
    }
    expect(area).toBe(width * height)
  })

  it('makes rows shorter as the picture grows wider', () => {
    const wide = { x: 0, y: 0, w: 100000, h: 1000 }
    const rows = exportRows(wide, 1, { w: 2000, h: 1000 }, 3 * 100000 * 50)
    expect(rows[0].h).toBe(50)
  })
})
