// How a board export is cut up: the picture's size in pixels, and the parts
// it is made in (ui/export/boardExport.ts). DOM-free (Module Boundaries,
// CLAUDE.md).
//
// A part is what one camera stop photographs, so it is never larger than the
// viewport the camera shows it in, nor than a canvas comfortably holds. The
// parts are made a row at a time, and a row is written out whole before the
// next is begun, so how tall a row may be is set by how many bytes a whole
// row of pixels takes — which is what keeps the memory an export needs
// independent of how large the picture is.

export type ExportRect = Readonly<{
  x: number
  y: number
  w: number
  h: number
}>

/** Room left round what is exported, in world units. */
export const EXPORT_PADDING = 40

/**
 * The largest picture one canvas holds: Chromium's limit on a side and on
 * the area. Past it a picture can still be written to a file, a row at a
 * time, but not copied to the clipboard, which takes one image whole.
 */
export const CANVAS_MAX_SIDE = 16384
export const CANVAS_MAX_AREA = 16384 * 16384

/** A part's largest side in pixels: a canvas, and the pixels read back from
 * it, of a size a desktop renderer handles without strain. */
const TILE_MAX_PX = 4096

/** What one row of parts may hold, as RGB bytes. */
const ROW_BUDGET_BYTES = 512 * 1024 * 1024

export type ExportTile = Readonly<{
  /** Where the part is in the picture, in pixels. */
  px: Readonly<{ x: number; y: number; w: number; h: number }>
  /** The same part on the board, in world units. */
  world: ExportRect
}>

export type ExportRow = Readonly<{
  y: number
  h: number
  tiles: readonly ExportTile[]
}>

/** The picture `region` makes at `pixelRatio` pixels per world unit. */
export function exportPixelSize(
  region: ExportRect,
  pixelRatio: number,
): Readonly<{ width: number; height: number }> {
  return {
    width: Math.max(1, Math.ceil(region.w * pixelRatio)),
    height: Math.max(1, Math.ceil(region.h * pixelRatio)),
  }
}

/** Whether the picture can be made on one canvas — what copying it needs. */
export function fitsOneCanvas(
  size: Readonly<{ width: number; height: number }>,
): boolean {
  return (
    size.width <= CANVAS_MAX_SIDE &&
    size.height <= CANVAS_MAX_SIDE &&
    size.width * size.height <= CANVAS_MAX_AREA
  )
}

/** What an export covers: the rectangles of what is in it, with room round
 * them. Null for nothing. */
export function exportRegion(rects: readonly ExportRect[]): ExportRect | null {
  if (rects.length === 0) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.w)
    bottom = Math.max(bottom, rect.y + rect.h)
  }
  return {
    x: left - EXPORT_PADDING,
    y: top - EXPORT_PADDING,
    w: right - left + EXPORT_PADDING * 2,
    h: bottom - top + EXPORT_PADDING * 2,
  }
}

/**
 * The rows of parts that make the picture of `region`, top to bottom, each
 * row's parts left to right, given the viewport a part is photographed in
 * (world units, the camera at scale 1).
 */
export function exportRows(
  region: ExportRect,
  pixelRatio: number,
  viewport: Readonly<{ w: number; h: number }>,
  rowBudgetBytes = ROW_BUDGET_BYTES,
): ExportRow[] {
  const { width, height } = exportPixelSize(region, pixelRatio)
  const tileW = Math.max(
    1,
    Math.min(TILE_MAX_PX, Math.floor(viewport.w * pixelRatio), width),
  )
  const rowH = Math.max(
    1,
    Math.min(
      TILE_MAX_PX,
      Math.floor(viewport.h * pixelRatio),
      Math.floor(rowBudgetBytes / (width * 3)),
      height,
    ),
  )
  const rows: ExportRow[] = []
  for (let y = 0; y < height; y += rowH) {
    const h = Math.min(rowH, height - y)
    const tiles: ExportTile[] = []
    for (let x = 0; x < width; x += tileW) {
      const w = Math.min(tileW, width - x)
      tiles.push({
        px: { x, y, w, h },
        world: {
          x: region.x + x / pixelRatio,
          y: region.y + y / pixelRatio,
          w: w / pixelRatio,
          h: h / pixelRatio,
        },
      })
    }
    rows.push({ y, h, tiles })
  }
  return rows
}
