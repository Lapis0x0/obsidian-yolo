import { Minus, Plus, RotateCcw, Scan } from 'lucide-react'
import { App, setIcon } from 'obsidian'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../contexts/language-context'
import { ReactModal } from '../common/ReactModal'

const MIN_SCALE = 0.01
const MAX_SCALE = 8
const ZOOM_FACTOR = 1.2
const VIEWPORT_PADDING = 48

type Point = { x: number; y: number }
type ViewTransform = Point & { scale: number }

type PointerGesture =
  | { kind: 'drag'; last: Point }
  | {
      kind: 'pinch'
      startDistance: number
      startScale: number
      contentPoint: Point
    }

function getSvgSize(svg: SVGSVGElement): { width: number; height: number } {
  const width = Number.parseFloat(svg.getAttribute('width') ?? '')
  const height = Number.parseFloat(svg.getAttribute('height') ?? '')
  const viewBox = svg.viewBox.baseVal

  return {
    width: Number.isFinite(width) && width > 0 ? width : viewBox.width,
    height: Number.isFinite(height) && height > 0 ? height : viewBox.height,
  }
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

function getMidpoint(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  }
}

function getDistance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function MermaidViewerCanvas({
  svg,
}: {
  svg: SVGSVGElement
  onClose: () => void
}) {
  const { t } = useLanguage()
  const viewportRef = useRef<HTMLDivElement>(null)
  const svgHostRef = useRef<HTMLDivElement>(null)
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, scale: 1 })
  const pointersRef = useRef(new Map<number, Point>())
  const gestureRef = useRef<PointerGesture | null>(null)
  const [transform, setTransform] = useState<ViewTransform>(
    transformRef.current,
  )
  const svgSize = getSvgSize(svg)

  const updateTransform = useCallback((next: ViewTransform) => {
    transformRef.current = next
    setTransform(next)
  }, [])

  const centerAtScale = useCallback(
    (scale: number) => {
      const viewport = viewportRef.current
      if (!viewport) return

      const width = viewport.clientWidth
      const height = viewport.clientHeight
      updateTransform({
        x: (width - svgSize.width * scale) / 2,
        y: (height - svgSize.height * scale) / 2,
        scale,
      })
    },
    [svgSize.height, svgSize.width, updateTransform],
  )

  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport || svgSize.width <= 0 || svgSize.height <= 0) return

    const availableWidth = Math.max(
      1,
      viewport.clientWidth - VIEWPORT_PADDING * 2,
    )
    const availableHeight = Math.max(
      1,
      viewport.clientHeight - VIEWPORT_PADDING * 2,
    )
    centerAtScale(
      clampScale(
        Math.min(
          1,
          availableWidth / svgSize.width,
          availableHeight / svgSize.height,
        ),
      ),
    )
  }, [centerAtScale, svgSize.height, svgSize.width])

  const zoomAt = useCallback(
    (nextScale: number, focalPoint?: Point) => {
      const viewport = viewportRef.current
      if (!viewport) return

      const current = transformRef.current
      const scale = clampScale(nextScale)
      const focal = focalPoint ?? {
        x: viewport.clientWidth / 2,
        y: viewport.clientHeight / 2,
      }
      const contentX = (focal.x - current.x) / current.scale
      const contentY = (focal.y - current.y) / current.scale

      updateTransform({
        x: focal.x - contentX * scale,
        y: focal.y - contentY * scale,
        scale,
      })
    },
    [updateTransform],
  )

  useLayoutEffect(() => {
    const host = svgHostRef.current
    if (!host) return

    host.replaceChildren(svg)
    fitToViewport()
    return () => {
      host.replaceChildren()
    }
  }, [fitToViewport, svg])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()

      if (event.deltaY !== 0) {
        const factor = Math.exp(-event.deltaY * 0.002)
        zoomAt(transformRef.current.scale * factor, {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        })
        return
      }

      const current = transformRef.current
      updateTransform({
        ...current,
        x: current.x - event.deltaX,
      })
    }

    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      viewport.removeEventListener('wheel', handleWheel)
    }
  }, [updateTransform, zoomAt])

  const beginPinch = useCallback(() => {
    const points = Array.from(pointersRef.current.values())
    if (points.length < 2) return

    const midpoint = getMidpoint(points[0], points[1])
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const localMidpoint = {
      x: midpoint.x - rect.left,
      y: midpoint.y - rect.top,
    }
    const current = transformRef.current

    gestureRef.current = {
      kind: 'pinch',
      startDistance: Math.max(1, getDistance(points[0], points[1])),
      startScale: current.scale,
      contentPoint: {
        x: (localMidpoint.x - current.x) / current.scale,
        y: (localMidpoint.y - current.y) / current.scale,
      },
    }
  }, [])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return

    event.currentTarget.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    })

    if (pointersRef.current.size >= 2) {
      beginPinch()
    } else {
      gestureRef.current = {
        kind: 'drag',
        last: { x: event.clientX, y: event.clientY },
      }
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return

    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    })
    const gesture = gestureRef.current

    if (pointersRef.current.size >= 2) {
      if (!gesture || gesture.kind !== 'pinch') {
        beginPinch()
        return
      }

      const points = Array.from(pointersRef.current.values())
      const midpoint = getMidpoint(points[0], points[1])
      const viewport = viewportRef.current
      if (!viewport) return
      const rect = viewport.getBoundingClientRect()
      const scale = clampScale(
        gesture.startScale *
          (getDistance(points[0], points[1]) / gesture.startDistance),
      )
      updateTransform({
        x: midpoint.x - rect.left - gesture.contentPoint.x * scale,
        y: midpoint.y - rect.top - gesture.contentPoint.y * scale,
        scale,
      })
      return
    }

    if (gesture?.kind === 'drag') {
      const current = transformRef.current
      updateTransform({
        ...current,
        x: current.x + event.clientX - gesture.last.x,
        y: current.y + event.clientY - gesture.last.y,
      })
      gestureRef.current = {
        kind: 'drag',
        last: { x: event.clientX, y: event.clientY },
      }
    }
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const remainingPoint = pointersRef.current.values().next().value as
      | Point
      | undefined
    gestureRef.current = remainingPoint
      ? { kind: 'drag', last: remainingPoint }
      : null
  }

  const zoomOutLabel = t('chat.mermaidControls.zoomOut', 'Zoom out')
  const zoomInLabel = t('chat.mermaidControls.zoomIn', 'Zoom in')
  const fitWidthLabel = t(
    'chat.mermaidControls.fitViewport',
    'Fit diagram to window',
  )
  const resetLabel = t('chat.mermaidControls.reset', 'Reset zoom')
  const controlsLabel = t(
    'chat.mermaidControls.controlsLabel',
    'Diagram controls',
  )

  return (
    <div className="yolo-mermaid-modal-content">
      <div
        ref={viewportRef}
        className="yolo-mermaid-canvas"
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onKeyDown={(event) => {
          if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            zoomAt(transformRef.current.scale * ZOOM_FACTOR)
          } else if (event.key === '-') {
            event.preventDefault()
            zoomAt(transformRef.current.scale / ZOOM_FACTOR)
          } else if (event.key === '0') {
            event.preventDefault()
            centerAtScale(1)
          } else if (event.key.toLowerCase() === 'f') {
            event.preventDefault()
            fitToViewport()
          }
        }}
      >
        <div
          ref={svgHostRef}
          className="mermaid yolo-mermaid-canvas-content"
          style={{
            transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          }}
        />
      </div>

      <div
        className="yolo-mermaid-modal-controls"
        role="group"
        aria-label={controlsLabel}
      >
        <button
          type="button"
          className="yolo-mermaid-modal-control"
          aria-label={zoomOutLabel}
          title={zoomOutLabel}
          disabled={transform.scale <= MIN_SCALE}
          onClick={() => zoomAt(transformRef.current.scale / ZOOM_FACTOR)}
        >
          <Minus size={16} />
        </button>
        <span className="yolo-mermaid-modal-scale" aria-live="polite">
          {Math.round(transform.scale * 100)}%
        </span>
        <button
          type="button"
          className="yolo-mermaid-modal-control"
          aria-label={zoomInLabel}
          title={zoomInLabel}
          disabled={transform.scale >= MAX_SCALE}
          onClick={() => zoomAt(transformRef.current.scale * ZOOM_FACTOR)}
        >
          <Plus size={16} />
        </button>
        <span className="yolo-mermaid-modal-divider" aria-hidden="true" />
        <button
          type="button"
          className="yolo-mermaid-modal-control"
          aria-label={fitWidthLabel}
          title={fitWidthLabel}
          onClick={fitToViewport}
        >
          <Scan size={16} />
        </button>
        <button
          type="button"
          className="yolo-mermaid-modal-control"
          aria-label={resetLabel}
          title={resetLabel}
          onClick={() => centerAtScale(1)}
        >
          <RotateCcw size={15} />
        </button>
      </div>
    </div>
  )
}

