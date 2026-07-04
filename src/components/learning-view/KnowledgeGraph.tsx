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
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { ProjectEventBus } from '../../core/learning/projectEventBus'
import type {
  LearningEvent,
  Project,
  RelationType,
} from '../../core/learning/types'

import { formatLearningText } from './i18n'

/**
 * KnowledgeGraph — a force-directed knowledge graph that *grows* in response
 * to the LearningEvent stream, tuned to feel like a calm relative of
 * Obsidian's native Graph View.
 *
 * Structure (hierarchical radial layout):
 *   - One central **topic** node (the learning subject), pinned to the center.
 *   - **chapter** nodes orbit the topic (larger hollow rings, always labeled).
 *   - **knowledge-point** nodes orbit their chapter (small filled dots).
 *   - Hierarchy "skeleton" edges (topic→chapter, chapter→kp) form the spine;
 *     prereq/related relation edges between knowledge points layer on top.
 * This mirrors how the data is produced (topic, then chapters, then points,
 * then relations), so the graph visibly grows outward from its subject.
 *
 * Architecture
 *   - React owns *structure*: which nodes/edges exist (keyed SVG elements).
 *   - d3-force owns *position*: a manually-ticked simulation mutates x/y.
 *   - A single requestAnimationFrame loop advances the simulation, writes
 *     positions straight onto SVG attributes (bypassing React reconciliation),
 *     and drives the focus pulse. Nodes/edges are never re-rendered per frame.
 *
 * Motion (all restrained; no web-y embellishments):
 *   - New node: CSS fade-in + tiny scale-up (~300ms).
 *   - New edge: both halves draw from each endpoint toward the midpoint (~250ms).
 *   - Focused node: slow ±15% radius pulse (~1.4s); stops when focus clears.
 *   - Removal: brief fade-out, then the simulation re-settles.
 *
 * Palette is bound to Obsidian theme variables only (see knowledge-graph.css),
 * so the graph follows the user's light/dark theme automatically.
 */

export type NodeKind = 'topic' | 'chapter' | 'kp'
export type EdgeKind = 'hierarchy' | 'relation'
export type NodeStatus = 'generating' | 'completed'

export type GraphNode = {
  id: string
  kind: NodeKind
  title: string
  /** topic → null; chapter → topic id; kp → chapter id. */
  parentId: string | null
  status: NodeStatus
  entering: boolean
  exiting: boolean
}

export type GraphEdge = {
  id: string
  kind: EdgeKind
  sourceId: string
  targetId: string
  /** Only meaningful for relation edges; null for hierarchy edges. */
  type: RelationType | null
  label?: string
  entering: boolean
  exiting: boolean
}

export type KnowledgeGraphProps = {
  eventBus: ProjectEventBus
  /**
   * Initial snapshot to render synchronously on mount. If null, the component
   * waits for a `project_initialized` event. Initial content is drawn WITHOUT
   * animation.
   */
  initialSnapshot: Project | null
}

type GraphModel = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  focusedId: string | null
  projectTopic: string | null
}

type SimNode = SimulationNodeDatum & {
  id: string
  kind: NodeKind
  parentId: string | null
}

type SimLink = SimulationLinkDatum<SimNode> & {
  id: string
  kind: EdgeKind
}

const RADIUS_BY_KIND: Record<NodeKind, number> = {
  topic: 9,
  chapter: 6.5,
  kp: 4.5,
}
const EDGE_DRAW_MS = 250
const EXIT_MS = 260
const PULSE_MS = 1400
const PULSE_AMPLITUDE = 0.15
/** Above this knowledge-point count, non-focused kp labels fade out. */
const LABEL_DENSE_THRESHOLD = 16

const TOPIC_PREFIX = '__topic__'
const HIER_PREFIX = 'hier'

