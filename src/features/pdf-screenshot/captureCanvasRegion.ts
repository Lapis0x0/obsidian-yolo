/**
 * captureCanvasRegion.ts
 *
 * Pure function: crop a rectangular region from a source HTMLCanvasElement
 * (typically a PDF.js-rendered page canvas) and return a base64 PNG string.
 *
 * High-DPI (retina) handling:
 *   PDF.js draws at device-pixel-ratio resolution, so the canvas's `width` /
 *   `height` properties are larger than its CSS display size. We compute the
 *   backing-store scale factor and multiply the CSS-space rectangle by it
 *   before sampling, so retina screenshots are not blurry.
 */

export type RegionRect = {
  /** CSS-space X offset relative to the canvas's top-left corner (px) */
  x: number
  /** CSS-space Y offset (px) */
  y: number
  /** CSS-space width (px) */
  width: number
  /** CSS-space height (px) */
  height: number
}

export type CaptureCanvasRegionResult = {
  /** base64-encoded PNG (no data-URL prefix) */
  base64: string
  /** pixel width of the captured image */
  pixelWidth: number
  /** pixel height of the captured image */
  pixelHeight: number
}

/**
 * Capture a region from `sourceCanvas` and return a base64 PNG.
 *
 * @param sourceCanvas  The PDF.js canvas element to sample from.
 * @param region        CSS-pixel rectangle relative to the canvas's top-left.
 *
 * The region is clamped to the canvas bounds before sampling, so callers do
 * not need to pre-validate it. Returns null when the clamped area is empty.
 */
export function captureCanvasRegion(
  sourceCanvas: HTMLCanvasElement,
  region: RegionRect,
): CaptureCanvasRegionResult | null {
  const cssWidth = sourceCanvas.getBoundingClientRect().width
  const cssHeight = sourceCanvas.getBoundingClientRect().height

  // Avoid division-by-zero for invisible canvases
  if (cssWidth === 0 || cssHeight === 0) {
    return null
  }

  // Scale factors: backing store pixels per CSS pixel
  const scaleX = sourceCanvas.width / cssWidth
  const scaleY = sourceCanvas.height / cssHeight

  // Convert CSS-space region to backing-store pixels
  const rawSrcX = region.x * scaleX
  const rawSrcY = region.y * scaleY
  const rawSrcW = region.width * scaleX
  const rawSrcH = region.height * scaleY

  // Clamp to canvas backing-store bounds
  const srcX = Math.max(0, Math.round(rawSrcX))
  const srcY = Math.max(0, Math.round(rawSrcY))
  const srcX2 = Math.min(sourceCanvas.width, Math.round(rawSrcX + rawSrcW))
  const srcY2 = Math.min(sourceCanvas.height, Math.round(rawSrcY + rawSrcH))
  const srcW = srcX2 - srcX
  const srcH = srcY2 - srcY

  if (srcW <= 0 || srcH <= 0) {
    return null
  }

  const offscreen = document.createElement('canvas')
  offscreen.width = srcW
  offscreen.height = srcH

  const ctx = offscreen.getContext('2d')
  if (!ctx) {
    return null
  }

  ctx.drawImage(sourceCanvas, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH)

  // Strip the "data:image/png;base64," prefix
  const dataUrl = offscreen.toDataURL('image/png')
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')

  return { base64, pixelWidth: srcW, pixelHeight: srcH }
}
