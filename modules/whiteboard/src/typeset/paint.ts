// Draws what ./layout.ts laid out onto a 2D canvas context — an
// HTMLCanvasElement's or an OffscreenCanvas's — at `scale` device pixels per
// world unit.

import type { DrawOp } from './layout'

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export type PaintOptions = Readonly<{
  scale: number
  width: number
  height: number
  /** How far above the bottom edge the content starts fading out, in world
   * units: the card's own content mask (styles/cards/content.css). 0 for
   * none. */
  fade: number
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
  ctx.rect(0, 0, width, height)
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
      case 'dot':
        ctx.fillStyle = op.color
        ctx.beginPath()
        ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2)
        ctx.fill()
        break
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
