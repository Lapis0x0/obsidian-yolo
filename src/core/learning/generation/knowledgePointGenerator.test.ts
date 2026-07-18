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

describe('generateKnowledgePointsForChapter language propagation', () => {
  it('inherits the language from the chapter contract', async () => {
    const stream = jest.fn(async function* () {
      yield { type: 'completed' as const, text: '## KP\n\nBody' }
    })
    const plugin = {
      agent: { stream },
    } as unknown as YoloPlugin

    await generateKnowledgePointsForChapter({
      plugin,
      modelId: 'learning-model',
      chapterIndex: 0,
      projectTopic: 'Python',
      chapterTitle: 'Basics',
      chapterContract: 'covers dataflow variables and single assignment',
      level: 'beginner',
    })

    const request = (stream.mock.calls as unknown[][])[0]?.[0] as {
      systemPromptOverride: string
      prompt: string
    }
    expect(request.systemPromptOverride).toContain(
      'language of the chapter contract',
    )
    // Language propagation: the chapter contract (written by the outline stage
    // in the user's language) must reach the knowledge-point request.
    expect(request.prompt).toContain(
      'covers dataflow variables and single assignment',
    )
  })
})
