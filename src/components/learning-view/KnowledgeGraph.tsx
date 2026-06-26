import { useEffect, useMemo, useRef, useState } from 'react'

import type { ProjectEventBus } from '../../core/learning/projectEventBus'
import type { LearningEvent, Project } from '../../core/learning/types'

/**
 * KnowledgeGraph — the visual centerpiece of Learning Mode.
 *
 * THIS FILE IS A SCAFFOLD. The visual / animation implementation is delegated
 * to the next iteration (see docs/plans/learning-mode/*-handoff.md). The
 * scaffold's job is to:
 *
 *   1. Subscribe to ProjectEventBus and keep a live model of the graph
 *      (`nodes`, `edges`, `focusedId`) in component state.
 *   2. Expose a stable rendering surface (the `<svg>` container) so the
 *      visual layer can hook into it without touching the data plumbing.
 *   3. Render a minimal, intentionally bare placeholder. The next iteration
 *      replaces the placeholder with an actual force-directed graph using
 *      whatever lib it picks (d3-force + SVG / reactflow / cytoscape).
 *
 * Visual direction (binding, not aspirational):
 *   - Match Obsidian's native Graph View aesthetic: small filled circles for
 *     nodes, thin lines for edges, force-directed layout, restrained palette
 *     bound to Obsidian theme variables (--text-normal, --text-muted,
 *     --interactive-accent, --background-secondary).
 *   - "Growing" feels gentle, not flashy. New nodes fade in with a small
 *     elastic scale-up; new edges draw from both endpoints toward the
 *     middle; the focused node gets a slow, low-amplitude pulse.
 *   - Layout should breathe as new nodes join — let force simulation
 *     ease into a new equilibrium, no hard relayouts.
 *
 * Do NOT add Web-y embellishments (gradients, glows, particle effects,
 * gradient text, color-wash backgrounds). This is an Obsidian plugin; the
 * graph must look like it belongs next to Obsidian's own Graph View.
 */

export type GraphNode = {
  id: string
  title: string
  chapterId: string
  hasCards: boolean
  hasExercises: boolean
}

export type GraphEdge = {
  /** sourceId__targetId__type, used for keying. */
  id: string
  sourceId: string
  targetId: string
  type: 'prereq' | 'parent' | 'related'
  label?: string
}

export type KnowledgeGraphProps = {
  eventBus: ProjectEventBus
  /**
   * Initial snapshot to render synchronously on mount. If null, the component
   * waits for a `project_initialized` event.
   */
  initialSnapshot: Project | null
}

