jest.mock('obsidian')

// `lodash.isequal` exposes its function via `module.exports = fn`. Without
// runtime esModuleInterop ts-jest's default-import shim resolves `.default` to
// undefined; re-route the default to the real function so settings-diff calls
// don't throw.
jest.mock('lodash.isequal', () => {
  const actual = jest.requireActual('lodash.isequal') as unknown
  return { __esModule: true, default: actual }
})

const fakeClientInstances: FakeClient[] = []

class FakeClient {
  public onclose: (() => void) | undefined
  public transport: object | undefined = undefined
  public listToolsMock = jest.fn().mockResolvedValue({ tools: [] })
  public callToolMock = jest.fn()
  public closeMock = jest.fn()

  constructor() {
    fakeClientInstances.push(this)
  }

  async connect(transport: unknown): Promise<void> {
    if (
      transport !== null &&
      typeof transport === 'object' &&
      'connectError' in transport
    ) {
      throw (transport as { connectError: Error }).connectError
    }
    this.transport = (transport as object | undefined) ?? {}
  }

  async listTools(): Promise<{ tools: unknown[] }> {
    return this.listToolsMock()
  }

  async callTool(
    params: unknown,
    schema: unknown,
    options: unknown,
  ): Promise<unknown> {
    return this.callToolMock(params, schema, options)
  }

  async close(): Promise<void> {
    this.closeMock()
    if (this.transport !== undefined) {
      this.transport = undefined
      this.onclose?.()
    }
  }

  // Simulate the server-side closing the transport without our manager
  // calling close() — mirrors SDK `_onclose` ordering.
  emitServerClose(): void {
    if (this.transport === undefined) {
      return
    }
    this.transport = undefined
    this.onclose?.()
  }
}

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
}))

import { App, Platform } from 'obsidian'

import {
  McpServerConfig,
  McpServerState,
  McpServerStatus,
} from '../../types/mcp.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { McpManager } from './mcpManager'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const stdioServerConfig = (id = 'demo'): McpServerConfig => ({
  id,
  enabled: true,
  parameters: {
    transport: 'stdio',
    command: 'noop',
  },
  toolOptions: {},
})

const httpServerConfig = (id = 'demo'): McpServerConfig => ({
  id,
  enabled: true,
  parameters: {
    transport: 'http',
    url: 'https://example.com/mcp',
  },
  toolOptions: {},
})

