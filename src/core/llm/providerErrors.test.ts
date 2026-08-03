import OpenAI from 'openai'

import { formatErrorMessageWithCauses } from '../../utils/error-message'

import { BaseLLMProvider } from './base'
import {
  ProviderRequestError,
  createProviderErrorFetch,
  withProviderErrorReporting,
} from './providerErrors'

const createContext = () => ({
  providerId: 'Atlas',
  protocol: 'openai' as const,
  transportMode: 'node' as const,
})

describe('provider errors', () => {
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation()
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('normalizes a non-standard OpenAI-compatible error and logs its raw response', async () => {
    const fetch = createProviderErrorFetch(
      jest.fn(
        async () =>
          new Response(JSON.stringify({ code: 401, msg: 'invalid token' }), {
            status: 401,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'request-1',
            },
          }),
      ) as typeof globalThis.fetch,
      createContext(),
    )

    const response = await fetch('https://api.example.com/v1/chat/completions')

    await expect(response.json()).resolves.toMatchObject({
      code: 401,
      msg: 'invalid token',
      error: { message: 'invalid token', code: 401 },
    })
    expect(consoleError).toHaveBeenCalledWith(
      '[YOLO][LLM] Provider request failed',
      expect.objectContaining({
        providerId: 'Atlas',
        status: 401,
        requestId: 'request-1',
        responseBody: { code: 401, msg: 'invalid token' },
      }),
    )
  })

  it('prevents the OpenAI SDK from replacing a non-standard body with no body', async () => {
    const fetch = createProviderErrorFetch(
      jest.fn(
        async () =>
          new Response(JSON.stringify({ code: 401, msg: 'invalid token' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof globalThis.fetch,
      createContext(),
    )
    const client = new OpenAI({
      apiKey: 'invalid',
      baseURL: 'https://api.example.com/v1',
      dangerouslyAllowBrowser: true,
      fetch,
      maxRetries: 0,
    })

    await expect(
      client.chat.completions.create({
        model: 'anthropic/claude-opus-4.6',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).rejects.toMatchObject({
      status: 401,
      message: '401 invalid token',
    })
  })

  it('reads node-fetch error bodies used by the desktop transport', async () => {
    const rawBody = JSON.stringify({
      code: 401,
      msg: 'desktop invalid token',
    })
    const nodeLikeResponse = new Response(rawBody, {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
    jest.spyOn(nodeLikeResponse, 'clone').mockReturnValue({
      body: new TextEncoder().encode(rawBody),
    } as unknown as Response)
    const fetch = createProviderErrorFetch(
      jest.fn(async () => nodeLikeResponse) as typeof globalThis.fetch,
      createContext(),
    )

    const response = await fetch('https://api.example.com/v1/chat/completions')

    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'desktop invalid token' },
    })
  })

  it('does not rewrite a standard OpenAI error body', async () => {
    const body = { error: { message: 'standard failure', type: 'auth_error' } }
    const fetch = createProviderErrorFetch(
      jest.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof globalThis.fetch,
      createContext(),
    )

    const response = await fetch('https://api.example.com/v1/chat/completions')

    await expect(response.json()).resolves.toEqual(body)
  })

  it('keeps an oversized response intact for the SDK while bounding console capture', async () => {
    const longMessage = 'x'.repeat(70 * 1024)
    const rawBody = JSON.stringify({ msg: longMessage })
    const fetch = createProviderErrorFetch(
      jest.fn(
        async () =>
          new Response(rawBody, {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof globalThis.fetch,
      createContext(),
    )

    const response = await fetch('https://api.example.com/v1/chat/completions')

    await expect(response.text()).resolves.toBe(rawBody)
    expect(consoleError).toHaveBeenCalledWith(
      '[YOLO][LLM] Provider request failed',
      expect.objectContaining({ responseBodyTruncated: true }),
    )
  })

  it('presents a concise provider error without exposing its nested SDK cause', async () => {
    const sdkError = Object.assign(new Error('401 invalid token'), {
      status: 401,
      headers: { 'x-yolo-error-reported': '1' },
      error: { message: 'invalid token' },
    })
    const client = withProviderErrorReporting(
      {
        generateResponse: jest.fn(async () => {
          throw sdkError
        }),
      } as unknown as BaseLLMProvider<never>,
      'Atlas',
    )

    let thrown: unknown
    try {
      await client.generateResponse({ model: 'test' } as never, {} as never)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ProviderRequestError)
    expect(formatErrorMessageWithCauses(thrown)).toBe(
      'Atlas request failed (401): invalid token',
    )
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('does not report an intentional abort', async () => {
    const client = withProviderErrorReporting(
      {
        generateResponse: jest.fn(async () => {
          throw new DOMException('Aborted', 'AbortError')
        }),
      } as unknown as BaseLLMProvider<never>,
      'Atlas',
    )

    await expect(
      client.generateResponse({ model: 'test' } as never, {} as never),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(consoleError).not.toHaveBeenCalled()
  })
})
