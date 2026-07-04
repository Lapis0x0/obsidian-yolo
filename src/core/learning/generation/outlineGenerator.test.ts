import type YoloPlugin from '../../../main'

import { generateOutline } from './outlineGenerator'
import type { OutlineChapter } from './types'

describe('generateOutline', () => {
  it('emits chapters as soon as streamed JSON objects are complete', async () => {
    const text =
      '[{"title":"第一章","contract":"覆盖变量与 { 类型 }"},{"title":"第二章","contract":"覆盖控制流"}]'
    const plugin = createPlugin([
      { type: 'text', delta: '[' },
      {
        type: 'text',
        delta: '{"title":"第一章","contract":"覆盖变量与 { 类型 }"}',
      },
      {
        type: 'text',
        delta: ',{"title":"第二章","contract":"覆盖控制流"}',
      },
      { type: 'text', delta: ']' },
      { type: 'completed', text },
    ])

    const snapshots: OutlineChapter[][] = []
    const result = await generateOutline({
      plugin,
      topic: 'Python',
      level: 'beginner',
      goal: '入门',
      onChapters: (chapters) => snapshots.push(chapters),
    })

    expect(snapshots).toEqual([
      [{ title: '第一章', contract: '覆盖变量与 { 类型 }' }],
      [
        { title: '第一章', contract: '覆盖变量与 { 类型 }' },
        { title: '第二章', contract: '覆盖控制流' },
      ],
    ])
    expect(result.chapters).toEqual([
      { title: '第一章', contract: '覆盖变量与 { 类型 }' },
      { title: '第二章', contract: '覆盖控制流' },
    ])
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
