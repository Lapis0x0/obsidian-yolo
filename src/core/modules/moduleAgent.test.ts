import type {
  YoloAgentApi,
  YoloAgentEvent,
  YoloAgentRunRequest,
} from '../agent/agent-api'

import { ModuleLifecycleScope } from './lifecycleScope'
import { CoreModuleAgentCapabilityProvider } from './moduleAgent'
import type { YoloModuleAgentToolV1 } from './types'

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

  describe('module agent tools', () => {
    const echoTool: YoloModuleAgentToolV1 = {
      name: 'emit_card',
      description: 'Emit a card',
      inputSchema: { type: 'object', properties: {} },
      handler: async (input) => ({ content: JSON.stringify(input) }),
    }

    const makeActivation = (agent: YoloAgentApi, moduleId = 'learning') => {
      const lifecycle = new ModuleLifecycleScope()
      const activation = new CoreModuleAgentCapabilityProvider({
        isDebugCaptureEnabled: () => false,
        getAgentApi: async () => agent,
      }).create(moduleId, lifecycle)
      activation.activate()
      return { activation, lifecycle }
    }

    it.each([
      [
        'name violating ^[a-z][a-z0-9_]*$',
        [{ ...echoTool, name: 'Emit-Card' }],
        '^[a-z][a-z0-9_]*$',
      ],
      ['duplicate names', [echoTool, { ...echoTool }], 'duplicated'],
      [
        'empty description',
        [{ ...echoTool, description: '  ' }],
        'description must be a non-empty string',
      ],
      [
        'non-object input schema',
        [
          {
            ...echoTool,
            inputSchema: [] as unknown as Record<string, unknown>,
          },
        ],
        'input schema must be an object',
      ],
      [
        'non-function handler',
        [
          {
            ...echoTool,
            handler:
              'not-a-function' as unknown as YoloModuleAgentToolV1['handler'],
          },
        ],
        'handler must be a function',
      ],
      [
        'more than 16 tools',
        Array.from({ length: 17 }, (_, i) => ({
          ...echoTool,
          name: `emit_card_${i}`,
        })),
        'must not exceed 16',
      ],
    ])('rejects tools with %s', (_label, tools, expectedMessage) => {
      const { activation } = makeActivation({
        run: jest.fn(),
        abort: jest.fn(),
        stream: async function* () {
          yield* [] as YoloAgentEvent[]
        },
      })

      expect(() =>
        activation.api.stream({
          prompt: 'Question',
          systemPrompt: 'System',
          capability: 'none',
          tools,
        }),
      ).toThrow(expectedMessage)
    })

    it('registers a run-scoped in-process server with the module tools and disposes nothing itself (that lives in agent-api.ts)', async () => {
      let received: YoloAgentRunRequest | undefined
      const { activation } = makeActivation({
        run: jest.fn(),
        abort: jest.fn(),
        stream: async function* (request) {
          received = request
          yield { type: 'completed', conversationId: 'private', text: 'ok' }
        },
      })

      await collect(
        activation.api.stream({
          prompt: 'Question',
          systemPrompt: 'System',
          capability: 'none',
          tools: [echoTool],
        }),
      )

      const inProcessServer = received?.tools?.inProcessServer
      expect(inProcessServer?.name).toMatch(/^module-learning-.+$/)
      expect(inProcessServer?.server.listTools()).toEqual([
        {
          name: 'emit_card',
          description: 'Emit a card',
          inputSchema: { type: 'object', properties: {} },
        },
      ])
      // The requested allowedToolNames stay capability-scoped (empty for
      // 'none'); agent-api.ts is responsible for unioning in the
      // in-process server's tool names — see agent-api.test.ts.
      expect(received?.tools?.allowedToolNames).toEqual([])
    })

    it('uses a distinct server name per stream call to avoid registration collisions on concurrent runs', async () => {
      const requests: YoloAgentRunRequest[] = []
      const { activation } = makeActivation({
        run: jest.fn(),
        abort: jest.fn(),
        stream: async function* (request) {
          requests.push(request)
          yield { type: 'completed', conversationId: 'private', text: 'ok' }
        },
      })

      await collect(
        activation.api.stream({
          prompt: 'First',
          systemPrompt: 'System',
          capability: 'none',
          tools: [echoTool],
        }),
      )
      await collect(
        activation.api.stream({
          prompt: 'Second',
          systemPrompt: 'System',
          capability: 'none',
          tools: [echoTool],
        }),
      )

      const names = requests.map((r) => r.tools?.inProcessServer?.name)
      expect(names[0]).toBeDefined()
      expect(names[1]).toBeDefined()
      expect(names[0]).not.toBe(names[1])
    })

    it("maps the handler's { content, isError } result onto the core ToolCallResponse shape", async () => {
      const tools: YoloModuleAgentToolV1[] = [
        {
          name: 'emit_card',
          description: 'Emit a card',
          inputSchema: { type: 'object' },
          handler: async (input) =>
            input.fail
              ? { content: 'validation failed', isError: true }
              : { content: 'ok' },
        },
      ]
      let received: YoloAgentRunRequest | undefined
      const { activation } = makeActivation({
        run: jest.fn(),
        abort: jest.fn(),
        stream: async function* (request) {
          received = request
          yield { type: 'completed', conversationId: 'private', text: 'ok' }
        },
      })

      await collect(
        activation.api.stream({
          prompt: 'Question',
          systemPrompt: 'System',
          capability: 'none',
          tools,
        }),
      )

      const server = received!.tools!.inProcessServer!.server
      await expect(
        server.callTool({
          toolName: 'emit_card',
          args: {},
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        status: 'success',
        data: { type: 'text', text: 'ok' },
      })
      await expect(
        server.callTool({
          toolName: 'emit_card',
          args: { fail: true },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ status: 'error', error: 'validation failed' })
    })

    it('serializes concurrent handler invocations in arrival order, across tools and past failures', async () => {
      const events: string[] = []
      let active = 0
      const record = async (label: string, fail = false) => {
        active += 1
        expect(active).toBe(1)
        events.push(`start:${label}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push(`end:${label}`)
        active -= 1
        if (fail) throw new Error(`${label} failed`)
        return { content: label }
      }
      const tools: YoloModuleAgentToolV1[] = [
        {
          name: 'emit_knowledge_point',
          description: 'Emit a knowledge point',
          inputSchema: { type: 'object' },
          handler: (input) => record(String(input.label), input.fail === true),
        },
        {
          name: 'emit_card',
          description: 'Emit a card',
          inputSchema: { type: 'object' },
          handler: (input) => record(String(input.label)),
        },
      ]
      let received: YoloAgentRunRequest | undefined
      const { activation } = makeActivation({
        run: jest.fn(),
        abort: jest.fn(),
        stream: async function* (request) {
          received = request
          yield { type: 'completed', conversationId: 'private', text: 'ok' }
        },
      })

      await collect(
        activation.api.stream({
          prompt: 'Question',
          systemPrompt: 'System',
          capability: 'none',
          tools,
        }),
      )

      const server = received!.tools!.inProcessServer!.server
      const signal = new AbortController().signal
      const results = await Promise.allSettled([
        server.callTool({
          toolName: 'emit_knowledge_point',
          args: { label: 'a' },
          signal,
        }),
        server.callTool({
          toolName: 'emit_knowledge_point',
          args: { label: 'b', fail: true },
          signal,
        }),
        server.callTool({
          toolName: 'emit_card',
          args: { label: 'c' },
          signal,
        }),
      ])

      expect(events).toEqual([
        'start:a',
        'end:a',
        'start:b',
        'end:b',
        'start:c',
        'end:c',
      ])
      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
      ])
    })

    it('lets a thrown handler error propagate (the registry converts it to an Error-status response)', async () => {
      const tools: YoloModuleAgentToolV1[] = [
        {
          name: 'emit_card',
          description: 'Emit a card',
          inputSchema: { type: 'object' },
          handler: async () => {
            throw new Error('boom')
          },
        },
      ]
      let received: YoloAgentRunRequest | undefined
      const { activation } = makeActivation({
        run: jest.fn(),
        abort: jest.fn(),
        stream: async function* (request) {
          received = request
          yield { type: 'completed', conversationId: 'private', text: 'ok' }
        },
      })

      await collect(
        activation.api.stream({
          prompt: 'Question',
          systemPrompt: 'System',
          capability: 'none',
          tools,
        }),
      )

      const server = received!.tools!.inProcessServer!.server
      await expect(
        server.callTool({
          toolName: 'emit_card',
          args: {},
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('boom')
    })

    it('shows the module tool by its bare name in tool events instead of "unknown"', async () => {
      let inProcessServerName = ''
      const { activation } = makeActivation({
        run: jest.fn(),
        abort: jest.fn(),
        stream: async function* (request) {
          inProcessServerName = request.tools!.inProcessServer!.name
          yield {
            type: 'tool',
            conversationId: 'private',
            toolCallId: 'call-1',
            name: `${inProcessServerName}__emit_card`,
            status: 'completed',
          }
          yield { type: 'completed', conversationId: 'private', text: 'ok' }
        },
      })

      const output = await collect(
        activation.api.stream({
          prompt: 'Question',
          systemPrompt: 'System',
          capability: 'none',
          tools: [echoTool],
        }),
      )

      expect(output[0]).toMatchObject({
        type: 'tool',
        name: 'emit_card',
        status: 'completed',
      })
    })

    it("keeps the module's own tool name out of error-message sanitization while still redacting unrelated internal names", async () => {
      let inProcessServerName = ''
      const { activation } = makeActivation({
        run: jest.fn(),
        abort: jest.fn(),
        stream: async function* (request) {
          inProcessServerName = request.tools!.inProcessServer!.name
          yield {
            type: 'error',
            conversationId: 'private',
            message: `Tool ${inProcessServerName}__emit_card failed after yolo_local__bash also failed`,
          }
        },
      })

      const output = await collect(
        activation.api.stream({
          prompt: 'Question',
          systemPrompt: 'System',
          capability: 'none',
          tools: [echoTool],
        }),
      )

      expect(output).toEqual([
        {
          type: 'error',
          message: 'Tool emit_card failed after internal tool also failed',
        },
      ])
    })
  })
})