export function KnowledgeGraph({
  eventBus,
  initialSnapshot,
}: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [graph, setGraph] = useState<{
    nodes: GraphNode[]
    edges: GraphEdge[]
    focusedId: string | null
    projectTopic: string | null
  }>(() => snapshotToGraph(initialSnapshot))

  useEffect(() => {
    const handleEvent = (event: LearningEvent) => {
      setGraph((prev) => applyEvent(prev, event))
    }
    const unsubscribe = eventBus.subscribe(handleEvent)
    return unsubscribe
  }, [eventBus])

  const nodeCount = graph.nodes.length
  const edgeCount = graph.edges.length

  // The placeholder visualization: a plain list of nodes and a counter. The
  // next iteration replaces the inner JSX with a real graph renderer.
  const stats = useMemo(
    () => ({
      nodeCount,
      edgeCount,
    }),
    [nodeCount, edgeCount],
  )

  return (
    <div
      ref={containerRef}
      className="yolo-learning-graph-root"
      data-focused-id={graph.focusedId ?? ''}
    >
      <div className="yolo-learning-graph-header">
        <span className="yolo-learning-graph-topic">
          {graph.projectTopic ?? '未选择项目'}
        </span>
        <span className="yolo-learning-graph-stats">
          {stats.nodeCount} 知识点 · {stats.edgeCount} 关系
        </span>
      </div>
      <div className="yolo-learning-graph-canvas">
        {/*
          Replace the body of this <svg> with the force-directed graph
          renderer. Keep the <svg> as the mount point — its parent container
          is sized via CSS and respects Obsidian theme.
        */}
        <svg
          className="yolo-learning-graph-svg"
          xmlns="http://www.w3.org/2000/svg"
          aria-label="Knowledge graph"
        >
          <g className="yolo-learning-graph-placeholder">
            {/* Intentionally empty — see handoff doc. */}
          </g>
        </svg>
        {graph.nodes.length === 0 ? (
          <div className="yolo-learning-graph-empty">等待知识点生成…</div>
        ) : (
          <ul className="yolo-learning-graph-fallback-list">
            {graph.nodes.map((node) => (
              <li
                key={node.id}
                data-focused={node.id === graph.focusedId ? 'true' : 'false'}
              >
                {node.title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function snapshotToGraph(snapshot: Project | null): {
  nodes: GraphNode[]
  edges: GraphEdge[]
  focusedId: string | null
  projectTopic: string | null
} {
  if (!snapshot) {
    return { nodes: [], edges: [], focusedId: null, projectTopic: null }
  }
  const nodes: GraphNode[] = snapshot.knowledgePoints.map((kp) => ({
    id: kp.id,
    title: kp.title,
    chapterId: kp.chapterId,
    hasCards: kp.hasCards,
    hasExercises: kp.hasExercises,
  }))
  const edges: GraphEdge[] = []
  for (const kp of snapshot.knowledgePoints) {
    for (const relation of kp.relations) {
      edges.push({
        id: `${kp.id}__${relation.targetId}__${relation.type}`,
        sourceId: kp.id,
        targetId: relation.targetId,
        type: relation.type,
        ...(relation.label ? { label: relation.label } : {}),
      })
    }
  }
  return {
    nodes,
    edges,
    focusedId: null,
    projectTopic: snapshot.topic,
  }
}

function applyEvent(
  prev: {
    nodes: GraphNode[]
    edges: GraphEdge[]
    focusedId: string | null
    projectTopic: string | null
  },
  event: LearningEvent,
) {
  switch (event.type) {
    case 'project_initialized':
      return snapshotToGraph(event.snapshot)

    case 'knowledge_point_added': {
      if (prev.nodes.some((n) => n.id === event.knowledgePoint.id)) return prev
      return {
        ...prev,
        nodes: [
          ...prev.nodes,
          {
            id: event.knowledgePoint.id,
            title: event.knowledgePoint.title,
            chapterId: event.knowledgePoint.chapterId,
            hasCards: event.knowledgePoint.hasCards,
            hasExercises: event.knowledgePoint.hasExercises,
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
                chapterId: event.knowledgePoint.chapterId,
                hasCards: event.knowledgePoint.hasCards,
                hasExercises: event.knowledgePoint.hasExercises,
              }
            : node,
        ),
      }
    }

    case 'knowledge_point_removed': {
      return {
        ...prev,
        nodes: prev.nodes.filter((n) => n.id !== event.knowledgePointId),
        edges: prev.edges.filter(
          (e) =>
            e.sourceId !== event.knowledgePointId &&
            e.targetId !== event.knowledgePointId,
        ),
        focusedId:
          prev.focusedId === event.knowledgePointId ? null : prev.focusedId,
      }
    }

    case 'relation_established': {
      const edgeId = `${event.sourceId}__${event.relation.targetId}__${event.relation.type}`
      if (prev.edges.some((e) => e.id === edgeId)) return prev
      return {
        ...prev,
        edges: [
          ...prev.edges,
          {
            id: edgeId,
            sourceId: event.sourceId,
            targetId: event.relation.targetId,
            type: event.relation.type,
            ...(event.relation.label ? { label: event.relation.label } : {}),
          },
        ],
      }
    }

    case 'relation_removed': {
      return {
        ...prev,
        edges: prev.edges.filter(
          (e) =>
            !(e.sourceId === event.sourceId && e.targetId === event.targetId),
        ),
      }
    }

    case 'knowledge_point_focused': {
      return { ...prev, focusedId: event.knowledgePointId }
    }

    case 'chapter_added':
    case 'chapter_updated':
    case 'chapter_removed':
      // The graph view does not currently render chapter-level visuals.
      // The next iteration may use chapter membership for coloring/clustering.
      return prev

    default:
      return prev
  }
}
