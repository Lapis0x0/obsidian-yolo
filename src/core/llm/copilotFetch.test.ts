import type { CopilotUsableCredential } from '../auth/copilotOAuthService'

import { CopilotCredentialSource, createCopilotFetch } from './copilotFetch'
import { LLMProviderNotConfiguredException } from './exception'

const session = (token: string): CopilotUsableCredential => ({
  copilotToken: token,
  copilotExpiresAt: Date.now() + 60 * 60 * 1000,
  apiBaseUrl: 'https://api.individual.githubcopilot.com',
})

const createSource = (
  tokens: (string | null)[],
): CopilotCredentialSource & {
  invalidateCopilotToken: jest.Mock
} => {
  let index = 0
  return {
    getUsableCredential: jest.fn(async () => {
      const token = tokens[Math.min(index, tokens.length - 1)]
      index += 1
      return token === null ? null : session(token)
    }),
    invalidateCopilotToken: jest.fn(),
  }
}

const createTransport = (statuses: number[] = [200]) => {
  let index = 0
  return jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const status = statuses[Math.min(index, statuses.length - 1)]
    index += 1
    return new Response('{}', { status })
  })
}

const sentHeaders = (transport: ReturnType<typeof createTransport>, call = 0) =>
  new Headers(transport.mock.calls[call][1]?.headers)

const chatBody = JSON.stringify({
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'hi' }],
})

describe('createCopilotFetch', () => {
  it('moves the request to the account origin and keeps the path', async () => {
    const transport = createTransport()
    const copilotFetch = createCopilotFetch(transport, () =>
      createSource(['tok-1']),
    )

    await copilotFetch('https://api.githubcopilot.com/v1/messages?beta=true', {
      method: 'POST',
      body: '{}',
    })

    expect(transport.mock.calls[0][0]).toBe(
      'https://api.individual.githubcopilot.com/v1/messages?beta=true',
    )
  })

  it('replaces the SDK credentials with the Copilot bearer token', async () => {
    const transport = createTransport()
    const copilotFetch = createCopilotFetch(transport, () =>
      createSource(['tok-1']),
    )

    await copilotFetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer github-copilot',
        'x-api-key': 'github-copilot',
        'X-Custom': 'kept',
      },
      body: chatBody,
    })

    const headers = sentHeaders(transport)
    expect(headers.get('authorization')).toBe('Bearer tok-1')
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.get('x-custom')).toBe('kept')
    expect(headers.get('copilot-integration-id')).toBe('vscode-chat')
    expect(headers.get('editor-version')).toBeTruthy()
    expect(headers.get('openai-intent')).toBe('conversation-edits')
  })

  it('derives X-Initiator and Copilot-Vision-Request from the body', async () => {
    const transport = createTransport()
    const copilotFetch = createCopilotFetch(transport, () =>
      createSource(['tok-1']),
    )

    await copilotFetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:' } }],
          },
          { role: 'assistant', content: null, tool_calls: [] },
          { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        ],
      }),
    })

    const headers = sentHeaders(transport)
    expect(headers.get('x-initiator')).toBe('agent')
    expect(headers.get('copilot-vision-request')).toBe('true')
  })

  it('omits Copilot-Vision-Request for a text-only request', async () => {
    const transport = createTransport()
    const copilotFetch = createCopilotFetch(transport, () =>
      createSource(['tok-1']),
    )

    await copilotFetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      body: chatBody,
    })

    const headers = sentHeaders(transport)
    expect(headers.get('x-initiator')).toBe('user')
    expect(headers.has('copilot-vision-request')).toBe(false)
  })

  it('reads a Request input', async () => {
    const transport = createTransport()
    const copilotFetch = createCopilotFetch(transport, () =>
      createSource(['tok-1']),
    )

    await copilotFetch(
      new Request('https://api.githubcopilot.com/responses', {
        method: 'POST',
        headers: { 'X-Custom': 'kept' },
        body: JSON.stringify({
          input: [{ type: 'function_call_output', call_id: 'c', output: '' }],
        }),
      }),
    )

    expect(transport.mock.calls[0][0]).toBe(
      'https://api.individual.githubcopilot.com/responses',
    )
    const init = transport.mock.calls[0][1]
    expect(init?.method).toBe('POST')
    expect(typeof init?.body).toBe('string')
    const headers = sentHeaders(transport)
    expect(headers.get('x-custom')).toBe('kept')
    expect(headers.get('x-initiator')).toBe('agent')
  })

  it('invalidates the rejected token and retries once on 401', async () => {
    const transport = createTransport([401, 200])
    const source = createSource(['stale', 'fresh'])
    const copilotFetch = createCopilotFetch(transport, () => source)

    const response = await copilotFetch(
      'https://api.githubcopilot.com/chat/completions',
      { method: 'POST', body: chatBody },
    )

    expect(response.status).toBe(200)
    expect(source.invalidateCopilotToken).toHaveBeenCalledWith('stale')
    expect(transport).toHaveBeenCalledTimes(2)
    expect(sentHeaders(transport, 1).get('authorization')).toBe('Bearer fresh')
    expect(transport.mock.calls[1][1]?.body).toBe(chatBody)
  })

  it('returns the second 401 instead of looping', async () => {
    const transport = createTransport([401])
    const source = createSource(['stale', 'still-stale'])
    const copilotFetch = createCopilotFetch(transport, () => source)

    const response = await copilotFetch(
      'https://api.githubcopilot.com/chat/completions',
      { method: 'POST', body: chatBody },
    )

    expect(response.status).toBe(401)
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('does not retry a request whose body cannot be replayed', async () => {
    const transport = createTransport([401, 200])
    const source = createSource(['stale', 'fresh'])
    const copilotFetch = createCopilotFetch(transport, () => source)

    const response = await copilotFetch(
      'https://api.githubcopilot.com/chat/completions',
      {
        method: 'POST',
        body: new ReadableStream(),
        duplex: 'half',
      } as RequestInit,
    )

    expect(response.status).toBe(401)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('reports a missing login without sending anything', async () => {
    const transport = createTransport()
    const copilotFetch = createCopilotFetch(transport, () =>
      createSource([null]),
    )

    await expect(
      copilotFetch('https://api.githubcopilot.com/chat/completions', {
        method: 'POST',
        body: chatBody,
      }),
    ).rejects.toBeInstanceOf(LLMProviderNotConfiguredException)
    expect(transport).not.toHaveBeenCalled()
  })
})
