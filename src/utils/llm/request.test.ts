import { RequestMessage } from '../../types/llm/request'

import { formatMessages } from './request'

describe('formatMessages', () => {
  it('does not merge consecutive tool messages', () => {
    const messages: RequestMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: 'calling tools',
        tool_calls: [
          { id: 'call_1', name: 'toolA', arguments: '{}' },
          { id: 'call_2', name: 'toolA', arguments: '{}' },
        ],
      },
      {
        role: 'tool',
        tool_call: { id: 'call_1', name: 'toolA', arguments: '{}' },
        content: '{"result":1}',
      },
      {
        role: 'tool',
        tool_call: { id: 'call_2', name: 'toolA', arguments: '{}' },
        content: '{"result":2}',
      },
    ]

    const formatted = formatMessages(messages)

    expect(formatted).toHaveLength(4)
    expect(formatted[2].role).toBe('tool')
    expect(formatted[3].role).toBe('tool')
    if (formatted[2].role === 'tool' && formatted[3].role === 'tool') {
      expect(formatted[2].tool_call.id).toBe('call_1')
      expect(formatted[3].tool_call.id).toBe('call_2')
    }
  })

  it('merges consecutive user messages', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'world' },
    ]

    const formatted = formatMessages(messages)

    expect(formatted).toHaveLength(1)
    expect(formatted[0].role).toBe('user')
    if (formatted[0].role === 'user') {
      expect(formatted[0].content).toBe('hello\n\nworld')
    }
  })
})
