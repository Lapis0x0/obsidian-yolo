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
        name: 'yolo_local__bash',
        status: 'running',
        arguments: { command: 'cat Notes/a.md' },
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
      isDebugCaptureEnabled: () => false,
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
        allowedToolNames: ['yolo_local__bash'],
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
        name: 'vault.bash',
        status: 'running',
        arguments: { command: 'cat Notes/a.md' },
      },
      { type: 'aborted' },
    ])
    expect(JSON.stringify(output)).not.toContain('private-')
    expect(Object.isFrozen(output[1])).toBe(true)
    lifecycle.dispose()
  })

  it.each([
    ['vault-read' as const, true],
    ['vault-write' as const, false],
    ['none' as const, false],
  ])(
    'maps capability %s to bashReadOnly=%s so bash writes stay gated by capability, not just tool visibility',
    async (capability, expectedBashReadOnly) => {
      let received: YoloAgentRunRequest | undefined
      const agent: YoloAgentApi = {
        run: jest.fn(),
        abort: jest.fn(),
        stream: async function* (request) {
          received = request
          yield { type: 'completed', conversationId: 'private', text: 'done' }
        },
      }
      const lifecycle = new ModuleLifecycleScope()
      const activation = new CoreModuleAgentCapabilityProvider({
        isDebugCaptureEnabled: () => false,
        getAgentApi: async () => agent,
      }).create('learning', lifecycle)
      activation.activate()

      await collect(
        activation.api.stream({
          prompt: 'Question',
          systemPrompt: 'System',
          capability,
        }),
      )

      expect(received?.bashReadOnly).toBe(expectedBashReadOnly)
      lifecycle.dispose()
    },
  )

  it('rejects work before activation and after disposal', () => {
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleAgentCapabilityProvider({
      isDebugCaptureEnabled: () => false,
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

  it('maps generic activity data into the module scope', async () => {
    let received: YoloAgentRunRequest | undefined
    const agent = {
      run: jest.fn(),
      abort: jest.fn(),
      stream: async function* (request: YoloAgentRunRequest) {
        received = request
        yield {
          type: 'completed' as const,
          conversationId: 'private-conversation',
          text: 'done',
        }
      },
    } satisfies YoloAgentApi
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleAgentCapabilityProvider({
      isDebugCaptureEnabled: () => false,
      getAgentApi: async () => agent,
    }).create('example-module', lifecycle)
    activation.activate()

    await collect(
      activation.api.stream({
        prompt: 'Question',
        systemPrompt: 'System',
        capability: 'none',
        activity: {
          title: 'Generating',
          detail: 'Drafting cards',
          // Runtime snapshotting must discard properties outside the public API.
          kind: 'private-kind',
          action: 'private-action',
        } as never,
      }),
    )

    expect(received?.activity).toMatchObject({
      kind: 'module:example-module',
      title: 'Generating',
      detail: 'Drafting cards',
    })
    expect(JSON.stringify(received?.activity)).not.toContain(
      'private-conversation',
    )
    lifecycle.dispose()
  })

  it('logs module output only under the live host debug-capture opt-in', async () => {
    const group = jest
      .spyOn(console, 'groupCollapsed')
      .mockImplementation(() => undefined)
    const debug = jest
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined)
    const groupEnd = jest
      .spyOn(console, 'groupEnd')
      .mockImplementation(() => undefined)
    let enabled = false
    const agent = {
      run: jest.fn(),
      abort: jest.fn(),
      stream: async function* () {
        yield {
          type: 'text' as const,
          conversationId: 'private',
          messageId: 'private',
          text: 'raw model output',
          delta: 'raw model output',
          streaming: true,
        }
        yield {
          type: 'completed' as const,
          conversationId: 'private',
          text: 'raw model output',
        }
      },
    } satisfies YoloAgentApi
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleAgentCapabilityProvider({
      isDebugCaptureEnabled: () => enabled,
      getAgentApi: async () => agent,
    }).create('learning', lifecycle)
    activation.activate()
    const request = {
      prompt: 'Question',
      systemPrompt: 'System',
      capability: 'none' as const,
      activity: { title: 'Generating cards', detail: 'Chapter one' },
    }

    await collect(activation.api.stream(request))
    expect(group).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()

    enabled = true
    await collect(activation.api.stream(request))
    expect(group).toHaveBeenCalledWith(
      expect.stringContaining(
        '[yolo-module-agent] learning completed · Generating cards — Chapter one',
      ),
    )
    expect(debug).toHaveBeenCalledWith('raw model output')

    lifecycle.dispose()
    group.mockRestore()
    debug.mockRestore()
    groupEnd.mockRestore()
  })

  it('does not emit an empty debug log for an aborted module request', async () => {
    const group = jest
      .spyOn(console, 'groupCollapsed')
      .mockImplementation(() => undefined)
    const agent = {
      run: jest.fn(),
      abort: jest.fn(),
      stream: async function* () {
        yield {
          type: 'state' as const,
          conversationId: 'private',
          status: 'aborted' as const,
        }
      },
    } satisfies YoloAgentApi
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleAgentCapabilityProvider({
      isDebugCaptureEnabled: () => true,
      getAgentApi: async () => agent,
    }).create('learning', lifecycle)
    activation.activate()

    await expect(
      collect(
        activation.api.stream({
          prompt: 'Question',
          systemPrompt: 'System',
          capability: 'none',
        }),
      ),
    ).resolves.toEqual([{ type: 'aborted' }])
    expect(group).not.toHaveBeenCalled()

    lifecycle.dispose()
    group.mockRestore()
  })

  it('does not misclassify an uncorrelated Core AbortError as cancellation', async () => {
    const abortError = new Error('Core run cancelled')
    abortError.name = 'AbortError'
    const agent = {
      run: jest.fn(),
      abort: jest.fn(),
      stream: async function* () {
        throw abortError
        yield* [] as YoloAgentEvent[]
      },
    } satisfies YoloAgentApi
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleAgentCapabilityProvider({
      isDebugCaptureEnabled: () => false,
      getAgentApi: async () => agent,
    }).create('example-module', lifecycle)
    activation.activate()

    await expect(
      collect(
        activation.api.stream({
          prompt: 'Question',
          systemPrompt: 'System',
          capability: 'none',
        }),
      ),
    ).resolves.toEqual([{ type: 'error', message: 'Core run cancelled' }])
    lifecycle.dispose()
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
      isDebugCaptureEnabled: () => false,
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
      isDebugCaptureEnabled: () => false,
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
      isDebugCaptureEnabled: () => false,
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
