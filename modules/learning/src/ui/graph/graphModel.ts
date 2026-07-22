import type {
  LearningEvent,
  OutlineProject,
  RelationType,
} from '../../domain/types'

export type GraphNodeKind = 'topic' | 'chapter' | 'kp'
export type GraphNodeStatus = 'generating' | 'completed'

export type GraphNode = {
  id: string
  kind: GraphNodeKind
  title: string
  parentId: string | null
  status: GraphNodeStatus
  entering: boolean
  exiting: boolean
}

export type GraphEdge = {
  id: string
  kind: 'hierarchy' | 'relation'
  sourceId: string
  targetId: string
  type: RelationType | null
  label?: string
  entering: boolean
  exiting: boolean
}

export type GraphModel = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  focusedId: string | null
}

const topicNodeId = (projectId: string) => `__topic__/${projectId}`
const hierarchyEdgeId = (parentId: string, childId: string) =>
  `hier__${parentId}__${childId}`
const relationEdgeId = (
  sourceId: string,
  targetId: string,
  type: RelationType,
) => `${sourceId}__${targetId}__${type}`

export function snapshotToGraph(snapshot: OutlineProject | null): GraphModel {
  if (!snapshot) return { nodes: [], edges: [], focusedId: null }
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
  for (const point of snapshot.knowledgePoints) {
    nodes.push({
      id: point.id,
      kind: 'kp',
      title: point.title,
      parentId: point.chapterId,
      status: 'completed',
      entering: false,
      exiting: false,
    })
    edges.push({
      id: hierarchyEdgeId(point.chapterId, point.id),
      kind: 'hierarchy',
      sourceId: point.chapterId,
      targetId: point.id,
      type: null,
      entering: false,
      exiting: false,
    })
    for (const relation of point.relations) {
      edges.push({
        id: relationEdgeId(point.id, relation.targetId, relation.type),
        kind: 'relation',
        sourceId: point.id,
        targetId: relation.targetId,
        type: relation.type,
        entering: false,
        exiting: false,
        ...(relation.label ? { label: relation.label } : {}),
      })
    }
  }
  return { nodes, edges, focusedId: null }
}

export function applyGraphEvent(
  previous: GraphModel,
  event: LearningEvent,
): GraphModel {
  switch (event.type) {
    case 'project_initialized':
      return event.snapshot.kind === 'outline'
        ? snapshotToGraph(event.snapshot)
        : previous
    case 'chapter_added': {
      if (previous.nodes.some((node) => node.id === event.chapter.id))
        return previous
      const topicId = topicNodeId(event.projectId)
      return {
        ...previous,
        nodes: [
          ...previous.nodes,
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
          ...previous.edges,
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
    case 'chapter_updated':
      return {
        ...previous,
        nodes: previous.nodes.map((node) =>
          node.id === event.chapter.id
            ? { ...node, title: event.chapter.title }
            : node,
        ),
      }
    case 'chapter_removed':
      return markExiting(previous, event.chapterId)
    case 'knowledge_point_added':
    case 'knowledge_point_drafted': {
      const point = event.knowledgePoint
      const status =
        event.type === 'knowledge_point_drafted' ? 'generating' : 'completed'
      if (previous.nodes.some((node) => node.id === point.id)) {
        return {
          ...previous,
          nodes: previous.nodes.map((node) =>
            node.id === point.id
              ? {
                  ...node,
                  title: point.title,
                  parentId: point.chapterId,
                  status: node.status === 'completed' ? 'completed' : status,
                }
              : node,
          ),
        }
      }
      return {
        ...previous,
        nodes: [
          ...previous.nodes,
          {
            id: point.id,
            kind: 'kp',
            title: point.title,
            parentId: point.chapterId,
            status,
            entering: true,
            exiting: false,
          },
        ],
        edges: [
          ...previous.edges,
          {
            id: hierarchyEdgeId(point.chapterId, point.id),
            kind: 'hierarchy',
            sourceId: point.chapterId,
            targetId: point.id,
            type: null,
            entering: true,
            exiting: false,
          },
        ],
      }
    }
    case 'knowledge_point_updated':
      return {
        ...previous,
        nodes: previous.nodes.map((node) =>
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
    case 'knowledge_point_removed':
      return markExiting(previous, event.knowledgePointId)
    case 'relation_established': {
      const id = relationEdgeId(
        event.sourceId,
        event.relation.targetId,
        event.relation.type,
      )
      if (previous.edges.some((edge) => edge.id === id)) return previous
      return {
        ...previous,
        edges: [
          ...previous.edges,
          {
            id,
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
    case 'relation_removed':
      return {
        ...previous,
        edges: previous.edges.map((edge) =>
          edge.kind === 'relation' &&
          edge.sourceId === event.sourceId &&
          edge.targetId === event.targetId
            ? { ...edge, exiting: true }
            : edge,
        ),
      }
    case 'knowledge_point_focused':
      return { ...previous, focusedId: event.knowledgePointId }
  }
}

function markExiting(model: GraphModel, id: string): GraphModel {
  return {
    ...model,
    nodes: model.nodes.map((node) =>
      node.id === id ? { ...node, exiting: true } : node,
    ),
    edges: model.edges.map((edge) =>
      edge.sourceId === id || edge.targetId === id
        ? { ...edge, exiting: true }
        : edge,
    ),
    focusedId: model.focusedId === id ? null : model.focusedId,
  }
}

export function purgeExiting(model: GraphModel): GraphModel {
  const nodes = model.nodes.filter((node) => !node.exiting)
  const edges = model.edges.filter((edge) => !edge.exiting)
  return nodes.length === model.nodes.length &&
    edges.length === model.edges.length
    ? model
    : { ...model, nodes, edges }
}