export function KnowledgeGraph({
  eventBus,
  initialSnapshot,
}: KnowledgeGraphProps) {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const [graph, setGraph] = useState<GraphModel>(() =>
    snapshotToGraph(initialSnapshot),
  )
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)

  // ── Simulation + per-frame DOM handles (never trigger React renders) ──────
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null)
  const linkForceRef = useRef<ReturnType<
    typeof forceLink<SimNode, SimLink>
  > | null>(null)
  const simNodesRef = useRef<Map<string, SimNode>>(new Map())
  const pinnedNodeIdsRef = useRef<Set<string>>(new Set())
  const dragRef = useRef<{ id: string; pointerId: number } | null>(null)
  const sizeRef = useRef<{ width: number; height: number }>({
    width: 600,
    height: 420,
  })

  const circleEls = useRef<Map<string, SVGCircleElement>>(new Map())
  const labelEls = useRef<Map<string, SVGTextElement>>(new Map())
  const edgeAEls = useRef<Map<string, SVGLineElement>>(new Map())
  const edgeBEls = useRef<Map<string, SVGLineElement>>(new Map())
  const edgeMetaRef = useRef<
    Map<string, { sourceId: string; targetId: string }>
  >(new Map())
  /** edgeId → animation start timestamp; absent means already fully drawn. */
  const edgeDrawStartRef = useRef<Map<string, number>>(new Map())
  const knownEdgeIdsRef = useRef<Set<string>>(new Set())
  const focusedIdRef = useRef<string | null>(graph.focusedId)
  const rafRef = useRef<number | null>(null)

  // ── Event subscription ────────────────────────────────────────────────────
  useEffect(() => {
    const exitTimers: ReturnType<typeof setTimeout>[] = []
    const handleEvent = (event: LearningEvent) => {
      setGraph((prev) => applyEvent(prev, event))
      if (
        event.type === 'knowledge_point_removed' ||
        event.type === 'relation_removed' ||
        event.type === 'chapter_removed'
      ) {
        const timer = setTimeout(() => {
          setGraph((prev) => purgeExiting(prev))
        }, EXIT_MS)
        exitTimers.push(timer)
      }
    }
    const unsubscribe = eventBus.subscribe(handleEvent)
    return () => {
      unsubscribe()
      for (const timer of exitTimers) clearTimeout(timer)
    }
  }, [eventBus])

  const renderFrame = useCallback((now: number) => {
    const sim = simRef.current
    if (sim && sim.alpha() > sim.alphaMin()) {
      sim.tick()
    }

    const { width, height } = sizeRef.current
    const simNodes = simNodesRef.current
    const focusedId = focusedIdRef.current

    // Clamp positions so nodes never drift out of view.
    simNodes.forEach((n) => {
      if (n.x == null || n.y == null) return
      const pad = RADIUS_BY_KIND[n.kind] + 14
      n.x = clamp(n.x, pad, width - pad)
      n.y = clamp(n.y, pad, height - pad)
    })

    // Nodes + labels.
    circleEls.current.forEach((circle, id) => {
      const n = simNodes.get(id)
      if (!n || n.x == null || n.y == null) return
      const baseR = RADIUS_BY_KIND[n.kind]
      let r = baseR
      if (id === focusedId) {
        const phase = (now % PULSE_MS) / PULSE_MS
        r = baseR * (1 + PULSE_AMPLITUDE * Math.sin(phase * 2 * Math.PI))
      }
      circle.setAttribute('cx', n.x.toFixed(2))
      circle.setAttribute('cy', n.y.toFixed(2))
      circle.setAttribute('r', r.toFixed(2))
      const label = labelEls.current.get(id)
      if (label) {
        label.setAttribute('x', n.x.toFixed(2))
        label.setAttribute('y', (n.y - baseR - 5).toFixed(2))
      }
    })

    // Edges drawn as two halves so a fresh edge grows from both endpoints
    // toward the midpoint, then forms one continuous line at full draw.
    edgeAEls.current.forEach((lineA, id) => {
      const lineB = edgeBEls.current.get(id)
      const meta = edgeMetaRef.current.get(id)
      if (!lineB || !meta) return
      const s = simNodes.get(meta.sourceId)
      const t = simNodes.get(meta.targetId)
      if (
        !s ||
        !t ||
        s.x == null ||
        s.y == null ||
        t.x == null ||
        t.y == null
      ) {
        return
      }

      const start = edgeDrawStartRef.current.get(id)
      let progress = 1
      if (start != null) {
        const raw = Math.min(1, (now - start) / EDGE_DRAW_MS)
        progress = easeOut(raw)
        if (raw >= 1) edgeDrawStartRef.current.delete(id)
      }

      const mx = (s.x + t.x) / 2
      const my = (s.y + t.y) / 2
      const ax = s.x + (mx - s.x) * progress
      const ay = s.y + (my - s.y) * progress
      const bx = t.x + (mx - t.x) * progress
      const by = t.y + (my - t.y) * progress

      lineA.setAttribute('x1', s.x.toFixed(2))
      lineA.setAttribute('y1', s.y.toFixed(2))
      lineA.setAttribute('x2', ax.toFixed(2))
      lineA.setAttribute('y2', ay.toFixed(2))
      lineB.setAttribute('x1', t.x.toFixed(2))
      lineB.setAttribute('y1', t.y.toFixed(2))
      lineB.setAttribute('x2', bx.toFixed(2))
      lineB.setAttribute('y2', by.toFixed(2))
    })
  }, [])

  const resolvePointerPosition = useCallback((event: React.PointerEvent) => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }
  }, [])

  const handleNodePointerDown = useCallback(
    (event: React.PointerEvent<SVGGElement>, id: string) => {
      if (event.button !== 0) return
      const position = resolvePointerPosition(event)
      const node = simNodesRef.current.get(id)
      if (!position || !node) return

      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { id, pointerId: event.pointerId }
      pinnedNodeIdsRef.current.add(id)
      setDraggingNodeId(id)

      node.fx = position.x
      node.fy = position.y
      node.x = position.x
      node.y = position.y
      simRef.current?.alpha(Math.max(simRef.current.alpha(), 0.35))
      renderFrame(performance.now())
    },
    [renderFrame, resolvePointerPosition],
  )

  const handleNodePointerMove = useCallback(
    (event: React.PointerEvent<SVGGElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const position = resolvePointerPosition(event)
      const node = simNodesRef.current.get(drag.id)
      if (!position || !node) return

      event.preventDefault()
      node.fx = position.x
      node.fy = position.y
      node.x = position.x
      node.y = position.y
      simRef.current?.alpha(Math.max(simRef.current.alpha(), 0.25))
      renderFrame(performance.now())
    },
    [renderFrame, resolvePointerPosition],
  )

  const handleNodePointerUp = useCallback(
    (event: React.PointerEvent<SVGGElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return

      event.preventDefault()
      dragRef.current = null
      setDraggingNodeId(null)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      simRef.current?.alpha(Math.max(simRef.current.alpha(), 0.12))
    },
    [],
  )

  const reconcileSimulation = useCallback(
    (model: GraphModel) => {
      const sim = simRef.current
      const linkForce = linkForceRef.current
      if (!sim || !linkForce) return

      const simNodes = simNodesRef.current
      const { width, height } = sizeRef.current
      const cx = width / 2
      const cy = height / 2
      const modelNodeIds = new Set(model.nodes.map((n) => n.id))

      // Drop simulation nodes no longer in the model.
      for (const id of [...simNodes.keys()]) {
        if (!modelNodeIds.has(id)) {
          simNodes.delete(id)
          pinnedNodeIdsRef.current.delete(id)
        }
      }

      // Index chapters for even radial distribution of their seed positions.
      const chapterOrder = new Map<string, number>()
      let chapterTotal = 0
      for (const node of model.nodes) {
        if (node.kind === 'chapter') {
          chapterOrder.set(node.id, chapterTotal)
          chapterTotal += 1
        }
      }

      for (const node of model.nodes) {
        const existing = simNodes.get(node.id)
        if (existing) {
          existing.parentId = node.parentId
          if (node.kind === 'topic' && !pinnedNodeIdsRef.current.has(node.id)) {
            existing.fx = cx
            existing.fy = cy
          }
          continue
        }
        const seed = seedPosition(
          node,
          simNodes,
          chapterOrder,
          chapterTotal,
          cx,
          cy,
        )
        const simNode: SimNode = {
          id: node.id,
          kind: node.kind,
          parentId: node.parentId,
          x: seed.x,
          y: seed.y,
        }
        if (node.kind === 'topic') {
          simNode.fx = cx
          simNode.fy = cy
        }
        simNodes.set(node.id, simNode)
      }

      const nodesArr = model.nodes.map((n) => simNodes.get(n.id) as SimNode)
      // Only keep edges whose endpoints both exist (defensive against ordering).
      const linksArr: SimLink[] = []
      for (const e of model.edges) {
        if (simNodes.has(e.sourceId) && simNodes.has(e.targetId)) {
          linksArr.push({
            id: e.id,
            kind: e.kind,
            source: e.sourceId,
            target: e.targetId,
          })
        }
      }

      sim.nodes(nodesArr)
      linkForce.links(linksArr)

      // Track edge metadata + schedule draw animation for freshly-added edges.
      edgeMetaRef.current.clear()
      const now = performance.now()
      const liveEdgeIds = new Set<string>()
      for (const edge of model.edges) {
        liveEdgeIds.add(edge.id)
        edgeMetaRef.current.set(edge.id, {
          sourceId: edge.sourceId,
          targetId: edge.targetId,
        })
        if (!knownEdgeIdsRef.current.has(edge.id)) {
          knownEdgeIdsRef.current.add(edge.id)
          if (edge.entering) edgeDrawStartRef.current.set(edge.id, now)
        }
      }
      for (const id of [...knownEdgeIdsRef.current]) {
        if (!liveEdgeIds.has(id)) {
          knownEdgeIdsRef.current.delete(id)
          edgeDrawStartRef.current.delete(id)
        }
      }

      // Reheat so the layout eases into a new equilibrium (no hard relayout).
      sim.alpha(Math.max(sim.alpha(), 0.6))

      // Paint once immediately to avoid a one-frame flash at the wrong spot.
      renderFrame(now)
    },
    [renderFrame],
  )

  // ── Simulation lifecycle + animation loop (mount once) ─────────────────────
  // Declared BEFORE the reconcile layout-effect so the simulation exists by
  // the time reconcileSimulation() first runs in the same commit.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (container) {
      sizeRef.current = {
        width: container.clientWidth || sizeRef.current.width,
        height: container.clientHeight || sizeRef.current.height,
      }
    }
    const { width, height } = sizeRef.current

    const linkForce = forceLink<SimNode, SimLink>([])
      .id((d) => d.id)
      .distance(linkDistance)
      .strength(linkStrength)
    linkForceRef.current = linkForce

    const sim = forceSimulation<SimNode>([])
      .force('charge', forceManyBody<SimNode>().strength(-200))
      .force('link', linkForce)
      .force('collide', forceCollide<SimNode>(collideRadius))
      .force('x', forceX<SimNode>(width / 2).strength(0.02))
      .force('y', forceY<SimNode>(height / 2).strength(0.02))
      .stop()
    simRef.current = sim

    const frame = (now: number) => {
      renderFrame(now)
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)

    let resizeObserver: ResizeObserver | null = null
    if (container && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (!entry) return
        const w = entry.contentRect.width
        const h = entry.contentRect.height
        if (w <= 0 || h <= 0) return
        sizeRef.current = { width: w, height: h }
        sim.force('x', forceX<SimNode>(w / 2).strength(0.02))
        sim.force('y', forceY<SimNode>(h / 2).strength(0.02))
        simNodesRef.current.forEach((n) => {
          if (n.kind === 'topic') {
            if (pinnedNodeIdsRef.current.has(n.id)) return
            n.fx = w / 2
            n.fy = h / 2
          }
        })
        sim.alpha(Math.max(sim.alpha(), 0.3))
      })
      resizeObserver.observe(container)
    }

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      resizeObserver?.disconnect()
      sim.stop()
      simRef.current = null
      linkForceRef.current = null
    }
  }, [renderFrame])

  // ── Reconcile the simulation whenever the structural model changes ─────────
  useLayoutEffect(() => {
    reconcileSimulation(graph)
  }, [graph.nodes, graph.edges, reconcileSimulation])

  // Keep the focus ref (read by the rAF loop) in sync.
  useEffect(() => {
    focusedIdRef.current = graph.focusedId
  }, [graph.focusedId])

  const kpCount = graph.nodes.filter((n) => n.kind === 'kp').length
  const relationCount = graph.edges.filter((e) => e.kind === 'relation').length
  const dense = kpCount > LABEL_DENSE_THRESHOLD
  const hasContent = graph.nodes.length > 0

  return (
    <div
      className="yolo-learning-graph-root"
      data-focused-id={graph.focusedId ?? ''}
    >
      <div className="yolo-learning-graph-header">
        <span className="yolo-learning-graph-stats">
          {formatLearningText(
            t('learning.graph.knowledgePoints', '{count} 知识点'),
            { count: kpCount },
          )}{' '}
          ·{' '}
          {formatLearningText(t('learning.graph.relations', '{count} 关系'), {
            count: relationCount,
          })}
        </span>
      </div>
      <div ref={containerRef} className="yolo-learning-graph-canvas">
        <svg
          ref={svgRef}
          className={`yolo-learning-graph-svg${dense ? ' is-dense' : ''}`}
          xmlns="http://www.w3.org/2000/svg"
          aria-label="Knowledge graph"
        >
          <g className="yolo-learning-graph-edges">
            {graph.edges.map((edge) => (
              <g
                key={edge.id}
                className="yolo-learning-graph-edge"
                data-edge-kind={edge.kind}
                data-type={edge.type ?? ''}
                data-exiting={edge.exiting ? 'true' : 'false'}
              >
                <line
                  ref={lineRef(edgeAEls, edge.id)}
                  className="yolo-learning-graph-edge-half"
                />
                <line
                  ref={lineRef(edgeBEls, edge.id)}
                  className="yolo-learning-graph-edge-half"
                />
              </g>
            ))}
          </g>
          <g className="yolo-learning-graph-nodes">
            {graph.nodes.map((node) => {
              const isFocused = node.id === graph.focusedId
              return (
                <g
                  key={node.id}
                  className="yolo-learning-graph-node"
                  data-kind={node.kind}
                  data-status={node.status}
                  data-entering={node.entering ? 'true' : 'false'}
                  data-exiting={node.exiting ? 'true' : 'false'}
                  data-focused={isFocused ? 'true' : 'false'}
                  data-dragging={node.id === draggingNodeId ? 'true' : 'false'}
                  onPointerDown={(event) =>
                    handleNodePointerDown(event, node.id)
                  }
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={handleNodePointerUp}
                  onPointerCancel={handleNodePointerUp}
                >
                  <circle
                    ref={circleRef(circleEls, node.id)}
                    className="yolo-learning-graph-node-dot"
                    r={RADIUS_BY_KIND[node.kind]}
                  />
                  <text
                    ref={textRef(labelEls, node.id)}
                    className="yolo-learning-graph-node-label"
                    data-focused={isFocused ? 'true' : 'false'}
                    textAnchor="middle"
                  >
                    {node.title}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
        {!hasContent ? (
          <div className="yolo-learning-graph-empty">
            {t('learning.graph.empty', '等待学习主题生成…')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── d3-force per-link / per-node accessors ───────────────────────────────────

function linkDistance(link: SimLink): number {
  if (link.kind === 'relation') return 90
  const source = link.source as SimNode
  const target = link.target as SimNode
  if (source.kind === 'topic' || target.kind === 'topic') return 132
  return 64
}

function linkStrength(link: SimLink): number {
  // Hierarchy edges are the rigid spine; relation edges nudge gently so they
  // don't fight the layered structure.
  return link.kind === 'relation' ? 0.14 : 0.7
}

function collideRadius(node: SimNode): number {
  return RADIUS_BY_KIND[node.kind] * 2.2 + 8
}

// ── Callback-ref helpers (populate the per-frame DOM handle maps) ────────────

function circleRef(
  map: React.MutableRefObject<Map<string, SVGCircleElement>>,
  id: string,
) {
  return (el: SVGCircleElement | null) => {
    if (el) map.current.set(id, el)
    else map.current.delete(id)
  }
}

function textRef(
  map: React.MutableRefObject<Map<string, SVGTextElement>>,
  id: string,
) {
  return (el: SVGTextElement | null) => {
    if (el) map.current.set(id, el)
    else map.current.delete(id)
  }
}

function lineRef(
  map: React.MutableRefObject<Map<string, SVGLineElement>>,
  id: string,
) {
  return (el: SVGLineElement | null) => {
    if (el) map.current.set(id, el)
    else map.current.delete(id)
  }
}

// ── Geometry / easing helpers ────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2
  return Math.min(max, Math.max(min, value))
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t)
}

/**
 * Seed a new node so the layout starts in a radial arrangement:
 *   - topic at the center,
 *   - chapters evenly spaced on a ring around the center,
 *   - knowledge points near their parent chapter.
 * A small jitter prevents perfect overlap (which would stall collide).
 */
function seedPosition(
  node: GraphNode,
  simNodes: Map<string, SimNode>,
  chapterOrder: Map<string, number>,
  chapterTotal: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  const jitter = () => (Math.random() - 0.5) * 24

  if (node.kind === 'topic') {
    return { x: cx, y: cy }
  }

  if (node.kind === 'chapter') {
    const index = chapterOrder.get(node.id) ?? 0
    const angle = (index / Math.max(chapterTotal, 1)) * Math.PI * 2
    const ring = 132
    return {
      x: cx + Math.cos(angle) * ring + jitter(),
      y: cy + Math.sin(angle) * ring + jitter(),
    }
  }

  // knowledge point: seed near its parent chapter if already placed.
  const parent = node.parentId ? simNodes.get(node.parentId) : undefined
  if (parent && parent.x != null && parent.y != null) {
    return { x: parent.x + jitter(), y: parent.y + jitter() }
  }
  return { x: cx + jitter(), y: cy + jitter() }
}

// ── Model derivation + reducer ───────────────────────────────────────────────

function topicNodeId(projectId: string): string {
  return `${TOPIC_PREFIX}/${projectId}`
}

function hierarchyEdgeId(parentId: string, childId: string): string {
  return `${HIER_PREFIX}__${parentId}__${childId}`
}

function relationEdgeId(
  sourceId: string,
  targetId: string,
  type: RelationType,
): string {
  return `${sourceId}__${targetId}__${type}`
}

function snapshotToGraph(snapshot: Project | null): GraphModel {
  if (!snapshot) {
    return { nodes: [], edges: [], focusedId: null, projectTopic: null }
  }

  const topicId = topicNodeId(snapshot.id)
  const nodes: GraphNode[] = [
    {
      id: topicId,
      kind: 'topic',
      title: snapshot.topic,
      parentId: null,
      status: 'completed',
      entering: false,
      exiting: false,
    },
  ]
  const edges: GraphEdge[] = []

  for (const chapter of snapshot.chapters) {
    nodes.push({
      id: chapter.id,
      kind: 'chapter',
      title: chapter.title,
      parentId: topicId,
      status: 'completed',
      entering: false,
      exiting: false,
    })
    edges.push({
      id: hierarchyEdgeId(topicId, chapter.id),
      kind: 'hierarchy',
      sourceId: topicId,
      targetId: chapter.id,
      type: null,
      entering: false,
      exiting: false,
    })
  }

  for (const kp of snapshot.knowledgePoints) {
    nodes.push({
      id: kp.id,
      kind: 'kp',
      title: kp.title,
      parentId: kp.chapterId,
      status: 'completed',
      entering: false,
      exiting: false,
    })
    edges.push({
      id: hierarchyEdgeId(kp.chapterId, kp.id),
      kind: 'hierarchy',
      sourceId: kp.chapterId,
      targetId: kp.id,
      type: null,
      entering: false,
      exiting: false,
    })
  }

  for (const kp of snapshot.knowledgePoints) {
    for (const relation of kp.relations) {
      edges.push({
        id: relationEdgeId(kp.id, relation.targetId, relation.type),
        kind: 'relation',
        sourceId: kp.id,
        targetId: relation.targetId,
        type: relation.type,
        entering: false,
        exiting: false,
        ...(relation.label ? { label: relation.label } : {}),
      })
    }
  }

  return { nodes, edges, focusedId: null, projectTopic: snapshot.topic }
}

function applyEvent(prev: GraphModel, event: LearningEvent): GraphModel {
  switch (event.type) {
    case 'project_initialized':
      return snapshotToGraph(event.snapshot)

    case 'chapter_added': {
      if (prev.nodes.some((n) => n.id === event.chapter.id)) return prev
      const topicId = topicNodeId(event.projectId)
      return {
        ...prev,
        nodes: [
          ...prev.nodes,
          {
            id: event.chapter.id,
            kind: 'chapter',
            title: event.chapter.title,
            parentId: topicId,
            status: 'completed',
            entering: true,
            exiting: false,
          },
        ],
        edges: [
          ...prev.edges,
          {
            id: hierarchyEdgeId(topicId, event.chapter.id),
            kind: 'hierarchy',
            sourceId: topicId,
            targetId: event.chapter.id,
            type: null,
            entering: true,
            exiting: false,
          },
        ],
      }
    }

    case 'chapter_updated': {
      return {
        ...prev,
        nodes: prev.nodes.map((node) =>
          node.id === event.chapter.id
            ? { ...node, title: event.chapter.title }
            : node,
        ),
      }
    }

    case 'chapter_removed': {
      return {
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.id === event.chapterId ? { ...n, exiting: true } : n,
        ),
        edges: prev.edges.map((e) =>
          e.sourceId === event.chapterId || e.targetId === event.chapterId
            ? { ...e, exiting: true }
            : e,
        ),
      }
    }

    case 'knowledge_point_added': {
      const kp = event.knowledgePoint
      if (prev.nodes.some((n) => n.id === kp.id)) {
        return {
          ...prev,
          nodes: prev.nodes.map((node) =>
            node.id === kp.id
              ? {
                  ...node,
                  title: kp.title,
                  parentId: kp.chapterId,
                  status: 'completed',
                }
              : node,
          ),
        }
      }
      return {
        ...prev,
        nodes: [
          ...prev.nodes,
          {
            id: kp.id,
            kind: 'kp',
            title: kp.title,
            parentId: kp.chapterId,
            status: 'completed',
            entering: true,
            exiting: false,
          },
        ],
        edges: [
          ...prev.edges,
          {
            id: hierarchyEdgeId(kp.chapterId, kp.id),
            kind: 'hierarchy',
            sourceId: kp.chapterId,
            targetId: kp.id,
            type: null,
            entering: true,
            exiting: false,
          },
        ],
      }
    }

    case 'knowledge_point_drafted': {
      const kp = event.knowledgePoint
      if (prev.nodes.some((n) => n.id === kp.id)) {
        return {
          ...prev,
          nodes: prev.nodes.map((node) =>
            node.id === kp.id
              ? {
                  ...node,
                  title: kp.title,
                  parentId: kp.chapterId,
                  status: 'generating',
                }
              : node,
          ),
        }
      }
      return {
        ...prev,
        nodes: [
          ...prev.nodes,
          {
            id: kp.id,
            kind: 'kp',
            title: kp.title,
            parentId: kp.chapterId,
            status: 'generating',
            entering: true,
            exiting: false,
          },
        ],
        edges: [
          ...prev.edges,
          {
            id: hierarchyEdgeId(kp.chapterId, kp.id),
            kind: 'hierarchy',
            sourceId: kp.chapterId,
            targetId: kp.id,
            type: null,
            entering: true,
            exiting: false,
          },
        ],
      }
    }

    case 'knowledge_point_updated': {
      return {
        ...prev,
        nodes: prev.nodes.map((node) =>
          node.id === event.knowledgePoint.id
            ? {
                ...node,
                title: event.knowledgePoint.title,
                parentId: event.knowledgePoint.chapterId,
                status: 'completed',
              }
            : node,
        ),
      }
    }

    case 'knowledge_point_removed': {
      return {
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.id === event.knowledgePointId ? { ...n, exiting: true } : n,
        ),
        edges: prev.edges.map((e) =>
          e.sourceId === event.knowledgePointId ||
          e.targetId === event.knowledgePointId
            ? { ...e, exiting: true }
            : e,
        ),
        focusedId:
          prev.focusedId === event.knowledgePointId ? null : prev.focusedId,
      }
    }

    case 'relation_established': {
      const edgeId = relationEdgeId(
        event.sourceId,
        event.relation.targetId,
        event.relation.type,
      )
      if (prev.edges.some((e) => e.id === edgeId)) return prev
      return {
        ...prev,
        edges: [
          ...prev.edges,
          {
            id: edgeId,
            kind: 'relation',
            sourceId: event.sourceId,
            targetId: event.relation.targetId,
            type: event.relation.type,
            entering: true,
            exiting: false,
            ...(event.relation.label ? { label: event.relation.label } : {}),
          },
        ],
      }
    }

    case 'relation_removed': {
      return {
        ...prev,
        edges: prev.edges.map((e) =>
          e.kind === 'relation' &&
          e.sourceId === event.sourceId &&
          e.targetId === event.targetId
            ? { ...e, exiting: true }
            : e,
        ),
      }
    }

    case 'knowledge_point_focused': {
      return { ...prev, focusedId: event.knowledgePointId }
    }

    default:
      return prev
  }
}

function purgeExiting(prev: GraphModel): GraphModel {
  const nodes = prev.nodes.filter((n) => !n.exiting)
  const edges = prev.edges.filter((e) => !e.exiting)
  if (
    nodes.length === prev.nodes.length &&
    edges.length === prev.edges.length
  ) {
    return prev
  }
  return { ...prev, nodes, edges }
}
