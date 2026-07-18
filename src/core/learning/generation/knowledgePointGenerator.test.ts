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

describe('generateKnowledgePointsForChapter output language', () => {
  it('prepends the output-language directive to the system prompt', async () => {
    const stream = jest.fn(async function* () {
      yield { type: 'completed' as const, text: '## KP\n\nBody' }
    })
    const plugin = {
      agent: { stream },
      settings: { learningOptions: { outputLanguage: 'English' } },
    } as unknown as YoloPlugin

    await generateKnowledgePointsForChapter({
      plugin,
      modelId: 'learning-model',
      chapterIndex: 0,
      projectTopic: 'Python',
      chapterTitle: 'Basics',
      chapterContract: 'Cover variables',
      level: 'beginner',
    })

    const request = (stream.mock.calls as unknown[][])[0]?.[0] as {
      systemPromptOverride: string
    }
    expect(request.systemPromptOverride).toContain('OUTPUT LANGUAGE')
    expect(request.systemPromptOverride).toContain('English')
  })
})