const buildManager = () => {
  const manager = new McpManager({
    app: { vault: {} } as unknown as App,
    settings: {
      mcp: {
        servers: [],
        builtinToolOptions: {},
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
  // Bypass real transport creation — we only care about Client lifecycle here.
  ;(
    manager as unknown as { createClientTransport: jest.Mock }
  ).createClientTransport = jest.fn().mockResolvedValue({})
  return manager
}

const connectedServer = (manager: McpManager, id: string) => {
  const state = manager.getServers().find((s: McpServerState) => s.name === id)
  if (!state || state.status !== McpServerStatus.Connected) {
    throw new Error(`Server ${id} is not in Connected state: ${state?.status}`)
  }
  return state
}

describe('McpManager self-heal', () => {
  const originalIsDesktop = Platform.isDesktop
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    Platform.isDesktop = true
    fakeClientInstances.length = 0
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    Platform.isDesktop = originalIsDesktop
  })

  it('retries HTTP connection setup with the JSON backend after Chromium fetch fails', async () => {
    const manager = buildManager()
    const createClientTransport = jest
      .fn()
      .mockImplementation(
        async (
          _params: McpServerConfig['parameters'],
          options?: { httpBackend?: string },
        ) => {
          if (options?.httpBackend === 'obsidian-request-url-json') {
            return { backend: options.httpBackend }
          }

          return {
            backend: options?.httpBackend,
            connectError: new TypeError('Failed to fetch'),
          }
        },
      )
    ;(
      manager as unknown as { createClientTransport: jest.Mock }
    ).createClientTransport = createClientTransport

    await manager.handleSettingsUpdate({
      mcp: { servers: [httpServerConfig()], builtinToolOptions: {} },
      webSearch: {
        providers: [],
        defaultProviderId: undefined,
        common: {
          resultSize: 8,
          searchTimeoutMs: 15000,
          scrapeTimeoutMs: 20000,
        },
      },
    } as never)

    expect(createClientTransport).toHaveBeenCalledTimes(2)
    expect(createClientTransport).toHaveBeenNthCalledWith(
      1,
      httpServerConfig().parameters,
      { httpBackend: 'chromium-fetch' },
    )
    expect(createClientTransport).toHaveBeenNthCalledWith(
      2,
      httpServerConfig().parameters,
      { httpBackend: 'obsidian-request-url-json' },
    )
    expect(fakeClientInstances).toHaveLength(2)
    expect(connectedServer(manager, 'demo').client.transport).toEqual({
      backend: 'obsidian-request-url-json',
    })
  })

  it('automatically reconnects when the underlying transport closes unexpectedly', async () => {
    const manager = buildManager()

    await manager.handleSettingsUpdate({
      mcp: { servers: [stdioServerConfig()], builtinToolOptions: {} },
      webSearch: {
        providers: [],
        defaultProviderId: undefined,
        common: {
          resultSize: 8,
          searchTimeoutMs: 15000,
          scrapeTimeoutMs: 20000,
        },
      },
    } as never)

    expect(fakeClientInstances).toHaveLength(1)
    const firstClient = fakeClientInstances[0]
    const firstState = connectedServer(manager, 'demo')
    expect(firstState.client).toBe(firstClient)

    // Simulate server-side transport close (e.g. stdio server died after a
    // cancelled notification).
    firstClient.emitServerClose()

    // After onclose fires, manager flips into Connecting then awaits a new
    // connection. Let the async reconnect chain settle.
    await flush()
    await flush()
    await flush()

    expect(fakeClientInstances).toHaveLength(2)
    const secondState = connectedServer(manager, 'demo')
    expect(secondState.client).toBe(fakeClientInstances[1])
    expect(secondState.client).not.toBe(firstClient)
  })

  it('triggers reconnect on -32000 errors from callTool without replaying the request', async () => {
    const manager = buildManager()

    await manager.handleSettingsUpdate({
      mcp: { servers: [stdioServerConfig()], builtinToolOptions: {} },
      webSearch: {
        providers: [],
        defaultProviderId: undefined,
        common: {
          resultSize: 8,
          searchTimeoutMs: 15000,
          scrapeTimeoutMs: 20000,
        },
      },
    } as never)

    const firstClient = fakeClientInstances[0]
    // Avoid double-dispatch: silence the onclose-driven path so we exercise
    // the callTool fallback specifically.
    firstClient.onclose = undefined

    // Simulate SDK behavior on transport loss: clear .transport and reject
    // with an McpError carrying code -32000.
    firstClient.transport = undefined
    const mcpConnectionClosed = Object.assign(
      new Error('MCP error -32000: Connection closed'),
      { code: -32000 },
    )
    firstClient.callToolMock.mockRejectedValue(mcpConnectionClosed)

    const result = await manager.callTool({
      name: 'demo__some_tool',
      args: {},
    })

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'MCP error -32000: Connection closed',
    })
    // Critical: we must not replay tool calls automatically.
    expect(firstClient.callToolMock).toHaveBeenCalledTimes(1)

    await flush()
    await flush()
    await flush()

    // Reconnect should have produced a fresh client.
    expect(fakeClientInstances).toHaveLength(2)
    const reconnected = connectedServer(manager, 'demo')
    expect(reconnected.client).toBe(fakeClientInstances[1])
  })

  it('gives up auto-reconnect after exceeding the throttle window', async () => {
    const manager = buildManager()

    await manager.handleSettingsUpdate({
      mcp: { servers: [stdioServerConfig()], builtinToolOptions: {} },
      webSearch: {
        providers: [],
        defaultProviderId: undefined,
        common: {
          resultSize: 8,
          searchTimeoutMs: 15000,
          scrapeTimeoutMs: 20000,
        },
      },
    } as never)

    // RECONNECT_MAX_ATTEMPTS is 3 — the 4th unexpected close should land in
    // Error and not produce a new client.
    for (let i = 0; i < 3; i++) {
      const current = manager
        .getServers()
        .find((s: McpServerState) => s.name === 'demo')
      if (!current || current.status !== McpServerStatus.Connected) {
        throw new Error(`Server demo not connected on iteration ${i}`)
      }
      ;(current.client as unknown as FakeClient).emitServerClose()
      await flush()
      await flush()
      await flush()
    }

    expect(fakeClientInstances).toHaveLength(4)
    const fourthState = connectedServer(manager, 'demo')
    ;(fourthState.client as unknown as FakeClient).emitServerClose()
    await flush()
    await flush()

    // No new client constructed — throttle kicked in.
    expect(fakeClientInstances).toHaveLength(4)
    const finalState = manager
      .getServers()
      .find((s: McpServerState) => s.name === 'demo')
    expect(finalState?.status).toBe(McpServerStatus.Error)
  })

  it('resets the reconnect throttle when settings change for that server', async () => {
    const manager = buildManager()

    await manager.handleSettingsUpdate({
      mcp: { servers: [stdioServerConfig()], builtinToolOptions: {} },
      webSearch: {
        providers: [],
        defaultProviderId: undefined,
        common: {
          resultSize: 8,
          searchTimeoutMs: 15000,
          scrapeTimeoutMs: 20000,
        },
      },
    } as never)

    // Burn through the throttle so the next close would give up.
    for (let i = 0; i < 3; i++) {
      const state = connectedServer(manager, 'demo')
      ;(state.client as unknown as FakeClient).emitServerClose()
      await flush()
      await flush()
      await flush()
    }
    expect(fakeClientInstances).toHaveLength(4)

    // User edits the server config — this should drop the throttle so a new
    // window starts.
    await manager.handleSettingsUpdate({
      mcp: {
        servers: [
          {
            ...stdioServerConfig(),
            parameters: {
              transport: 'stdio',
              command: 'noop',
              args: ['--flag'],
            },
          },
        ],
        builtinToolOptions: {},
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
    } as never)
    await flush()
    await flush()

    // handleSettingsUpdate closes the previous Connected client (Diff path)
    // and probes the new config — that produces another FakeClient (index 5).
    expect(fakeClientInstances.length).toBeGreaterThanOrEqual(5)
    const afterSettingsChange = connectedServer(manager, 'demo')
    ;(afterSettingsChange.client as unknown as FakeClient).emitServerClose()
    await flush()
    await flush()
    await flush()

    // The post-settings close should have triggered a fresh reconnect rather
    // than being denied by the (now-stale) throttle counter.
    const after = connectedServer(manager, 'demo')
    expect(after.client).not.toBe(afterSettingsChange.client)
    expect(after.status).toBe(McpServerStatus.Connected)
  })

  it('skips reconnect when a plain JSON-RPC -32000 arrives but the transport is still live', async () => {
    const manager = buildManager()

    await manager.handleSettingsUpdate({
      mcp: { servers: [stdioServerConfig()], builtinToolOptions: {} },
      webSearch: {
        providers: [],
        defaultProviderId: undefined,
        common: {
          resultSize: 8,
          searchTimeoutMs: 15000,
          scrapeTimeoutMs: 20000,
        },
      },
    } as never)

    const firstClient = fakeClientInstances[0]
    // Transport stays defined — the error is a regular server-error response.
    expect(firstClient.transport).not.toBeUndefined()
    const serverError = Object.assign(new Error('upstream blew up'), {
      code: -32000,
    })
    firstClient.callToolMock.mockRejectedValue(serverError)

    const result = await manager.callTool({
      name: 'demo__some_tool',
      args: {},
    })

    expect(result).toMatchObject({
      status: ToolCallResponseStatus.Error,
    })

    await flush()
    await flush()

    // No reconnect: still the single original client, still Connected.
    expect(fakeClientInstances).toHaveLength(1)
    const state = connectedServer(manager, 'demo')
    expect(state.client).toBe(firstClient)
  })
})
