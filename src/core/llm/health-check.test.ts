import { LLMModelNotFoundException } from './exception'
import {
  HealthCheckAbortedError,
  testChatModelHealth,
  testEmbeddingModelHealth,
} from './health-check'

const mockStreamResponse = jest.fn()
const mockGetEmbedding = jest.fn()

jest.mock('./manager', () => ({
  getProviderClient: jest.fn(() => ({
    streamResponse: mockStreamResponse,
  })),
}))

jest.mock('../rag/embedding', () => ({
  getEmbeddingModelClient: jest.fn(() => ({
    getEmbedding: mockGetEmbedding,
  })),
}))

const settings: any = { providers: [{ id: 'p' }] }

const chatModel: any = { id: 'p/m', providerId: 'p', model: 'm-call' }
const embeddingModel: any = {
  id: 'p/e',
  providerId: 'p',
  model: 'e-call',
  dimension: 3072,
}

const contentChunk = (text: string) => ({
  choices: [{ delta: { content: text } }],
})
const reasoningChunk = (text: string) => ({
  choices: [{ delta: { reasoning: text } }],
})
const usageChunk = (completionTokens: number) => ({
  choices: [{ delta: {} }],
  usage: { completion_tokens: completionTokens },
})

beforeEach(() => {
  mockStreamResponse.mockReset()
  mockGetEmbedding.mockReset()
})

describe('testChatModelHealth', () => {
  it('returns ok with first-token latency when content arrives', async () => {
    mockStreamResponse.mockImplementation(async () => {
      return (async function* () {
        yield contentChunk('o')
        await new Promise((r) => setTimeout(r, 10))
        yield usageChunk(5)
      })()
    })

    const result = await testChatModelHealth(settings, chatModel, {
      signal: new AbortController().signal,
    })

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(typeof result.firstTokenMs).toBe('number')
      expect(result.firstTokenMs as number).toBeGreaterThanOrEqual(0)
    }
  })

  it('captures first-token latency from a reasoning delta (reasoning model)', async () => {
    mockStreamResponse.mockImplementation(async () => {
      return (async function* () {
        yield reasoningChunk('thinking…')
        yield contentChunk('ok')
      })()
    })

    const result = await testChatModelHealth(settings, chatModel, {
      signal: new AbortController().signal,
    })

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(typeof result.firstTokenMs).toBe('number')
    }
  })

  it('returns ok with firstTokenMs undefined when no text delta arrives (usage-only)', async () => {
    mockStreamResponse.mockImplementation(async () => {
      return (async function* () {
        yield usageChunk(3)
      })()
    })

    const result = await testChatModelHealth(settings, chatModel, {
      signal: new AbortController().signal,
    })

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.firstTokenMs).toBeUndefined()
    }
  })

  it('maps a model-not-found error to a 404 failure', async () => {
    mockStreamResponse.mockRejectedValue(
      new LLMModelNotFoundException('model not found'),
    )

    const result = await testChatModelHealth(settings, chatModel, {
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ status: 'fail', code: 404 })
  })

  it('extracts an HTTP status from a raw SDK error', async () => {
    mockStreamResponse.mockRejectedValue({
      status: 401,
      message: 'unauthorized',
    })

    const result = await testChatModelHealth(settings, chatModel, {
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ status: 'fail', code: 401 })
  })

  it('returns timeout when the request exceeds the budget', async () => {
    mockStreamResponse.mockImplementation(async (_model, _req, opts) => {
      return (async function* () {
        await new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
        yield usageChunk(0) // unreachable: the promise above always rejects
      })()
    })

    const result = await testChatModelHealth(settings, chatModel, {
      signal: new AbortController().signal,
      timeoutMs: 20,
    })

    expect(result.status).toBe('timeout')
  })

  it('throws HealthCheckAbortedError when cancelled by the caller', async () => {
    const controller = new AbortController()
    mockStreamResponse.mockImplementation(async (_model, _req, opts) => {
      return (async function* () {
        await new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
        yield usageChunk(0) // unreachable: the promise above always rejects
      })()
    })

    const promise = testChatModelHealth(settings, chatModel, {
      signal: controller.signal,
    })
    // Cancel after the stream has started.
    setTimeout(() => controller.abort(), 10)

    await expect(promise).rejects.toBeInstanceOf(HealthCheckAbortedError)
  })
})

describe('testEmbeddingModelHealth', () => {
  it('returns ok with the returned vector dimension', async () => {
    mockGetEmbedding.mockResolvedValue(new Array(3072).fill(0))

    const result = await testEmbeddingModelHealth(settings, embeddingModel, {
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ status: 'ok', dimension: 3072 })
  })

  it('returns a failure when the embedding call rejects (e.g. dimension mismatch)', async () => {
    mockGetEmbedding.mockRejectedValue(new Error('dimension mismatch'))

    const result = await testEmbeddingModelHealth(settings, embeddingModel, {
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ status: 'fail' })
    if (result.status === 'fail') {
      expect(result.message).toContain('dimension mismatch')
    }
  })
})
