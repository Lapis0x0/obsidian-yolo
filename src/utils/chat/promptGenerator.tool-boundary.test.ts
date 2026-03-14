import type { RequestMessage } from '../../types/llm/request'

import { filterRequestMessagesByToolBoundary } from './promptGenerator'

const assistantWithTools = (toolIds: string[]): RequestMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: toolIds.map((id, index) => ({
    id,
    name: `tool_${index}`,
    arguments: '{}',
  })),
})

const toolMessage = (id: string): RequestMessage => ({
  role: 'tool',
  tool_call: {
    id,
    name: 'tool',
    arguments: '{}',
  },
  content: `result:${id}`,
})

describe('filterRequestMessagesByToolBoundary', () => {
  it('keeps only matching tool responses after assistant tool calls', () => {
    const input: RequestMessage[] = [
      assistantWithTools(['call-1']),
      toolMessage('call-1'),
      toolMessage('call-x'),
    ]

    const output = filterRequestMessagesByToolBoundary(input)

    expect(output).toHaveLength(2)
    expect(output[1]).toEqual(toolMessage('call-1'))
  })

  it('drops tool responses when boundary is broken by non-tool message', () => {
    const input: RequestMessage[] = [
      assistantWithTools(['call-1']),
      { role: 'user', content: 'next turn' },
      toolMessage('call-1'),
    ]

    const output = filterRequestMessagesByToolBoundary(input)

    expect(output).toHaveLength(2)
    expect(output.find((message) => message.role === 'tool')).toBeUndefined()
  })

  it('keeps multiple ordered tool responses for same assistant', () => {
    const input: RequestMessage[] = [
      assistantWithTools(['call-1', 'call-2']),
      toolMessage('call-2'),
      toolMessage('call-1'),
    ]

    const output = filterRequestMessagesByToolBoundary(input)

    expect(output).toHaveLength(3)
    expect(output.filter((message) => message.role === 'tool')).toHaveLength(2)
  })
})
