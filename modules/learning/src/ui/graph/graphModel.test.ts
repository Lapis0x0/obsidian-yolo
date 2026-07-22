import type { LearningEvent, OutlineProject } from '../../domain/types'

import { applyGraphEvent, purgeExiting, snapshotToGraph } from './graphModel'

const project = {
  id: 'project',
  topic: 'Topic',
  chapters: [
    {
      id: 'chapter',
      title: 'Chapter',
      knowledgePointIds: ['chapter/point'],
    },
  ],
  knowledgePoints: [
    {
      id: 'chapter/point',
      title: 'Point',
      chapterId: 'chapter',
      relations: [],
    },
  ],
} as unknown as OutlineProject

describe('knowledge graph model', () => {
  it('creates the topic hierarchy synchronously', () => {
    const graph = snapshotToGraph(project)
    expect(graph.nodes.map((node) => node.kind)).toEqual([
      'topic',
      'chapter',
      'kp',
    ])
    expect(graph.edges).toHaveLength(2)
    expect(graph.nodes.every((node) => !node.entering)).toBe(true)
  })

  it('marks removed points and their edges before purging them', () => {
    const graph = snapshotToGraph(project)
    const exiting = applyGraphEvent(graph, {
      type: 'knowledge_point_removed',
      projectId: 'project',
      knowledgePointId: 'chapter/point',
      sequence: 1,
      timestamp: 1,
    } satisfies LearningEvent)
    expect(exiting.nodes.find((node) => node.kind === 'kp')?.exiting).toBe(true)
    expect(exiting.edges[1].exiting).toBe(true)
    expect(purgeExiting(exiting).nodes.map((node) => node.kind)).toEqual([
      'topic',
      'chapter',
    ])
  })
})
