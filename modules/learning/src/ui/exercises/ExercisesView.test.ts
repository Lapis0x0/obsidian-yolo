import type { LearningVaultFile } from '../../domain/learningVaultReadApi'
import type { OutlineProject } from '../../domain/types'

import { loadProjectExercises } from './ExercisesView'

const project: OutlineProject = {
  kind: 'outline',
  id: 'project',
  slug: 'project',
  topic: 'Topic',
  goal: 'Learn it',
  status: 'studying',
  folderPath: 'learning/project',
  indexFilePath: 'learning/project/index.md',
  chapters: [
    {
      id: 'chapter',
      projectId: 'project',
      slug: 'chapter',
      title: 'Chapter',
      folderPath: 'learning/project/chapter',
      knowledgePointIds: ['chapter/aaaaaaaa'],
    },
  ],
  knowledgePoints: [
    {
      id: 'chapter/aaaaaaaa',
      projectId: 'project',
      chapterId: 'chapter',
      uuid: 'aaaaaaaa',
      title: 'Known point',
      knowledgeFilePath: 'learning/project/chapter/knowledge.md',
      relations: [],
      hasCards: false,
      hasExercises: true,
      mtime: 0,
    },
  ],
}

describe('loadProjectExercises', () => {
  it('loads exercises through the domain reader and resolves their knowledge point', async () => {
    const path = 'learning/project/chapter/exercises.md'
    const file: LearningVaultFile = {
      kind: 'file',
      path,
      name: 'exercises.md',
      ctime: 0,
      mtime: 0,
    }
    const vault = {
      getEntry: jest.fn((candidate: string) =>
        candidate === path ? file : null,
      ),
      readText: jest
        .fn()
        .mockResolvedValue(
          '## Prompt <!--ex:bbbbbbbb kp:aaaaaaaa-->\n\nExplain the answer.',
        ),
    }

    await expect(loadProjectExercises(project, vault)).resolves.toEqual([
      {
        id: 'bbbbbbbb',
        pointId: 'chapter/aaaaaaaa',
        pointTitle: 'Known point',
        chapterId: 'chapter',
        chapterTitle: 'Chapter',
        question: 'Explain the answer.',
        practiced: false,
      },
    ])
    expect(vault.readText).toHaveBeenCalledWith(path)
  })
})
