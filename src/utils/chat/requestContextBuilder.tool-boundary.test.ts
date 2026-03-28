import type { RequestMessage } from '../../types/llm/request'
import { createCompleteToolCallArguments } from '../../types/tool-call.types'

import {
  filterEmptyAssistantMessages,
  filterRequestMessagesByToolBoundary,
} from './tool-boundary'

const emptyArgs = createCompleteToolCallArguments({ value: {} })

const assistantWithTools = (toolIds: string[]): RequestMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: toolIds.map((id, index) => ({
    id,
    name: `tool_${index}`,
    arguments: emptyArgs,
  })),
})

const toolMessage = (id: string): RequestMessage => ({
  role: 'tool',
  tool_call: {
    id,
    name: 'tool',
    arguments: emptyArgs,
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
    expect(output[0]?.role).toBe('assistant')
    if (output[0]?.role === 'assistant') {
      expect(output[0].tool_calls).toBeUndefined()
    }
  })

  it('keeps matched tool groups when only partial tool responses exist', () => {
    const input: RequestMessage[] = [
      assistantWithTools(['call-1', 'call-2']),
      toolMessage('call-2'),
      { role: 'user', content: 'interrupt' },
    ]

    const output = filterRequestMessagesByToolBoundary(input)

    expect(output).toHaveLength(3)
    expect(output[0]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-2',
          name: 'tool_1',
          arguments: emptyArgs,
        },
      ],
    })
    expect(output[1]).toEqual(toolMessage('call-2'))
    expect(output[2]).toEqual({ role: 'user', content: 'interrupt' })
  })

  it('keeps matched tool groups before a non-tool boundary break', () => {
    const input: RequestMessage[] = [
      assistantWithTools(['call-1', 'call-2']),
      toolMessage('call-1'),
      { role: 'assistant', content: '继续处理' },
      toolMessage('call-2'),
    ]

    const output = filterRequestMessagesByToolBoundary(input)

    expect(output).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            name: 'tool_0',
            arguments: emptyArgs,
          },
        ],
      },
      toolMessage('call-1'),
      { role: 'assistant', content: '继续处理', tool_calls: undefined },
    ])
  })

  it('keeps complete tool groups with multiple tool responses', () => {
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

describe('filterEmptyAssistantMessages', () => {
  it('drops assistant messages that have neither content nor tool calls', () => {
    const input: RequestMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'answer' },
    ]

    expect(filterEmptyAssistantMessages(input)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'answer' },
    ])
  })

  it('keeps assistant messages with tool calls even when content is empty', () => {
    const assistantMessage = assistantWithTools(['call-1'])
    const input: RequestMessage[] = [assistantMessage]

    expect(filterEmptyAssistantMessages(input)).toEqual(input)
  })
})
