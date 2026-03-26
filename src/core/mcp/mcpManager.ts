import isEqual from 'lodash.isequal'
import { App, Platform } from 'obsidian'

import { SmartComposerSettings } from '../../settings/schema/setting.types'
import type { ApplyViewState } from '../../types/apply-view.types'
import {
  McpServerConfig,
  McpServerState,
  McpServerStatus,
  McpTool,
  McpToolCallResult,
} from '../../types/mcp.types'
import {
  ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import {} from '../../utils/chat/tool-arguments'

import { InvalidToolNameException, McpNotAvailableException } from './exception'
import {
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  callLocalFileTool,
  getLocalFileToolServerName,
  getLocalFileTools,
  parseLocalFsActionFromToolArgs,
} from './localFileTools'

const LOCAL_FS_SPLIT_TOOL_NAME_SET = new Set<string>(
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
)
const LOCAL_MEMORY_SPLIT_TOOL_NAME_SET = new Set<string>(
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
)
import {
  getToolName,
  parseToolName,
  validateServerName,
} from './tool-name-utils'
import {
  createMcpRemoteTransportError,
  createMcpRemoteTransportFactory,
  getMcpRemoteTransportContext,
  getMcpRemoteTransportDiagnostics,
} from './remoteTransport'

export const INVALID_TOOL_ARGUMENTS_JSON_ERROR =
  'Tool arguments must be valid JSON. Please escape quotes/newlines inside string values and retry.'

export class McpManager {
  static readonly TOOL_NAME_DELIMITER = '__' // Delimiter for tool name construction (serverName__toolName)

  public readonly disabled = !Platform.isDesktop // MCP should be disabled on mobile since it doesn't support node.js

  private readonly app: App
  private readonly openApplyReview: (state: ApplyViewState) => Promise<boolean>
  private settings: SmartComposerSettings
  private unsubscribeFromSettings: () => void
  private defaultEnv: Record<string, string>
  private remoteTransportFactory: ReturnType<
    typeof createMcpRemoteTransportFactory
  > | null = null

  private servers: McpServerState[] = [] // IMPORTANT: Always use this.updateServers() to update this array
  private activeToolCalls: Map<string, AbortController> = new Map()
  private allowedToolsByConversation: Map<string, Set<string>> = new Map()
  private subscribers = new Set<(servers: McpServerState[]) => void>()

  private availableToolsCache: Map<string, McpTool[]> = new Map()

  private buildExecutionAllowanceKey({
    requestToolName,
    requestArgs,
  }: {
    requestToolName: string
    requestArgs?: Record<string, unknown>
  }): string {
    try {
      const { serverName, toolName } = parseToolName(requestToolName)
      const action =
        serverName === getLocalFileToolServerName()
          ? parseLocalFsActionFromToolArgs({ toolName, args: requestArgs })
          : null
      if (serverName === getLocalFileToolServerName() && action) {
        return `${requestToolName}::${action}`
      }
    } catch {
      // ignore and fallback to tool-name-level key
    }
    return requestToolName
  }

  private isLocalToolEnabled(toolName: string): boolean {
    const directDisabled =
      this.settings.mcp.builtinToolOptions[toolName]?.disabled
    if (typeof directDisabled === 'boolean') {
      return !directDisabled
    }
    if (LOCAL_FS_SPLIT_TOOL_NAME_SET.has(toolName)) {
      const splitToolDisabled =
        this.settings.mcp.builtinToolOptions[toolName]?.disabled ?? false
      const groupedFileOpsDisabled =
        this.settings.mcp.builtinToolOptions.fs_file_ops?.disabled ?? false
      return !(splitToolDisabled || groupedFileOpsDisabled)
    }
    if (LOCAL_MEMORY_SPLIT_TOOL_NAME_SET.has(toolName)) {
      const splitToolDisabled =
        this.settings.mcp.builtinToolOptions[toolName]?.disabled ?? false
      const groupedMemoryOpsDisabled =
        this.settings.mcp.builtinToolOptions.memory_ops?.disabled ?? false
      return !(splitToolDisabled || groupedMemoryOpsDisabled)
    }
    return true
  }

  constructor({
    app,
    settings,
    openApplyReview,
    registerSettingsListener,
  }: {
    app: App
    settings: SmartComposerSettings
    openApplyReview: (state: ApplyViewState) => Promise<boolean>
    registerSettingsListener: (
      listener: (settings: SmartComposerSettings) => void,
    ) => () => void
  }) {
    this.app = app
    this.openApplyReview = openApplyReview
    this.settings = settings
    this.unsubscribeFromSettings = registerSettingsListener((newSettings) => {
      void this.handleSettingsUpdate(newSettings).catch((error) => {
        console.error('[YOLO] Failed to handle MCP settings update:', error)
      })
    })
  }

  public async initialize() {
    if (this.disabled) {
      return
    }

    // Get default environment variables
    const { shellEnvSync } = await import('shell-env')
    this.defaultEnv = shellEnvSync()
    this.remoteTransportFactory = createMcpRemoteTransportFactory({
      env: this.defaultEnv,
    })

    // Create MCP servers
    const servers = await Promise.all(
      this.settings.mcp.servers.map((serverConfig) =>
        this.connectServer(serverConfig),
      ),
    )
    this.updateServers(servers)
  }

  public cleanup() {
    // Disconnect all clients
    void Promise.all(
      this.servers
        .filter((s) => s.status === McpServerStatus.Connected)
        .map((s) => s.client.close()),
    )

    if (this.unsubscribeFromSettings) {
      this.unsubscribeFromSettings()
    }

    this.servers = []
    this.remoteTransportFactory = null
    this.subscribers.clear()
    this.activeToolCalls.clear()
  }

  public getServers() {
    return this.servers
  }

  public subscribeServersChange(callback: (servers: McpServerState[]) => void) {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  public async handleSettingsUpdate(settings: SmartComposerSettings) {
    this.settings = settings
    const updatedServers = settings.mcp.servers.map(
      (serverConfig: McpServerConfig): McpServerState => {
        const existingServer = this.servers.find(
          (s) => s.name === serverConfig.id,
        )
        if (
          existingServer &&
          isEqual(existingServer.config.parameters, serverConfig.parameters) &&
          existingServer.config.enabled === serverConfig.enabled
        ) {
          // Server is already up to date
          return {
            ...existingServer,
            config: serverConfig,
          }
        }
        return {
          name: serverConfig.id,
          config: serverConfig,
          status: McpServerStatus.Connecting,
        }
      },
    )

    this.updateServers(updatedServers)

    await Promise.all(
      updatedServers
        .filter((s) => s.status === McpServerStatus.Connecting)
        .map(async (s) => {
          const server = await this.connectServer(s.config)
          this.updateServers((prevServers) =>
            prevServers.map((prevServer) =>
              prevServer.name === server.name ? server : prevServer,
            ),
          )
        }),
    )
  }

  private notifySubscribers() {
    for (const cb of this.subscribers) cb(this.servers)
  }

  private updateServers(
    newServersOrUpdater?:
      | McpServerState[]
      | ((prevServers: McpServerState[]) => McpServerState[]),
  ) {
    const currentServers = this.servers
    const nextServers =
      typeof newServersOrUpdater === 'function'
        ? newServersOrUpdater(currentServers)
        : (newServersOrUpdater ?? currentServers)

    // Find clients that need to be disconnected
    const clientsToDisconnect = currentServers
      .filter((server) => server.status === McpServerStatus.Connected)
      .map((server) => server.client)
      .filter(
        (client) =>
          !nextServers.some(
            (server) =>
              server.status === McpServerStatus.Connected &&
              server.client === client,
          ),
      )

    // Disconnect clients in the background
    if (clientsToDisconnect.length > 0) {
      void Promise.all(clientsToDisconnect.map((client) => client.close()))
    }

    this.servers = nextServers
    this.availableToolsCache.clear() // Invalidate available tools cache
    this.notifySubscribers() // Should call after invalidating the cache
  }

  private async connectServer(
    serverConfig: McpServerConfig,
  ): Promise<McpServerState> {
    if (this.disabled) {
      throw new McpNotAvailableException()
    }

    const { id: name, parameters: serverParams, enabled } = serverConfig

    if (!enabled) {
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Disconnected,
      }
    }

    try {
      validateServerName(name)
    } catch (error) {
      console.error(`[YOLO] Invalid MCP server name "${name}":`, error)
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Error,
        error: error as Error,
      }
    }

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const client = new Client({ name, version: '1.0.0' })

    try {
      const transport = await this.createClientTransport(serverParams)
      await client.connect(transport)
    } catch (error) {
      const remoteTransportContext = getMcpRemoteTransportContext(serverParams)
      console.error(
        `[YOLO] Failed to connect to MCP server "${name}":`,
        remoteTransportContext
          ? getMcpRemoteTransportDiagnostics(remoteTransportContext)
          : { transport: serverParams.transport },
        error,
      )
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Error,
        error: remoteTransportContext
          ? createMcpRemoteTransportError({
              serverName: name,
              action: 'connect',
              context: remoteTransportContext,
              error,
            })
          : new Error(
              `Failed to connect to MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`,
            ),
      }
    }

    try {
      const toolList = await client.listTools()
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Connected,
        client,
        tools: toolList.tools,
      }
    } catch (error) {
      const remoteTransportContext = getMcpRemoteTransportContext(serverParams)
      console.error(
        `[YOLO] Failed to list tools for MCP server "${name}":`,
        remoteTransportContext
          ? getMcpRemoteTransportDiagnostics(remoteTransportContext)
          : { transport: serverParams.transport },
        error,
      )
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Error,
        error: remoteTransportContext
          ? createMcpRemoteTransportError({
              serverName: name,
              action: 'list tools',
              context: remoteTransportContext,
              error,
            })
          : new Error(
              `Failed to list tools for MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`,
            ),
      }
    }
  }

  private async createClientTransport(
    serverParams: McpServerConfig['parameters'],
  ) {
    switch (serverParams.transport) {
      case 'stdio': {
        const { StdioClientTransport } = await import(
          '@modelcontextprotocol/sdk/client/stdio.js'
        )
        return new StdioClientTransport({
          command: serverParams.command,
          args: serverParams.args,
          cwd: serverParams.cwd,
          env: {
            ...this.defaultEnv,
            ...(serverParams.env ?? {}),
          },
        })
      }
      case 'http': {
        const { StreamableHTTPClientTransport } = await import(
          '@modelcontextprotocol/sdk/client/streamableHttp.js'
        )
        const remoteTransportFactory =
          this.remoteTransportFactory ??
          createMcpRemoteTransportFactory({
            env: this.defaultEnv ?? {},
          })
        return new StreamableHTTPClientTransport(new URL(serverParams.url), {
          ...remoteTransportFactory.createHttpOptions(serverParams),
        })
      }
      case 'sse': {
        const { SSEClientTransport } = await import(
          '@modelcontextprotocol/sdk/client/sse.js'
        )
        const remoteTransportFactory =
          this.remoteTransportFactory ??
          createMcpRemoteTransportFactory({
            env: this.defaultEnv ?? {},
          })
        return new SSEClientTransport(new URL(serverParams.url), {
          ...remoteTransportFactory.createSseOptions(serverParams),
        })
      }
      case 'ws': {
        const { WebSocketClientTransport } = await import(
          '@modelcontextprotocol/sdk/client/websocket.js'
        )
        return new WebSocketClientTransport(new URL(serverParams.url))
      }
      default: {
        const exhaustiveCheck: never = serverParams
        throw new Error(
          `Unsupported MCP transport: ${JSON.stringify(exhaustiveCheck)}`,
        )
      }
    }
  }

  private getAvailableToolsCacheKey(includeBuiltinTools: boolean): string {
    return includeBuiltinTools ? 'with_builtin' : 'mcp_only'
  }

  public async listAvailableTools({
    includeBuiltinTools = false,
  }: {
    includeBuiltinTools?: boolean
  } = {}): Promise<McpTool[]> {
    if (this.disabled) {
      return []
    }

    const cacheKey = this.getAvailableToolsCacheKey(includeBuiltinTools)
    const cached = this.availableToolsCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const availableTools = (
      await Promise.all(
        this.servers.map(async (server): Promise<McpTool[]> => {
          if (server.status !== McpServerStatus.Connected) {
            return []
          }
          try {
            const toolList = await server.client.listTools()
            return toolList.tools
              .filter((tool) => !server.config.toolOptions[tool.name]?.disabled)
              .map((tool) => ({
                ...tool,
                name: getToolName(server.name, tool.name),
              }))
          } catch (error) {
            console.error(
              `Failed to list tools for MCP server ${server.name}: ${error instanceof Error ? error.message : String(error)}`,
            )
            return []
          }
        }),
      )
    ).flat()

    const nextTools = includeBuiltinTools
      ? [
          ...availableTools,
          ...getLocalFileTools()
            .filter((tool) => this.isLocalToolEnabled(tool.name))
            .map((tool) => ({
              ...tool,
              name: getToolName(getLocalFileToolServerName(), tool.name),
            })),
        ]
      : availableTools

    this.availableToolsCache.set(cacheKey, [...nextTools])
    return nextTools
  }

  public allowToolForConversation(
    requestToolName: string,
    conversationId: string,
    requestArgs?: Record<string, unknown>,
  ): void {
    let allowedTools = this.allowedToolsByConversation.get(conversationId)
    if (!allowedTools) {
      allowedTools = new Set<string>()
      this.allowedToolsByConversation.set(conversationId, allowedTools)
    }
    const allowanceKey = this.buildExecutionAllowanceKey({
      requestToolName,
      requestArgs,
    })
    allowedTools.add(allowanceKey)
  }

  public isToolExecutionAllowed({
    requestToolName,
    conversationId,
    requestArgs,
    requireAutoExecution = false,
  }: {
    requestToolName: string
    conversationId?: string
    requestArgs?: Record<string, unknown>
    requireAutoExecution?: boolean
  }): boolean {
    try {
      const { serverName, toolName } = parseToolName(requestToolName)
      if (serverName === getLocalFileToolServerName()) {
        if (!this.isLocalToolEnabled(toolName)) {
          return false
        }
      } else {
        const server = this.servers.find((server) => server.name === serverName)
        if (!server) {
          return false
        }
        const toolOption = server.config.toolOptions[toolName]
        if (toolOption?.disabled ?? false) {
          return false
        }
      }

      if (!conversationId) {
        return requireAutoExecution
      }

      const allowanceKey = this.buildExecutionAllowanceKey({
        requestToolName,
        requestArgs,
      })
      if (
        this.allowedToolsByConversation.get(conversationId)?.has(allowanceKey)
      ) {
        return true
      }

      return requireAutoExecution
    } catch (error) {
      if (error instanceof InvalidToolNameException) {
        return false
      }
      throw error
    }
  }

  public async callTool({
    name,
    args,
    id,
    signal,
    requireReview = false,
  }: {
    name: string
    args?: Record<string, unknown> | undefined
    id?: string
    signal?: AbortSignal
    requireReview?: boolean
  }): Promise<ToolCallResponse> {
    if (this.disabled) {
      throw new McpNotAvailableException()
    }

    const toolAbortController = new AbortController()
    if (id !== undefined) {
      const existingAbortController = this.activeToolCalls.get(id)
      if (existingAbortController) {
        existingAbortController.abort()
      }
      this.activeToolCalls.set(id, toolAbortController)
    }
    const compositeSignal = toolAbortController.signal
    if (signal) {
      signal.addEventListener('abort', () => toolAbortController.abort())
    }

    try {
      const { serverName, toolName } = parseToolName(name)
      const parsedArgs: Record<string, unknown> | undefined = args

      if (serverName === getLocalFileToolServerName()) {
        if (!this.isLocalToolEnabled(toolName)) {
          throw new Error(`Built-in tool ${toolName} is disabled`)
        }
        const localResult = await callLocalFileTool({
          app: this.app,
          settings: this.settings,
          openApplyReview: this.openApplyReview,
          toolName,
          args: parsedArgs ?? {},
          requireReview,
          signal: compositeSignal,
        })
        if (localResult.status === ToolCallResponseStatus.Success) {
          return {
            status: ToolCallResponseStatus.Success,
            data: {
              type: 'text',
              text: localResult.text,
            },
          }
        }
        if (localResult.status === ToolCallResponseStatus.Aborted) {
          return {
            status: ToolCallResponseStatus.Aborted,
          }
        }
        if (localResult.status === ToolCallResponseStatus.Rejected) {
          return {
            status: ToolCallResponseStatus.Rejected,
          }
        }
        return {
          status: ToolCallResponseStatus.Error,
          error: localResult.error,
        }
      }

      const server = this.servers.find((server) => server.name === serverName)
      if (!server) {
        throw new Error(`MCP server ${serverName} not found`)
      }
      if (server.status !== McpServerStatus.Connected) {
        throw new Error(`MCP server ${serverName} is not connected`)
      }
      const { client } = server

      const result = (await client.callTool(
        {
          name: toolName,
          arguments: parsedArgs,
        },
        undefined,
        {
          signal: compositeSignal,
        },
      )) as McpToolCallResult

      if (result.content.length === 0) {
        throw new Error('Tool call returned no content')
      }
      if (result.content[0].type !== 'text') {
        throw new Error(
          `Tool result with content type ${result.content[0].type} is not currently supported.`,
        )
      }
      if (result.isError) {
        return {
          status: ToolCallResponseStatus.Error,
          error: result.content[0].text,
        }
      }
      return {
        status: ToolCallResponseStatus.Success,
        data: {
          type: 'text',
          text: result.content[0].text,
        },
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return {
          status: ToolCallResponseStatus.Aborted,
        }
      }

      // Handle other errors
      return {
        status: ToolCallResponseStatus.Error,
        error:
          error instanceof Error ? error.message : 'Unknown error occurred',
      }
    } finally {
      if (id !== undefined) {
        this.activeToolCalls.delete(id)
      }
    }
  }

  public abortToolCall(id: string): boolean {
    if (this.disabled) {
      return false
    }
    const toolAbortController = this.activeToolCalls.get(id)
    if (toolAbortController) {
      toolAbortController.abort()
      this.activeToolCalls.delete(id)
      return true
    }
    return false
  }
}
