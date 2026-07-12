import type YoloPlugin from '../../../main'

import { generateOutline } from './outlineGenerator'
import type { Outline } from './types'

describe('generateOutline', () => {
  it('emits outline as chapters stream in, then finalizes with estimatedKnowledgePoints', async () => {
    const text =
      '{"projectName":"Python","projectGoal":"能够编写基础 Python 程序","chapters":[{"title":"第一章","contract":"覆盖变量与 { 类型 }"},{"title":"第二章","contract":"覆盖控制流"}],"estimatedKnowledgePoints":10}'
    const plugin = createPlugin([
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
    ])

    const snapshots: Outline[] = []
    const result = await generateOutline({
      plugin,
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

function createPlugin(events: unknown[]): YoloPlugin {
  return {
    agent: {
      stream: () => streamEvents(events),
    },
  } as unknown as YoloPlugin
}

async function* streamEvents(events: unknown[]) {
  for (const event of events) yield event
}
