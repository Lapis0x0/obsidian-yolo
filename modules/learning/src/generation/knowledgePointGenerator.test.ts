import type { LearningVaultReadApi } from '../domain/learningVaultReadApi'
import type { LearningVaultWriteApi } from '../domain/learningVaultWriteApi'

import type { LearningGenerationHost } from './host'
import { generateKnowledgePointsForChapter } from './knowledgePointGenerator'

describe('generateKnowledgePointsForChapter', () => {
  it('uses the explicit learning model', async () => {
    const markdown = '## Variables\n\nA variable stores a value.'
    const requests: unknown[] = []
    const stream = jest.fn(async function* (request: unknown) {
      requests.push(request)
      yield { type: 'completed' as const, text: markdown }
    })
    const host: LearningGenerationHost = {
      vault: {} as LearningVaultReadApi,
      vaultWriter: {} as LearningVaultWriteApi,
      isDebugEnabled: () => false,
      agent: { stream: stream as LearningGenerationHost['agent']['stream'] },
    }

    const result = await generateKnowledgePointsForChapter({
      host,
      modelId: 'learning-model',
      chapterIndex: 0,
      projectTopic: 'Python',
      chapterTitle: 'Basics',
      chapterContract: 'Cover variables',
      outputLanguage: 'English',
      level: 'beginner',
    })

    expect(result.drafts).toEqual([
      { title: 'Variables', body: 'A variable stores a value.' },
    ])
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'learning-model',
        capability: 'none',
      }),
    )
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Project topic: Python'),
      }),
    )
    const request = requests[0] as { prompt: string }
    expect(request.prompt).toContain('Required output language: English')
    expect(request.prompt).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('rejects explicitly aborted partial markdown', async () => {
    const stream = async function* () {
      yield {
        type: 'text' as const,
        text: '## Partial\n\nunfinished',
        delta: '## Partial\n\nunfinished',
      }
      yield { type: 'aborted' as const }
    }
    const host: LearningGenerationHost = {
      vault: {} as LearningVaultReadApi,
      vaultWriter: {} as LearningVaultWriteApi,
      isDebugEnabled: () => false,
      agent: { stream },
    }

    await expect(
      generateKnowledgePointsForChapter({
        host,
        chapterIndex: 0,
        projectTopic: 'Python',
        chapterTitle: 'Basics',
        chapterContract: 'Cover variables',
        outputLanguage: 'English',
        level: 'beginner',
      }),
    ).rejects.toThrow('Knowledge point generation aborted: Basics')
  })
})
