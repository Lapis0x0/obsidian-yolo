import type { App } from 'obsidian'

import type { LearningGenerationHost } from './host'
import { generateKnowledgePointsForChapter } from './knowledgePointGenerator'

describe('generateKnowledgePointsForChapter', () => {
  it('uses the explicit learning model', async () => {
    const markdown = '## Variables\n\nA variable stores a value.'
    const stream = jest.fn(async function* () {
      yield { type: 'completed' as const, text: markdown }
    })
    const host: LearningGenerationHost = {
      app: {} as App,
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
  })
})
