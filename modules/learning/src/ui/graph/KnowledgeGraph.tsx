import {
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import type { ProjectEventBus } from '../../domain/projectEventBus'
import type { OutlineProject } from '../../domain/types'

import {
  type GraphModel,
  type GraphNode,
  type GraphNodeKind,
  applyGraphEvent,
  purgeExiting,
  snapshotToGraph,
} from './graphModel'

type SimNode = SimulationNodeDatum & {
  id: string
  kind: GraphNodeKind
  parentId: string | null
}

type SimLink = SimulationLinkDatum<SimNode> & {
  id: string
  kind: 'hierarchy' | 'relation'
}

type Viewport = { x: number; y: number; zoom: number }

type Gesture =
  | {
      kind: 'pan'
      pointerId: number
      clientX: number
      clientY: number
      viewport: Viewport
    }
  | {
      kind: 'node'
      pointerId: number
      nodeId: string
      offsetX: number
      offsetY: number
    }

const radii: Record<GraphNodeKind, number> = { topic: 9, chapter: 6.5, kp: 4.5 }
const labelLengths: Record<GraphNodeKind, number> = {
  topic: 16,
  chapter: 12,
  kp: 8,
}
const EXIT_MS = 260
const MIN_ZOOM = 0.35
const MAX_ZOOM = 2.8

const fallbackTranslator = (_key: string, fallback: string) => fallback

export function KnowledgeGraph({
  eventBus,
  initialSnapshot,
  t = fallbackTranslator,
}: {
  eventBus: ProjectEventBus
  initialSnapshot: OutlineProject | null
  t?: (key: string, fallback: string) => string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const simulationRef = useRef<Simulation<SimNode, SimLink> | null>(null)
  const nodesRef = useRef(new Map<string, SimNode>())
  const pinnedNodeIdsRef = useRef(new Set<string>())
  const frameRef = useRef<number | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 })
  const sizeRef = useRef({ width: 600, height: 420 })
  const [model, setModel] = useState<GraphModel>(() =>
    snapshotToGraph(initialSnapshot),
  )
  const [frameVersion, setFrameVersion] = useState(0)
  const [viewport, setViewport] = useState(viewportRef.current)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [panning, setPanning] = useState(false)

  useEffect(() => {
    const exitTimers: ReturnType<typeof setTimeout>[] = []
    const unsubscribe = eventBus.subscribe((event) => {
      setModel((current) => applyGraphEvent(current, event))
      if (
        event.type === 'chapter_removed' ||
        event.type === 'knowledge_point_removed' ||
        event.type === 'relation_removed'
      ) {
        exitTimers.push(
          setTimeout(
            () => setModel((current) => purgeExiting(current)),
            EXIT_MS,
          ),
        )
      }
    })
    return () => {
      unsubscribe()
      exitTimers.forEach(clearTimeout)
    }
  }, [eventBus])

  const paintFrame = useCallback(() => {
    const simulation = simulationRef.current
    if (simulation && simulation.alpha() > simulation.alphaMin()) {
      simulation.tick()
      const { width, height } = sizeRef.current
      nodesRef.current.forEach((node) => {
        if (node.x == null || node.y == null) return
        const padding = radii[node.kind] + 14
        node.x = clamp(node.x, padding, width - padding)
        node.y = clamp(node.y, padding, height - padding)
      })
      setFrameVersion((version) => version + 1)
    }
    const ownerWindow = containerRef.current?.ownerDocument.defaultView
    if (ownerWindow)
      frameRef.current = ownerWindow.requestAnimationFrame(paintFrame)
  }, [])

  useLayoutEffect(() => {
    const container = containerRef.current
    const ownerWindow = container?.ownerDocument.defaultView
    if (!container || !ownerWindow) return
    sizeRef.current = {
      width: container.clientWidth || 600,
      height: container.clientHeight || 420,
    }
    const linkForce = forceLink<SimNode, SimLink>([])
      .id((node) => node.id)
      .distance((link) => (link.kind === 'relation' ? 90 : 72))
      .strength((link) => (link.kind === 'relation' ? 0.14 : 0.7))
    const simulation = forceSimulation<SimNode>([])
      .force('charge', forceManyBody<SimNode>().strength(-200))
      .force('link', linkForce)
      .force(
        'collide',
        forceCollide<SimNode>((node) => radii[node.kind] * 2.2 + 8),
      )
      .force('x', forceX<SimNode>(sizeRef.current.width / 2).strength(0.02))
      .force('y', forceY<SimNode>(sizeRef.current.height / 2).strength(0.02))
      .stop()
    simulationRef.current = simulation
    frameRef.current = ownerWindow.requestAnimationFrame(paintFrame)

    const ResizeObserverConstructor = ownerWindow.ResizeObserver
    const observer = ResizeObserverConstructor
      ? new ResizeObserverConstructor(([entry]) => {
          if (
            !entry ||
            entry.contentRect.width <= 0 ||
            entry.contentRect.height <= 0
          )
            return
          sizeRef.current = {
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          }
          simulation.force(
            'x',
            forceX<SimNode>(entry.contentRect.width / 2).strength(0.02),
          )
          simulation.force(
            'y',
            forceY<SimNode>(entry.contentRect.height / 2).strength(0.02),
          )
          nodesRef.current.forEach((node) => {
            if (
              node.kind === 'topic' &&
              !pinnedNodeIdsRef.current.has(node.id)
            ) {
              node.fx = entry.contentRect.width / 2
              node.fy = entry.contentRect.height / 2
            }
          })
          simulation.alpha(0.3)
        })
      : null
    observer?.observe(container)
    return () => {
      if (frameRef.current != null)
        ownerWindow.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      observer?.disconnect()
      simulation.stop()
      simulationRef.current = null
    }
  }, [paintFrame])

  useLayoutEffect(() => {
    const simulation = simulationRef.current
    if (!simulation) return
    const { width, height } = sizeRef.current
    const liveIds = new Set(model.nodes.map((node) => node.id))
    for (const id of nodesRef.current.keys()) {
      if (!liveIds.has(id)) {
        nodesRef.current.delete(id)
        pinnedNodeIdsRef.current.delete(id)
      }
    }
    const chapters = model.nodes.filter((node) => node.kind === 'chapter')
    model.nodes.forEach((node) => {
      const existing = nodesRef.current.get(node.id)
      if (existing) {
        existing.parentId = node.parentId
        return
      }
      const seed = seedPosition(node, chapters, nodesRef.current, width, height)
      nodesRef.current.set(node.id, {
        ...seed,
        id: node.id,
        kind: node.kind,
        parentId: node.parentId,
      })
    })
    const simulationNodes = model.nodes.map(
      (node) => nodesRef.current.get(node.id)!,
    )
    const links = model.edges
      .filter(
        (edge) =>
          nodesRef.current.has(edge.sourceId) &&
          nodesRef.current.has(edge.targetId),
      )
      .map((edge) => ({
        id: edge.id,
        kind: edge.kind,
        source: edge.sourceId,
        target: edge.targetId,
      }))
    simulation.nodes(simulationNodes)
    const linkForce = simulation.force('link') as ReturnType<
      typeof forceLink<SimNode, SimLink>
    >
    linkForce.links(links)
    simulation.alpha(0.65)
  }, [model.edges, model.nodes])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const rect = svg.getBoundingClientRect()
      const pointerX = event.clientX - rect.left
      const pointerY = event.clientY - rect.top
      const current = viewportRef.current
      const nextZoom = clamp(
        current.zoom * Math.exp(-clamp(event.deltaY, -120, 120) * 0.001),
        MIN_ZOOM,
        MAX_ZOOM,
      )
      const graphX = (pointerX - current.x) / current.zoom
      const graphY = (pointerY - current.y) / current.zoom
      const next = {
        zoom: nextZoom,
        x: pointerX - graphX * nextZoom,
        y: pointerY - graphY * nextZoom,
      }
      viewportRef.current = next
      setViewport(next)
    }
    svg.addEventListener('wheel', handleWheel, { passive: false })
    return () => svg.removeEventListener('wheel', handleWheel)
  }, [])

  const graphPoint = (event: ReactPointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    const current = viewportRef.current
    return {
      x: (event.clientX - rect.left - current.x) / current.zoom,
      y: (event.clientY - rect.top - current.y) / current.zoom,
    }
  }

  const beginPan = (event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0 || gestureRef.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      kind: 'pan',
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      viewport: viewportRef.current,
    }
    setPanning(true)
  }

  const beginNodeDrag = (event: ReactPointerEvent<SVGGElement>, id: string) => {
    if (event.button !== 0 || gestureRef.current) return
    const point = graphPoint(event)
    const node = nodesRef.current.get(id)
    if (!point || !node || node.x == null || node.y == null) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      kind: 'node',
      pointerId: event.pointerId,
      nodeId: id,
      offsetX: point.x - node.x,
      offsetY: point.y - node.y,
    }
    node.fx = node.x
    node.fy = node.y
    pinnedNodeIdsRef.current.add(id)
    setDraggingNodeId(id)
  }

  const moveGesture = (event: ReactPointerEvent) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    if (gesture.kind === 'pan') {
      const next = {
        ...gesture.viewport,
        x: gesture.viewport.x + event.clientX - gesture.clientX,
        y: gesture.viewport.y + event.clientY - gesture.clientY,
      }
      viewportRef.current = next
      setViewport(next)
      return
    }
    const point = graphPoint(event)
    const node = nodesRef.current.get(gesture.nodeId)
    if (!point || !node) return
    node.fx = point.x - gesture.offsetX
    node.fy = point.y - gesture.offsetY
    node.x = node.fx
    node.y = node.fy
    simulationRef.current?.alpha(0.25)
    setFrameVersion((version) => version + 1)
  }

  const endGesture = (event: ReactPointerEvent<Element>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    setPanning(false)
    setDraggingNodeId(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const resetViewport = () => {
    const next = { x: 0, y: 0, zoom: 1 }
    viewportRef.current = next
    setViewport(next)
  }

  const positions = nodesRef.current
  const knowledgePointCount = model.nodes.filter(
    (node) => node.kind === 'kp',
  ).length
  const relationCount = model.edges.filter(
    (edge) => edge.kind === 'relation',
  ).length
  void frameVersion

  return (
    <div
      className="yolo-learning-graph-root"
      data-focused-id={model.focusedId ?? ''}
    >
      <div className="yolo-learning-graph-header">
        <span className="yolo-learning-graph-stats">
          {formatText(t('learning.graph.knowledgePoints', '{count} 知识点'), {
            count: knowledgePointCount,
          })}
          {' · '}
          {formatText(t('learning.graph.relations', '{count} 关系'), {
            count: relationCount,
          })}
        </span>
      </div>
      <div className="yolo-learning-graph-canvas" ref={containerRef}>
        <svg
          aria-label={t('learning.tabs.knowledgeMap', '知识地图')}
          className="yolo-learning-graph-svg"
          data-panning={panning ? 'true' : 'false'}
          onDoubleClick={resetViewport}
          ref={svgRef}
          role="img"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect
            className="yolo-learning-graph-pan-surface"
            height="100%"
            onLostPointerCapture={endGesture}
            onPointerCancel={endGesture}
            onPointerDown={beginPan}
            onPointerMove={moveGesture}
            onPointerUp={endGesture}
            width="100%"
          />
          <g
            className="yolo-learning-graph-viewport"
            transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}
          >
            <g className="yolo-learning-graph-edges">
              {model.edges.map((edge) => {
                const source = positions.get(edge.sourceId)
                const target = positions.get(edge.targetId)
                const midpoint = {
                  x: ((source?.x ?? 0) + (target?.x ?? 0)) / 2,
                  y: ((source?.y ?? 0) + (target?.y ?? 0)) / 2,
                }
                return (
                  <g
                    className="yolo-learning-graph-edge"
                    data-edge-kind={edge.kind}
                    data-exiting={edge.exiting ? 'true' : 'false'}
                    data-type={edge.type ?? ''}
                    key={edge.id}
                  >
                    <line
                      className="yolo-learning-graph-edge-half"
                      x1={source?.x}
                      x2={midpoint.x}
                      y1={source?.y}
                      y2={midpoint.y}
                    />
                    <line
                      className="yolo-learning-graph-edge-half"
                      x1={target?.x}
                      x2={midpoint.x}
                      y1={target?.y}
                      y2={midpoint.y}
                    />
                  </g>
                )
              })}
            </g>
            <g className="yolo-learning-graph-nodes">
              {model.nodes.map((node) => {
                const position = positions.get(node.id)
                const focused = node.id === model.focusedId
                const expanded = expandedIds.has(node.id)
                const expandIds =
                  node.kind === 'chapter'
                    ? model.nodes
                        .filter(
                          (candidate) =>
                            candidate.id === node.id ||
                            (candidate.kind === 'kp' &&
                              candidate.parentId === node.id),
                        )
                        .map((candidate) => candidate.id)
                    : [node.id]
                const truncated = expandIds.some((id) => {
                  const candidate = model.nodes.find((item) => item.id === id)
                  return candidate
                    ? candidate.title.length > labelLengths[candidate.kind]
                    : false
                })
                return (
                  <g
                    className="yolo-learning-graph-node"
                    data-dragging={
                      draggingNodeId === node.id ? 'true' : 'false'
                    }
                    data-entering={node.entering ? 'true' : 'false'}
                    data-exiting={node.exiting ? 'true' : 'false'}
                    data-focused={focused ? 'true' : 'false'}
                    data-kind={node.kind}
                    data-status={node.status}
                    key={node.id}
                    onLostPointerCapture={endGesture}
                    onPointerCancel={endGesture}
                    onPointerDown={(event) => beginNodeDrag(event, node.id)}
                    onPointerEnter={
                      truncated
                        ? () =>
                            setExpandedIds((ids) => {
                              const next = new Set(ids)
                              expandIds.forEach((id) => next.add(id))
                              return next
                            })
                        : undefined
                    }
                    onPointerMove={moveGesture}
                    onPointerUp={endGesture}
                  >
                    <circle
                      className="yolo-learning-graph-node-dot"
                      cx={position?.x}
                      cy={position?.y}
                      r={radii[node.kind]}
                    >
                      {focused ? (
                        <animate
                          attributeName="r"
                          dur="1.4s"
                          repeatCount="indefinite"
                          values={`${radii[node.kind]};${radii[node.kind] * 1.15};${radii[node.kind]}`}
                        />
                      ) : null}
                    </circle>
                    <text
                      className="yolo-learning-graph-node-label"
                      data-expanded={expanded ? 'true' : 'false'}
                      data-focused={focused ? 'true' : 'false'}
                      textAnchor="middle"
                      x={position?.x}
                      y={(position?.y ?? 0) - radii[node.kind] - 5}
                    >
                      {expanded ? node.title : truncate(node)}
                    </text>
                  </g>
                )
              })}
            </g>
          </g>
        </svg>
        {model.nodes.length === 0 ? (
          <div className="yolo-learning-graph-empty">
            {t('learning.graph.empty', '等待学习主题生成…')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function seedPosition(
  node: GraphNode,
  chapters: GraphNode[],
  nodes: Map<string, SimNode>,
  width: number,
  height: number,
) {
  const center = { x: width / 2, y: height / 2 }
  if (node.kind === 'topic') return { ...center, fx: center.x, fy: center.y }
  const jitter = () => (Math.random() - 0.5) * 24
  if (node.kind === 'chapter') {
    const angle =
      (chapters.findIndex((chapter) => chapter.id === node.id) /
        Math.max(chapters.length, 1)) *
      Math.PI *
      2
    return {
      x: center.x + Math.cos(angle) * 132 + jitter(),
      y: center.y + Math.sin(angle) * 132 + jitter(),
    }
  }
  const parent = node.parentId ? nodes.get(node.parentId) : null
  return {
    x: (parent?.x ?? center.x) + jitter(),
    y: (parent?.y ?? center.y) + jitter(),
  }
}

function truncate(node: GraphNode) {
  const length = labelLengths[node.kind]
  return node.title.length <= length
    ? node.title
    : `${node.title.slice(0, length)}…`
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function formatText(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    template,
  )
}
