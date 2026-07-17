import type {
  YoloAgentApi,
  YoloAgentEvent,
  YoloAgentRunRequest,
} from '../agent/agent-api'

import { ModuleLifecycleScope } from './lifecycleScope'
import { CoreModuleAgentCapabilityProvider } from './moduleAgent'

const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = []
  for await (const value of values) result.push(value)
  return result
}

describe('CoreModuleAgentCapabilityProvider', () => {
  it('maps stable request semantics and hides Core event identifiers', async () => {
    let received: YoloAgentRunRequest | undefined
    const events: YoloAgentEvent[] = [
      {
        type: 'text',
        conversationId: 'private-conversation',
        messageId: 'private-message',
        text: 'Hello',
        delta: 'Hel',
        streaming: true,
      },
      {
        type: 'tool',
        conversationId: 'private-conversation',
        toolCallId: 'private-tool-call',
        name: 'yolo_local__fs_read',
        status: 'running',
        arguments: { path: 'Notes/a.md' },
      },
      {
        type: 'state',
        conversationId: 'private-conversation',
        status: 'aborted',
      },
    ]
    const agent: YoloAgentApi = {
      run: jest.fn(),
      abort: jest.fn(),
      stream: async function* (request) {
        received = request
        yield* events
      },
    }
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleAgentCapabilityProvider({
      getAgentApi: async () => agent,
    }).create('learning', lifecycle)
    activation.activate()

    const request = {
      messages: [
        { role: 'user' as const, id: 'u1', content: 'Question' },
        { role: 'assistant' as const, id: 'a1', content: 'Answer' },
        { role: 'user' as const, id: 'u2', content: 'Continue' },
      ],
      modelId: 'model',
      systemPrompt: 'System',
      capability: 'vault-read' as const,
      workspaceScope: {
        enabled: true,
        include: ['References'],
        exclude: ['Private'],
      },
    }
    const output = await collect(activation.api.stream(request))

    expect(received).toMatchObject({
      modelId: 'model',
      mode: 'agent',
      yolo: true,
      systemPromptOverride: 'System',
      tools: {
        allowedToolNames: ['yolo_local__fs_read', 'yolo_local__fs_list'],
      },
      workspaceScope: {
        enabled: true,
        include: ['References'],
        exclude: ['Private'],
      },
    })
    expect(received?.messages).toEqual([
      {
        role: 'user',
        id: 'u1',
        content: null,
        promptContent: 'Question',
        mentionables: [],
      },
      { role: 'assistant', id: 'a1', content: 'Answer' },
      {
        role: 'user',
        id: 'u2',
        content: null,
        promptContent: 'Continue',
        mentionables: [],
      },
    ])
    expect(output).toEqual([
      { type: 'text', text: 'Hello', delta: 'Hel' },
      {
        type: 'tool',
        name: 'vault.read',
        status: 'running',
        arguments: { path: 'Notes/a.md' },
      },
      { type: 'aborted' },
    ])
    expect(JSON.stringify(output)).not.toContain('private-')
    expect(Object.isFrozen(output[1])).toBe(true)
    lifecycle.dispose()
  })

  it('rejects work before activation and after disposal', () => {
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleAgentCapabilityProvider({
      getAgentApi: async () => ({}) as YoloAgentApi,
    }).create('learning', lifecycle)
    const request = {
      prompt: 'Question',
      systemPrompt: 'System',
      capability: 'none' as const,
    }

    expect(() => activation.api.stream(request)).toThrow('not active')
    activation.activate()
    lifecycle.dispose()
    expect(() => activation.api.stream(request)).toThrow('no longer active')
  })

  it('aborts every in-flight stream when the module is disposed', async () => {
    let receivedSignal: AbortSignal | undefined
    let started!: () => void
    const didStart = new Promise<void>((resolve) => {
      started = resolve
    })
    const agent = {
      run: jest.fn(),
      abort: jest.fn(),
      stream: async function* (request: YoloAgentRunRequest) {
        receivedSignal = request.abortSignal
        started()
        await new Promise<void>((resolve) =>
          request.abortSignal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        )
        yield {
          type: 'state' as const,
          conversationId: 'private',
          status: 'aborted' as const,
        }
      },
    } satisfies YoloAgentApi
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleAgentCapabilityProvider({
      getAgentApi: async () => agent,
    }).create('learning', lifecycle)
    activation.activate()
    const stream = activation.api.stream({
      prompt: 'Question',
      systemPrompt: 'System',
      capability: 'none',
    })
    const iterator = stream[Symbol.asyncIterator]()
    const next = iterator.next()
    await didStart

    lifecycle.dispose()

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: 'aborted' },
    })
    expect(receivedSignal?.aborted).toBe(true)
    await iterator.return?.()
  })

  it('ends promptly when disposal interrupts a non-cooperative warmup', async () => {
    let started!: () => void
    const didStart = new Promise<void>((resolve) => {
      started = resolve
    })
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleAgentCapabilityProvider({
      getAgentApi: () => {
        started()
        return new Promise<YoloAgentApi>(() => undefined)
      },
    }).create('learning', lifecycle)
    activation.activate()
    const stream = activation.api.stream({
      prompt: 'Question',
      systemPrompt: 'System',
      capability: 'none',
    })
    const iterator = stream[Symbol.asyncIterator]()
    const next = iterator.next()
    await didStart

    lifecycle.dispose()

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: 'aborted' },
    })
    await iterator.return?.()
  })

  it('aborts the Core stream when its consumer stops early', async () => {
    let receivedSignal: AbortSignal | undefined
    const agent = {
      run: jest.fn(),
      abort: jest.fn(),
      stream: async function* (request: YoloAgentRunRequest) {
        receivedSignal = request.abortSignal
        yield {
          type: 'text' as const,
          conversationId: 'private',
          messageId: 'private',
          text: 'partial',
          delta: 'partial',
          streaming: true,
        }
        await new Promise<void>(() => undefined)
      },
    } satisfies YoloAgentApi
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleAgentCapabilityProvider({
      getAgentApi: async () => agent,
    }).create('learning', lifecycle)
    activation.activate()
    const stream = activation.api.stream({
      prompt: 'Question',
      systemPrompt: 'System',
      capability: 'vault-write',
    })
    const iterator = stream[Symbol.asyncIterator]()

    await iterator.next()
    await iterator.return?.()

    expect(receivedSignal?.aborted).toBe(true)
    lifecycle.dispose()
  })
})
