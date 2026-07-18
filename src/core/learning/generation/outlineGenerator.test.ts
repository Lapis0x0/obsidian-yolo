import type YoloPlugin from '../../../main'

import { generateOutline } from './outlineGenerator'
import type { Outline } from './types'

describe('generateOutline', () => {
  it('emits outline as chapters stream in, then finalizes with estimatedKnowledgePoints', async () => {
    const text =
      '{"projectName":"Python","projectGoal":"能够编写基础 Python 程序","chapters":[{"title":"第一章","contract":"覆盖变量与 { 类型 }"},{"title":"第二章","contract":"覆盖控制流"}],"estimatedKnowledgePoints":10}'
    const onRequest = jest.fn()
    const plugin = createPlugin(
      [
        {
          type: 'text',
          delta:
            '{"projectName":"Python","projectGoal":"能够编写基础 Python 程序","chapters":[',
        },
        {
          type: 'text',
          delta: '{"title":"第一章","contract":"覆盖变量与 { 类型 }"}',
        },
        {
          type: 'text',
          delta: ',{"title":"第二章","contract":"覆盖控制流"}',
        },
        { type: 'text', delta: '],"estimatedKnowledgePoints":10}' },
        { type: 'completed', text },
      ],
      onRequest,
    )

    const snapshots: Outline[] = []
    const result = await generateOutline({
      plugin,
      modelId: 'learning-model',
      topic: 'python',
      level: 'beginner',
      goal: '入门',
      onOutline: (outline) => snapshots.push(outline),
    })

    expect(snapshots).toEqual([
      {
        projectName: 'Python',
        projectGoal: '能够编写基础 Python 程序',
        chapters: [],
        estimatedKnowledgePoints: 0,
      },
      {
        projectName: 'Python',
        projectGoal: '能够编写基础 Python 程序',
        chapters: [{ title: '第一章', contract: '覆盖变量与 { 类型 }' }],
        estimatedKnowledgePoints: 0,
      },
      {
        projectName: 'Python',
        projectGoal: '能够编写基础 Python 程序',
        chapters: [
          { title: '第一章', contract: '覆盖变量与 { 类型 }' },
          { title: '第二章', contract: '覆盖控制流' },
        ],
        estimatedKnowledgePoints: 0,
      },
      {
        projectName: 'Python',
        projectGoal: '能够编写基础 Python 程序',
        chapters: [
          { title: '第一章', contract: '覆盖变量与 { 类型 }' },
          { title: '第二章', contract: '覆盖控制流' },
        ],
        estimatedKnowledgePoints: 10,
      },
    ])
    expect(result.outline).toEqual({
      projectName: 'Python',
      projectGoal: '能够编写基础 Python 程序',
      chapters: [
        { title: '第一章', contract: '覆盖变量与 { 类型 }' },
        { title: '第二章', contract: '覆盖控制流' },
      ],
      estimatedKnowledgePoints: 10,
    })
    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'learning-model' }),
    )
  })

  it('rejects an outline without a generated project goal', async () => {
    const plugin = createPlugin([
      {
        type: 'completed',
        text: '{"projectName":"Python","chapters":[{"title":"第一章","contract":"覆盖基础语法"}],"estimatedKnowledgePoints":5}',
      },
    ])

    await expect(
      generateOutline({
        plugin,
        topic: 'python',
        level: 'beginner',
        goal: '入门',
      }),
    ).rejects.toThrow('大纲生成结果缺少 projectGoal')
  })
})

function createPlugin(
  events: unknown[],
  onRequest?: (request: unknown) => void,
): YoloPlugin {
  return {
    agent: {
      stream: (request: unknown) => {
        onRequest?.(request)
        return streamEvents(events)
      },
    },
  } as unknown as YoloPlugin
}

async function* streamEvents(events: unknown[]) {
  for (const event of events) yield event
}

describe('generateOutline output language', () => {
  it('prepends the output-language directive to the system prompt', async () => {
    const onRequest = jest.fn()
    const plugin = createPlugin(
      [
        {
          type: 'completed',
          text: '{"projectName":"X","projectGoal":"g","chapters":[{"title":"c","contract":"x"}],"estimatedKnowledgePoints":1}',
        },
      ],
      onRequest,
    )
    ;(plugin as unknown as { settings: unknown }).settings = {
      learningOptions: { outputLanguage: 'English' },
    }

    await generateOutline({
      plugin,
      modelId: 'learning-model',
      topic: 't',
      level: 'beginner',
      goal: 'g',
    })

    const request = onRequest.mock.calls[0]?.[0] as {
      systemPromptOverride: string
    }
    expect(request.systemPromptOverride).toContain('OUTPUT LANGUAGE')
    expect(request.systemPromptOverride).toContain('English')
    // Directive must be PREPENDED, i.e. appear before the (Chinese) base prompt.
    expect(
      request.systemPromptOverride.indexOf('OUTPUT LANGUAGE'),
    ).toBeLessThan(
      request.systemPromptOverride.indexOf(
        '\u5b66\u4e60\u5185\u5bb9\u67b6\u6784\u5e08',
      ),
    )
  })
})
