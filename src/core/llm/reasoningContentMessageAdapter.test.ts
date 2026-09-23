import { RequestMessage } from '../../types/llm/request'

import { ReasoningContentMessageAdapter } from './reasoningContentMessageAdapter'

class TestAdapter extends ReasoningContentMessageAdapter {
  parseRequest(message: RequestMessage) {
    return this.parseRequestMessage(message)
  }
}

describe('ReasoningContentMessageAdapter', () => {
  const adapter = new TestAdapter()

  it('sends the reasoning back as reasoning_content, empty string included', () => {
    expect(
      adapter.parseRequest({
        role: 'assistant',
        content: '',
        reasoning: 'Need the file list first.',
        tool_calls: [{ id: 'call_1', name: 'list' }],
      }),
    ).toMatchObject({ reasoning_content: 'Need the file list first.' })
    expect(
      adapter.parseRequest({ role: 'assistant', content: 'Hi', reasoning: '' }),
    ).toMatchObject({ reasoning_content: '' })
  })

  it('omits the field when the message has no reasoning', () => {
    expect(
      adapter.parseRequest({ role: 'assistant', content: 'Hi' }),
    ).not.toHaveProperty('reasoning_content')
  })
})