function openMermaidViewer(app: App, svg: SVGSVGElement): void {
  new ReactModal({
    app,
    Component: MermaidViewerCanvas,
    props: { svg: svg.cloneNode(true) as SVGSVGElement },
    options: { className: 'yolo-mermaid-modal' },
  }).open()
}

export function setupMermaidViewers(
  app: App,
  containerEl: HTMLElement,
  openLabel: string,
): () => void {
  const ownerDocument = containerEl.ownerDocument

  const decorateMermaidElements = () => {
    containerEl
      .querySelectorAll<HTMLElement>('.mermaid')
      .forEach((mermaidEl) => {
        if (
          mermaidEl.parentElement?.classList.contains('yolo-mermaid-viewer')
        ) {
          return
        }

        const svg = mermaidEl.querySelector<SVGSVGElement>('svg')
        if (!svg) return

        const viewer = ownerDocument.createElement('div')
        viewer.className = 'yolo-mermaid-viewer'
        mermaidEl.before(viewer)
        viewer.appendChild(mermaidEl)

        const openButton = ownerDocument.createElement('button')
        openButton.type = 'button'
        openButton.className = 'yolo-mermaid-open-button'
        openButton.setAttribute('aria-label', openLabel)
        openButton.setAttribute('title', openLabel)
        setIcon(openButton, 'maximize-2')
        openButton.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          openMermaidViewer(app, svg)
        })
        viewer.appendChild(openButton)
      })
  }

  decorateMermaidElements()
  const Observer = ownerDocument.defaultView?.MutationObserver
  if (!Observer) {
    return () => {}
  }

  const observer = new Observer(decorateMermaidElements)
  observer.observe(containerEl, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
  }
}
