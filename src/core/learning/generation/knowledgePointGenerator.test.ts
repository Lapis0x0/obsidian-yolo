import type YoloPlugin from '../../../main'

import { generateKnowledgePointsForChapter } from './knowledgePointGenerator'

describe('generateKnowledgePointsForChapter', () => {
  it('uses the explicit learning model', async () => {
    const markdown = '## Variables\n\nA variable stores a value.'
    const stream = jest.fn(async function* () {
      yield { type: 'completed' as const, text: markdown }
    })
    const plugin = {
      agent: { stream },
    } as unknown as YoloPlugin

    const result = await generateKnowledgePointsForChapter({
      plugin,
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
      expect.objectContaining({ modelId: 'learning-model' }),
    )
  })
})
