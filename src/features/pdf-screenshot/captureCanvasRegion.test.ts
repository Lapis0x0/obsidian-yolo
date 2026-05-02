/**
 * Unit tests for captureCanvasRegion.
 *
 * These tests run in the default node environment and mock the DOM APIs that
 * captureCanvasRegion requires (HTMLCanvasElement, getContext, etc.).
 * The focus is on coordinate-mapping correctness and edge-case handling.
 */

// ---------------------------------------------------------------------------
// Minimal DOM mocks required by captureCanvasRegion
// ---------------------------------------------------------------------------

type MockCanvas = {
  width: number
  height: number
  getBoundingClientRect: () => DOMRect
  getContext: (_type: string) => MockContext | null
  toDataURL: (_type?: string) => string
}

type MockContext = {
  drawImage: jest.Mock
}

function makeOffscreenMockCanvas(): MockCanvas {
  const ctx: MockContext = { drawImage: jest.fn() }
  const canvas: MockCanvas = {
    width: 0,
    height: 0,
    getBoundingClientRect: () =>
      ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }) as DOMRect,
    getContext: (_type: string) => ctx,
    toDataURL: (_type?: string) =>
      'data:image/png;base64,AAAA', // minimal stub
  }
  return canvas
}

/**
 * Make a mock "source" canvas with controlled backing-store size and
 * CSS display size, mimicking a retina PDF.js canvas.
 */
function makeSourceCanvas(
  backingWidth: number,
  backingHeight: number,
  cssWidth: number,
  cssHeight: number,
): MockCanvas {
  return {
    width: backingWidth,
    height: backingHeight,
    getBoundingClientRect: () =>
      ({
        left: 0,
        top: 0,
        width: cssWidth,
        height: cssHeight,
        right: cssWidth,
        bottom: cssHeight,
      }) as DOMRect,
    getContext: () => null, // source canvas — getContext not needed
    toDataURL: () => '',
  }
}

let offscreenCanvas: MockCanvas

beforeAll(() => {
  offscreenCanvas = makeOffscreenMockCanvas()
  // Patch document.createElement so that when captureCanvasRegion asks for a
  // temporary offscreen canvas we return our mock.
  ;(global as Record<string, unknown>).document = {
    createElement: (_tag: string) => offscreenCanvas,
  }
})

afterAll(() => {
  delete (global as Record<string, unknown>).document
})

// ---------------------------------------------------------------------------
// Import AFTER setting up global.document so the module resolves correctly.
// ---------------------------------------------------------------------------

// eslint-disable-next-line import/first -- must come after global setup
import { captureCanvasRegion } from './captureCanvasRegion'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('captureCanvasRegion – coordinate mapping', () => {
  beforeEach(() => {
    offscreenCanvas.width = 0
    offscreenCanvas.height = 0
    ;(offscreenCanvas.getContext('2d') as MockContext).drawImage.mockClear()
  })

  it('returns base64 string (strips data-URL prefix) for a valid region (1× DPI)', () => {
    const src = makeSourceCanvas(400, 600, 400, 600)
    const result = captureCanvasRegion(src as unknown as HTMLCanvasElement, {
      x: 10,
      y: 20,
      width: 100,
      height: 80,
    })
    expect(result).not.toBeNull()
    expect(result!.base64).toBe('AAAA') // stripped prefix
    expect(result!.pixelWidth).toBe(100)
    expect(result!.pixelHeight).toBe(80)
  })

  it('scales backing-store coordinates correctly for 2× retina (DPR=2)', () => {
    // Backing store is 2× the CSS display size
    const src = makeSourceCanvas(800, 1200, 400, 600)
    const result = captureCanvasRegion(src as unknown as HTMLCanvasElement, {
      x: 50, // CSS px → backing: 100
      y: 100, // CSS px → backing: 200
      width: 200, // CSS px → backing: 400
      height: 150, // CSS px → backing: 300
    })
    expect(result).not.toBeNull()
    expect(result!.pixelWidth).toBe(400)
    expect(result!.pixelHeight).toBe(300)
  })

  it('passes the correct drawImage source rectangle to the offscreen context', () => {
    const src = makeSourceCanvas(800, 1200, 400, 600)
    captureCanvasRegion(src as unknown as HTMLCanvasElement, {
      x: 50,
      y: 100,
      width: 200,
      height: 150,
    })
    const ctx = offscreenCanvas.getContext('2d') as MockContext
    expect(ctx.drawImage).toHaveBeenCalledWith(
      src,
      100, // srcX = 50 * 2
      200, // srcY = 100 * 2
      400, // srcW = 200 * 2
      300, // srcH = 150 * 2
      0,
      0,
      400,
      300,
    )
  })
})

describe('captureCanvasRegion – boundary clamping', () => {
  beforeEach(() => {
    offscreenCanvas.width = 0
    offscreenCanvas.height = 0
    ;(offscreenCanvas.getContext('2d') as MockContext).drawImage.mockClear()
  })

  it('clamps a region that extends beyond the right/bottom edge', () => {
    const src = makeSourceCanvas(300, 300, 300, 300)
    const result = captureCanvasRegion(src as unknown as HTMLCanvasElement, {
      x: 250,
      y: 250,
      width: 200, // would reach 450, clamped to 300
      height: 200,
    })
    expect(result).not.toBeNull()
    expect(result!.pixelWidth).toBe(50) // 300 - 250
    expect(result!.pixelHeight).toBe(50)
  })

  it('returns null for a region entirely outside the canvas', () => {
    const src = makeSourceCanvas(300, 300, 300, 300)
    const result = captureCanvasRegion(src as unknown as HTMLCanvasElement, {
      x: 400,
      y: 400,
      width: 50,
      height: 50,
    })
    expect(result).toBeNull()
  })

  it('returns null for a zero-area region', () => {
    const src = makeSourceCanvas(300, 300, 300, 300)
    const result = captureCanvasRegion(src as unknown as HTMLCanvasElement, {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
    expect(result).toBeNull()
  })
})

describe('captureCanvasRegion – invisible canvas guard', () => {
  it('returns null when the canvas has zero CSS size', () => {
    const src = makeSourceCanvas(300, 300, 0, 0)
    const result = captureCanvasRegion(src as unknown as HTMLCanvasElement, {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })
    expect(result).toBeNull()
  })

  it('returns null when getContext returns null (no 2d support)', () => {
    offscreenCanvas.getContext = () => null
    const src = makeSourceCanvas(400, 400, 400, 400)
    const result = captureCanvasRegion(src as unknown as HTMLCanvasElement, {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })
    expect(result).toBeNull()
    // Restore
    const ctx: MockContext = { drawImage: jest.fn() }
    offscreenCanvas.getContext = () => ctx
  })
})
