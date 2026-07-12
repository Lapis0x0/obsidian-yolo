import { useEffect, useRef } from 'react'

import { ReasoningSparkRenderer } from './reasoningSparkRenderer'

type ReasoningSparkCanvasProps = {
  active: boolean
}

export function ReasoningSparkCanvas({ active }: ReasoningSparkCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<ReasoningSparkRenderer | null>(null)
  const activeRef = useRef(active)
  const syncRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ownerWindow = canvas?.ownerDocument.defaultView
    if (!canvas || !ownerWindow) return

    const reducedMotion = ownerWindow.matchMedia(
      '(prefers-reduced-motion: reduce)',
    )
    const sync = () => {
      if (activeRef.current && !reducedMotion.matches) {
        rendererRef.current ??= new ReasoningSparkRenderer(canvas)
        rendererRef.current.setActive(true)
        return
      }
      rendererRef.current?.setActive(false)
    }

    syncRef.current = sync
    reducedMotion.addEventListener('change', sync)
    sync()

    return () => {
      reducedMotion.removeEventListener('change', sync)
      syncRef.current = null
      rendererRef.current?.destroy()
      rendererRef.current = null
    }
  }, [])

  useEffect(() => {
    activeRef.current = active
    syncRef.current?.()
  }, [active])

  return (
    <canvas
      ref={canvasRef}
      className="yolo-reasoning-slider__spark-canvas"
      aria-hidden="true"
    />
  )
}
