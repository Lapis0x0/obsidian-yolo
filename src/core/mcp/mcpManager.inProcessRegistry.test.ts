jest.mock('obsidian')

import { App, Platform } from 'obsidian'

import { ToolCallResponseStatus } from '../../types/tool-call.types'

import type { InProcessToolServer } from './inProcessToolServer'
import { getLocalFileToolServerName } from './localFileToolNames'
import { McpManager } from './mcpManager'

const OBSIDIAN_CONFIG_DIR = ['.', 'obsidian'].join('')

describe('McpManager in-process tool server registry', () => {
  const originalIsDesktop = Platform.isDesktop

  beforeEach(() => {
    // Registry behavior is platform-agnostic; keep tests on the simpler
    // mobile (remoteMcpDisabled) path so remote-server wiring stays out of
    // scope.
    Platform.isDesktop = false
  })

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  function createManager(configuredServerNames: string[] = []): McpManager {
    const manager = new McpManager({
      pluginId: 'test-plugin',
      app: {
        vault: { configDir: OBSIDIAN_CONFIG_DIR },
      } as unknown as App,
      settings: {
        mcp: {
          servers: [],
          builtinCapabilityOptions: {},
        },
        webSearch: {
          providers: [],
          defaultProviderId: undefined,
          common: {
            resultSize: 8,
            searchTimeoutMs: 15000,
            scrapeTimeoutMs: 20000,
          },
        },
      } as never,
      openApplyReview: jest.fn(),
      registerSettingsListener: () => () => {},
    })

    if (configuredServerNames.length > 0) {
      // Mirrors the `servers` cast used in mcpManager.test.ts to seed a
      // connected-server snapshot without going through the full connect
      // flow — only the `name` field matters for the collision check under
      // test here.
      ;(manager as unknown as { servers: { name: string }[] }).servers =
        configuredServerNames.map((name) => ({ name }))
    }

    return manager
  }

  function createEchoServer(overrides?: Partial<InProcessToolServer>): {
    server: InProcessToolServer
    calls: { toolName: string; args: Record<string, unknown> }[]
  } {
    const calls: { toolName: string; args: Record<string, unknown> }[] = []
    const server: InProcessToolServer = {
      listTools: () => [
        {
          name: 'echo',
          description: 'Echo the input back.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      callTool: async ({ toolName, args }) => {
        calls.push({ toolName, args })
        return {
          status: ToolCallResponseStatus.Success,
          data: { type: 'text', text: JSON.stringify(args) },
        }
      },
      ...overrides,
    }
    return { server, calls }
  }

  it('lists a registered server tool prefixed with its server name', async () => {
    const manager = createManager()
    const { server } = createEchoServer()
    manager.registerInProcessServer('demo_module', server)

    const tools = await manager.listAvailableTools()

    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'demo_module__echo' }),
      ]),
    )
  })

  it('surfaces registered tools even when includeBuiltinTools is false', async () => {
    const manager = createManager()
    const { server } = createEchoServer()
    manager.registerInProcessServer('demo_module', server)

    const tools = await manager.listAvailableTools({
      includeBuiltinTools: false,
    })

    expect(tools).toEqual([
      expect.objectContaining({ name: 'demo_module__echo' }),
    ])
  })

  it('routes callTool to the registered handler', async () => {
    const manager = createManager()
    const { server, calls } = createEchoServer()
    manager.registerInProcessServer('demo_module', server)

    const result = await manager.callTool({
      name: 'demo_module__echo',
      args: { hello: 'world' },
    })

    expect(result).toEqual({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: JSON.stringify({ hello: 'world' }) },
    })
    expect(calls).toEqual([{ toolName: 'echo', args: { hello: 'world' } }])
  })

  it('passes an AbortSignal through to the handler and routes abortToolCall', async () => {
    const manager = createManager()
    let receivedSignal: AbortSignal | undefined
    const server: InProcessToolServer = {
      listTools: () => [
        {
          name: 'slow',
          description: 'Never resolves until aborted.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      callTool: ({ signal }) => {
        receivedSignal = signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
    }
    manager.registerInProcessServer('demo_module', server)

    const pending = manager.callTool({
      name: 'demo_module__slow',
      id: 'call-1',
      args: {},
    })

    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(manager.abortToolCall('call-1')).toBe(true)

    await expect(pending).resolves.toEqual({
      status: ToolCallResponseStatus.Aborted,
    })
  })

  it('converts a thrown handler error into an Error-status result instead of rejecting the caller', async () => {
    const manager = createManager()
    const server: InProcessToolServer = {
      listTools: () => [
        {
          name: 'boom',
          description: 'Always throws.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      callTool: () => {
        throw new Error('handler exploded')
      },
    }
    manager.registerInProcessServer('demo_module', server)

    await expect(
      manager.callTool({ name: 'demo_module__boom', args: {} }),
    ).resolves.toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'handler exploded',
    })
  })

  it('converts a rejected handler promise into an Error-status result', async () => {
    const manager = createManager()
    const server: InProcessToolServer = {
      listTools: () => [
        {
          name: 'boom',
          description: 'Always rejects.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      callTool: () => Promise.reject(new Error('async explosion')),
    }
    manager.registerInProcessServer('demo_module', server)

    await expect(
      manager.callTool({ name: 'demo_module__boom', args: {} }),
    ).resolves.toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'async explosion',
    })
  })

  it('unregisters via the returned dispose function', async () => {
    const manager = createManager()
    const { server } = createEchoServer()
    const dispose = manager.registerInProcessServer('demo_module', server)

    dispose()

    const tools = await manager.listAvailableTools()
    expect(tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'demo_module__echo' }),
      ]),
    )
    await expect(
      manager.callTool({ name: 'demo_module__echo', args: {} }),
    ).resolves.toMatchObject({ status: ToolCallResponseStatus.Error })
  })

  it('dispose is idempotent and safe to call twice', () => {
    const manager = createManager()
    const { server } = createEchoServer()
    const dispose = manager.registerInProcessServer('demo_module', server)

    expect(() => {
      dispose()
      dispose()
    }).not.toThrow()
  })

  it('rejects a registration name that collides with the local file tool server', () => {
    const manager = createManager()
    const { server } = createEchoServer()

    expect(() =>
      manager.registerInProcessServer(getLocalFileToolServerName(), server),
    ).toThrow(/reserved for built-in local tools/)
  })

  it('rejects a registration name that is already registered', () => {
    const manager = createManager()
    const { server: first } = createEchoServer()
    const { server: second } = createEchoServer()
    manager.registerInProcessServer('demo_module', first)

    expect(() =>
      manager.registerInProcessServer('demo_module', second),
    ).toThrow(/already registered/)
  })

  it('allows registering a server using the reserved module-mode- prefix', () => {
    const manager = createManager()
    const { server } = createEchoServer()

    expect(() =>
      manager.registerInProcessServer('module-mode-learning-chat', server),
    ).not.toThrow()
  })

  it('rejects a registration name that collides with a configured MCP server', () => {
    const manager = createManager(['remote'])
    const { server } = createEchoServer()

    expect(() => manager.registerInProcessServer('remote', server)).toThrow(
      /conflicts with a configured MCP server/,
    )
  })

  it('allows re-registering the same name after a prior dispose', () => {
    const manager = createManager()
    const { server: first } = createEchoServer()
    const { server: second } = createEchoServer()
    const dispose = manager.registerInProcessServer('demo_module', first)
    dispose()

    expect(() =>
      manager.registerInProcessServer('demo_module', second),
    ).not.toThrow()
  })

  it('excludes an unknown tool name on a registered server from execution allowance', () => {
    const manager = createManager()
    const { server } = createEchoServer()
    manager.registerInProcessServer('demo_module', server)

    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'demo_module__not_a_real_tool',
        requireAutoExecution: true,
      }),
    ).toBe(false)
    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'demo_module__echo',
        requireAutoExecution: true,
      }),
    ).toBe(true)
  })
})
