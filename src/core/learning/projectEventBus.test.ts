import { diffProjects } from './projectEventBus'
import type { OutlineProject } from './types'

const project = (title: string): OutlineProject => ({
  kind: 'outline',
  id: 'project',
  slug: 'project',
  topic: 'Project',
  goal: 'Learn',
  status: 'studying',
  folderPath: 'learning/project',
  indexFilePath: 'learning/project/index.md',
  chapters: [
    {
      id: 'chapter',
      projectId: 'project',
      slug: 'chapter',
      title,
      folderPath: 'learning/project/chapter',
      knowledgePointIds: [],
    },
  ],
  knowledgePoints: [],
})

describe('diffProjects', () => {
  it('emits outline chapter changes', () => {
    let sequence = 0
    expect(
      diffProjects(project('Before'), project('After'), () => ({
        sequence: ++sequence,
        timestamp: 1,
      })),
    ).toEqual([
      expect.objectContaining({
        type: 'chapter_updated',
        chapter: expect.objectContaining({ title: 'After' }),
      }),
    ])
  })
})
