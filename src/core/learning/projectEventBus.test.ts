import type { LearningVaultReadApi } from './learningVaultReadApi'
import { ProjectEventBus, diffProjects } from './projectEventBus'
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

describe('ProjectEventBus vault facade', () => {
  it('scopes subscriptions and disposes all watchers', () => {
    const disposers = [jest.fn(), jest.fn(), jest.fn(), jest.fn()]
    const onCreate = jest.fn(() => disposers[0])
    const onRename = jest.fn(() => disposers[3])
    const vault = {
      onCreate,
      onModify: jest.fn(() => disposers[1]),
      onDelete: jest.fn(() => disposers[2]),
      onRename,
    } as unknown as LearningVaultReadApi
    const bus = new ProjectEventBus(vault)

    void bus.setActiveProject('Learning', null)
    bus.startWatchingVault()
    bus.stopWatchingVault()

    expect(onCreate).toHaveBeenCalledWith('Learning', expect.any(Function))
    expect(onRename).toHaveBeenCalledWith('Learning', expect.any(Function))
    for (const dispose of disposers) expect(dispose).toHaveBeenCalledTimes(1)
  })
})
