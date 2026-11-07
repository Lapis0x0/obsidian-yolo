// Draws what ./layout.ts laid out onto a 2D canvas context — an
// HTMLCanvasElement's or an OffscreenCanvas's — at `scale` device pixels per
// world unit.

import type { DrawOp } from './layout'
import { mathTextFont } from './math'

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export type PaintOptions = Readonly<{
  scale: number
  width: number
  height: number
  /** How far above the bottom edge the content starts fading out, in world
   * units: the card's own content mask (styles/cards/content.css). 0 for
   * none. */
  fade: number
  /** How far in from the left and right edges it is cut off
   * (./tokens.ts's `contentClip`). */
  clip: Readonly<{ left: number; right: number }>
  /** The images drawn, by what the source names each; one left out is
   * drawn as its place. */
  images?: Readonly<Record<string, CanvasImageSource>>
}>

export function paint(
  ctx: Context2D,
  ops: readonly DrawOp[],
  options: PaintOptions,
): void {
  const { scale, width, height } = options
  ctx.save()
  ctx.scale(scale, scale)
  ctx.beginPath()
  ctx.rect(
    options.clip.left,
    0,
    width - options.clip.left - options.clip.right,
    height,
  )
  ctx.clip()
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  let font = ''
  for (const op of ops) {
    switch (op.op) {
      case 'text':
        if (op.font !== font) {
          ctx.font = op.font
          font = op.font
        }
        ctx.fillStyle = op.color
        ctx.fillText(op.text, op.x, op.y)
        break
      case 'rect':
        ctx.fillStyle = op.color
        if (op.radius > 0) {
          ctx.beginPath()
          ctx.roundRect(op.x, op.y, op.w, op.h, op.radius)
          ctx.fill()
        } else {
          ctx.fillRect(op.x, op.y, op.w, op.h)
        }
        break
      case 'frame':
        ctx.strokeStyle = op.color
        ctx.lineWidth = op.width
        ctx.beginPath()
        ctx.roundRect(op.x, op.y, op.w, op.h, op.radius)
        ctx.stroke()
        break
      case 'line':
        ctx.strokeStyle = op.color
        ctx.lineWidth = op.width
        ctx.beginPath()
        ctx.moveTo(op.x1, op.y1)
        ctx.lineTo(op.x2, op.y2)
        ctx.stroke()
        break
      case 'image': {
        const image = options.images?.[op.target]
        if (image) {
          if (op.radius > 0) {
            ctx.save()
            ctx.beginPath()
            ctx.roundRect(op.x, op.y, op.w, op.h, op.radius)
            ctx.clip()
            ctx.drawImage(image, op.x, op.y, op.w, op.h)
            ctx.restore()
          } else {
            ctx.drawImage(image, op.x, op.y, op.w, op.h)
          }
          break
        }
        // An image there is nothing to draw of: its place, kept.
        ctx.fillStyle = op.color
        ctx.fillRect(op.x, op.y, op.w, op.h)
        break
      }
      case 'dot':
        ctx.fillStyle = op.color
        ctx.beginPath()
        ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2)
        ctx.fill()
        break
      case 'math': {
        const { piece, size } = op
        for (const shape of piece.shapes) {
          ctx.fillStyle = shape.color ?? op.color
          if (shape.kind === 'path') {
            const [a, b, c, d, e, f] = shape.transform
            ctx.save()
            ctx.transform(
              a * size,
              b * size,
              c * size,
              d * size,
              op.x + e * size,
              op.y + f * size,
            )
            ctx.fill(pathOf(op.paths[shape.path]))
            ctx.restore()
          } else if (shape.kind === 'rect') {
            ctx.fillRect(
              op.x + shape.x * size,
              op.y + shape.y * size,
              shape.width * size,
              shape.height * size,
            )
          } else {
            font = mathTextFont(shape, size)
            ctx.font = font
            ctx.fillText(
              shape.text,
              op.x + shape.x * size,
              op.y + shape.y * size,
            )
          }
        }
        break
      }
      case 'check': {
        const s = op.size
        ctx.strokeStyle = op.color
        ctx.lineWidth = Math.max(1, s / 8)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        ctx.moveTo(op.x + s * 0.27, op.y + s * 0.52)
        ctx.lineTo(op.x + s * 0.43, op.y + s * 0.68)
        ctx.lineTo(op.x + s * 0.74, op.y + s * 0.34)
        ctx.stroke()
        break
      }
    }
  }
  if (options.fade > 0 && height > options.fade) {
    // The content mask: the last stretch fades to nothing.
    ctx.globalCompositeOperation = 'destination-out'
    const gradient = ctx.createLinearGradient(
      0,
      height - options.fade,
      0,
      height,
    )
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)')
    gradient.addColorStop(1, 'rgba(0, 0, 0, 1)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, height - options.fade, width, options.fade)
  }
  ctx.restore()
}

/** A formula's outlines, each parsed once: the same few glyphs recur. */
const PATHS = new Map<string, Path2D>()

function pathOf(d: string): Path2D {
  let path = PATHS.get(d)
  if (!path) {
    if (PATHS.size >= 4096) PATHS.clear()
    path = new Path2D(d)
    PATHS.set(d, path)
  }
  return path
}
