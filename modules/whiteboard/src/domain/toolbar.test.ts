import { toolbarScreenPosition } from './toolbar'

const IDENTITY = { tx: 0, ty: 0, scale: 1 }
const VIEWPORT = { width: 1000, height: 800 }
const TOOLBAR = { width: 120, height: 32 }

describe('toolbarScreenPosition', () => {
  it('centres the toolbar on the selection and sits it above', () => {
    const point = toolbarScreenPosition(
      { x: 400, y: 300, w: 200, h: 100 },
      IDENTITY,
      VIEWPORT,
      TOOLBAR,
      8,
      8,
    )
    expect(point).toEqual({ x: 500 - 60, y: 300 - 8 - 32 })
  })

  it('follows the camera: the same bounds project differently after a pan/zoom', () => {
    const point = toolbarScreenPosition(
      { x: 400, y: 300, w: 200, h: 100 },
      { tx: 100, ty: 50, scale: 0.5 },
      VIEWPORT,
      TOOLBAR,
      8,
      8,
    )
    // centre x = (400*0.5+100 + 600*0.5+100)/2 = 350; top = 300*0.5+50 = 200
    expect(point).toEqual({ x: 350 - 60, y: 200 - 8 - 32 })
  })

  it('flips below the selection when there is no room above', () => {
    const point = toolbarScreenPosition(
      { x: 400, y: -50, w: 200, h: 100 },
      IDENTITY,
      VIEWPORT,
      TOOLBAR,
      8,
      8,
    )
    expect(point.y).toBe(50 + 8)
  })

  it('stays above when neither side has room, rather than jumping to the bottom', () => {
    // A selection taller than the viewport: below is off-screen too, so the
    // clamped "above" position (the top margin) is the honest answer.
    const point = toolbarScreenPosition(
      { x: 400, y: -50, w: 200, h: 900 },
      IDENTITY,
      VIEWPORT,
      TOOLBAR,
      8,
      8,
    )
    expect(point.y).toBe(8)
  })

  it('keeps the toolbar inside the viewport horizontally', () => {
    const offLeft = toolbarScreenPosition(
      { x: -900, y: 300, w: 100, h: 100 },
      IDENTITY,
      VIEWPORT,
      TOOLBAR,
      8,
      8,
    )
    expect(offLeft.x).toBe(8)

    const offRight = toolbarScreenPosition(
      { x: 1800, y: 300, w: 100, h: 100 },
      IDENTITY,
      VIEWPORT,
      TOOLBAR,
      8,
      8,
    )
    expect(offRight.x).toBe(1000 - 120 - 8)
  })

  it('falls back to the near edge when the viewport cannot hold the toolbar', () => {
    const point = toolbarScreenPosition(
      { x: 0, y: 0, w: 10, h: 10 },
      IDENTITY,
      { width: 60, height: 20 },
      TOOLBAR,
      8,
      8,
    )
    expect(point).toEqual({ x: 8, y: 8 })
  })
})
