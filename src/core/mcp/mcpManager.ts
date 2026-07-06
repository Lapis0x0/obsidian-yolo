import isEqual from 'lodash.isequal'
import { App, FileSystemAdapter, Platform } from 'obsidian'

import { YoloSettings } from '../../settings/schema/setting.types'
import type { ApplyViewState } from '../../types/apply-view.types'
import type { AssistantWorkspaceScope } from '../../types/assistant.types'
import type { ChatMessage } from '../../types/chat'
import type { ChatModelModality } from '../../types/chat-model.types'
import {
  McpClient,
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
import { WEB_OPS_GROUP_TOOL_NAME } from '../agent/builtinToolUiMeta'
import type { PromptSourceWatcher } from '../agent/promptSourceWatcher'
import type { SubagentParentContext } from '../agent/subagent/parent-context'
import type { AgentRunContext } from '../agent/types'
import type { RAGEngine } from '../rag/ragEngine'
import {
  WEB_SCRAPE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  isWebSearchToolReady,
} from '../web-search'

import { InvalidToolNameException, McpNotAvailableException } from './exception'
import {
  type JsSandboxSettings,
  getJsSandboxSettings,
} from './jsSandboxSettings'
import { disposeJsSandbox } from './jsSandboxTool'
// eslint-disable-next-line import/order -- false positive: sibling group is contiguous; rule miscounts the blank line above this group
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
import type { McpRemoteTransportBackend } from './remoteTransport'
import {
  getToolName,
  parseToolName,
  validateServerName,
} from './tool-name-utils'

type RemoteTransportModule = typeof import('./remoteTransport')

const getVaultBasePath = (app: App): string | undefined => {
  const adapter = app.vault.adapter
  return adapter instanceof FileSystemAdapter
    ? adapter.getBasePath()
    : undefined
}

export const INVALID_TOOL_ARGUMENTS_JSON_ERROR =
  'Tool arguments must be valid JSON. Please escape quotes/newlines inside string values and retry.'

const MCP_CONNECTION_CLOSED_CODE = -32000
const RECONNECT_WINDOW_MS = 60_000
const RECONNECT_MAX_ATTEMPTS = 3

export class McpManager {
  static readonly TOOL_NAME_DELIMITER = '__' // Delimiter for tool name construction (serverName__toolName)

  public readonly remoteMcpDisabled = !Platform.isDesktop // Remote MCP should be disabled on mobile since it doesn't support node.js

  private readonly app: App
  private readonly openApplyReview: (state: ApplyViewState) => Promise<boolean>
  private readonly getRagEngine?: () => Promise<RAGEngine>
  private readonly promptSourceWatcher?: PromptSourceWatcher
  private settings: YoloSettings
  private unsubscribeFromSettings: () => void
  private defaultEnv: Record<string, string>
  private remoteTransportFactory: ReturnType<
    RemoteTransportModule['createMcpRemoteTransportFactory']
  > | null = null
  private remoteTransportModulePromise: Promise<RemoteTransportModule> | null =
    null

  private servers: McpServerState[] = [] // IMPORTANT: Always use this.updateServers() to update this array
  private connectionAborts: Map<string, AbortController> = new Map()
  private activeToolCalls: Map<string, AbortController> = new Map()
  // Track clients we close on purpose so the onclose-driven self-heal path can
  // distinguish intentional teardown from server-side connection loss.
  private intentionalClientCloses: WeakSet<McpClient> = new WeakSet()
  // Rolling-window reconnect throttle keyed by server name.
  private reconnectAttempts: Map<
    string,
    { count: number; windowStart: number }
  > = new Map()
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
    // Web tools share a single `web_ops` group switch. `web_search` needs a
    // configured provider, while `web_scrape` can fall back to the generic
    // static-HTML scraper when no provider is configured.
    if (
      toolName === WEB_SEARCH_TOOL_NAME ||
      toolName === WEB_SCRAPE_TOOL_NAME
    ) {
      const groupDisabled =
        this.settings.mcp.builtinToolOptions[WEB_OPS_GROUP_TOOL_NAME]
          ?.disabled ?? false
      const splitToolDisabled =
        this.settings.mcp.builtinToolOptions[toolName]?.disabled ?? false
      if (groupDisabled || splitToolDisabled) return false
      if (
        toolName === WEB_SEARCH_TOOL_NAME &&
        !isWebSearchToolReady(this.settings.webSearch)
      ) {
        return false
      }
      return true
    }
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
    getRagEngine,
    promptSourceWatcher,
  }: {
    app: App
    settings: YoloSettings
    openApplyReview: (state: ApplyViewState) => Promise<boolean>
    registerSettingsListener: (
      listener: (settings: YoloSettings) => void,
    ) => () => void
    getRagEngine?: () => Promise<RAGEngine>
    promptSourceWatcher?: PromptSourceWatcher
  }) {
    this.app = app
    this.openApplyReview = openApplyReview
    this.getRagEngine = getRagEngine
    this.promptSourceWatcher = promptSourceWatcher
    this.settings = settings
    this.unsubscribeFromSettings = registerSettingsListener((newSettings) => {
      void this.handleSettingsUpdate(newSettings).catch((error) => {
        console.error('[YOLO] Failed to handle MCP settings update:', error)
      })
    })
  }

  public async initialize() {
    if (this.remoteMcpDisabled) {
      return
    }

    // Get default environment variables
    const { shellEnvSync } = await import('shell-env')
    this.defaultEnv = shellEnvSync()
    const remoteTransport = await this.loadRemoteTransportModule()
    this.remoteTransportFactory =
      remoteTransport.createMcpRemoteTransportFactory({
        env: this.defaultEnv,
      })

    // Connect via the shared settings-update path so initial probes also
    // participate in the per-server abort/discard model. Without this, a
    // toggle-off during startup could be clobbered by the initial probe
    // resolving with the stale enabled:true config.
    await this.handleSettingsUpdate(this.settings)
  }

  public cleanup() {
    // Cancel any in-flight connection attempts so their late results don't
    // try to mutate this manager after teardown.
    for (const controller of this.connectionAborts.values()) {
      controller.abort()
    }
    this.connectionAborts.clear()

    // Disconnect all clients
    void Promise.all(
      this.servers
        .filter((s) => s.status === McpServerStatus.Connected)
        .map((s) => this.closeClient(s.client)),
    )

    if (this.unsubscribeFromSettings) {
      this.unsubscribeFromSettings()
    }

    this.servers = []
    this.remoteTransportFactory = null
    this.remoteTransportModulePromise = null
    this.subscribers.clear()
    this.activeToolCalls.clear()
    this.reconnectAttempts.clear()
    disposeJsSandbox()
  }

  private loadRemoteTransportModule(): Promise<RemoteTransportModule> {
    if (!this.remoteTransportModulePromise) {
      this.remoteTransportModulePromise = import('./remoteTransport')
    }

    return this.remoteTransportModulePromise
  }

  public getServers() {
    return this.servers
  }

  /**
   * Snapshot of the global JS sandbox configuration. Exposed so the agent
   * runtime, tool gateway, and context estimators can read the same source
   * the proxy handler uses at execution time — keeping the LLM-facing
   * description and actual capability set in lockstep.
   */
  public getJsSandboxSettings(): JsSandboxSettings {
    return getJsSandboxSettings(this.settings)
  }

  public getSettingsSnapshot(): YoloSettings {
    return this.settings
  }

  public subscribeServersChange(callback: (servers: McpServerState[]) => void) {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  public async handleSettingsUpdate(settings: YoloSettings) {
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
        // Any user-driven change (toggle / parameter edit) resets the
        // auto-reconnect throttle so a fresh window starts.
        this.reconnectAttempts.delete(serverConfig.id)
        // Disabled servers don't probe — emit Disconnected directly so the UI
        // doesn't briefly flash Connecting before settling.
        if (!serverConfig.enabled) {
          return {
            name: serverConfig.id,
            config: serverConfig,
            status: McpServerStatus.Disconnected,
          }
        }
        return {
          name: serverConfig.id,
          config: serverConfig,
          status: McpServerStatus.Connecting,
        }
      },
    )

    // Servers removed from settings entirely should also drop their throttle
    // state so a future re-add starts clean.
    const nextNames = new Set(updatedServers.map((s) => s.name))
    for (const name of Array.from(this.reconnectAttempts.keys())) {
      if (!nextNames.has(name)) {
        this.reconnectAttempts.delete(name)
      }
    }

    // Cancel in-flight attempts for servers that won't probe in this round —
    // either removed from settings entirely, or kept but no longer Connecting
    // (e.g. just disabled, or unchanged and reused). The Promise.all below
    // only registers controllers for Connecting entries, so anything else
    // must release its previous controller here.
    const stillProbing = new Set(
      updatedServers
        .filter((s) => s.status === McpServerStatus.Connecting)
        .map((s) => s.name),
    )
    for (const [name, controller] of this.connectionAborts) {
      if (!stillProbing.has(name)) {
        controller.abort()
        this.connectionAborts.delete(name)
      }
    }

    this.updateServers(updatedServers)

    await Promise.all(
      updatedServers
        .filter((s) => s.status === McpServerStatus.Connecting)
        .map(async (s) => {
          // Supersede any in-flight attempt for this server. Whatever it ends
          // up returning will be discarded by the signal check below.
          this.connectionAborts.get(s.name)?.abort()
          const controller = new AbortController()
          this.connectionAborts.set(s.name, controller)

          const server = await this.connectServer(s.config, controller.signal)

          if (controller.signal.aborted) {
            // A newer settings update (or cleanup) has invalidated this attempt.
            // If we managed to connect anyway, close the orphan client.
            if (server.status === McpServerStatus.Connected) {
              void this.closeClient(server.client)
            }
            return
          }

          // Only clear the map entry if we are still the current attempt.
          if (this.connectionAborts.get(s.name) === controller) {
            this.connectionAborts.delete(s.name)
          }

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
      void Promise.all(
        clientsToDisconnect.map((client) => this.closeClient(client)),
      )
    }

    this.servers = nextServers
    this.availableToolsCache.clear() // Invalidate available tools cache
    this.notifySubscribers() // Should call after invalidating the cache
  }

  private async connectServer(
    serverConfig: McpServerConfig,
    signal?: AbortSignal,
  ): Promise<McpServerState> {
    if (this.remoteMcpDisabled) {
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
    const createClient = () => {
      const nextClient = new Client({ name, version: '1.0.0' })

      // Self-heal hook: fires when the underlying transport closes for any
      // reason (including our own close() calls). The intentional-closes
      // WeakSet inside the handler short-circuits planned teardowns.
      nextClient.onclose = () => {
        this.handleUnexpectedServerClose(name, nextClient)
      }

      return nextClient
    }
    let client = createClient()

    // The SDK only forwards `signal` to the initialize request, not to
    // `transport.start()`. Bind an abort listener that force-closes the client
    // so SSE/WS handshakes and stdio spawns are torn down promptly.
    const abortListener = () => {
      void this.closeClient(client).catch(() => {
        /* best-effort teardown */
      })
    }
    signal?.addEventListener('abort', abortListener, { once: true })

    // The dynamic import above is awaited, so `signal` may already have aborted
    // before the listener was attached. Bail out before opening a transport.
    if (signal?.aborted) {
      signal.removeEventListener('abort', abortListener)
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Disconnected,
      }
    }

    let remoteTransportBackend: McpRemoteTransportBackend = 'chromium-fetch'

    try {
      const transport = await this.createClientTransport(serverParams, {
        httpBackend: remoteTransportBackend,
      })
      await client.connect(transport, signal ? { signal } : undefined)
    } catch (error) {
      const remoteTransport = await this.loadRemoteTransportModule()
      const remoteTransportContext =
        remoteTransport.getMcpRemoteTransportContext(
          serverParams,
          remoteTransportBackend,
        )

      if (
        !signal?.aborted &&
        remoteTransport.shouldRetryMcpHttpWithJsonBackend({
          params: serverParams,
          error,
        })
      ) {
        console.warn(
          `[YOLO] MCP server "${name}" HTTP connection failed with Chromium fetch; retrying with Obsidian requestUrl JSON backend.`,
          error,
        )
        await this.closeClient(client).catch(() => {
          /* best-effort teardown */
        })
        client = createClient()
        remoteTransportBackend = 'obsidian-request-url-json'

        try {
          const transport = await this.createClientTransport(serverParams, {
            httpBackend: remoteTransportBackend,
          })
          await client.connect(transport, signal ? { signal } : undefined)
        } catch (fallbackError) {
          signal?.removeEventListener('abort', abortListener)
          const fallbackRemoteTransportContext =
            remoteTransport.getMcpRemoteTransportContext(
              serverParams,
              remoteTransportBackend,
            )
          console.error(
            `[YOLO] Failed to connect to MCP server "${name}" with Obsidian requestUrl JSON backend:`,
            fallbackRemoteTransportContext
              ? remoteTransport.getMcpRemoteTransportDiagnostics(
                  fallbackRemoteTransportContext,
                )
              : { transport: serverParams.transport },
            fallbackError,
          )
          return {
            name,
            config: serverConfig,
            status: McpServerStatus.Error,
            error: fallbackRemoteTransportContext
              ? remoteTransport.createMcpRemoteTransportError({
                  serverName: name,
                  action: 'connect',
                  context: fallbackRemoteTransportContext,
                  error: fallbackError,
                })
              : new Error(
                  `Failed to connect to MCP server ${name}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
                ),
          }
        }
      } else {
        signal?.removeEventListener('abort', abortListener)
        console.error(
          `[YOLO] Failed to connect to MCP server "${name}":`,
          remoteTransportContext
            ? remoteTransport.getMcpRemoteTransportDiagnostics(
                remoteTransportContext,
              )
            : { transport: serverParams.transport },
          error,
        )
        return {
          name,
          config: serverConfig,
          status: McpServerStatus.Error,
          error: remoteTransportContext
            ? remoteTransport.createMcpRemoteTransportError({
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
    }

    try {
      const toolList = await client.listTools(
        {},
        signal ? { signal } : undefined,
      )
      signal?.removeEventListener('abort', abortListener)
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Connected,
        client,
        tools: toolList.tools,
      }
    } catch (error) {
      signal?.removeEventListener('abort', abortListener)
      // The connect step succeeded, so the transport is live. The Error state
      // we return below has no `client` field, which means updateServers()'s
      // diff cannot reach it — close it here to avoid leaking the transport.
      void this.closeClient(client).catch(() => {
        /* best-effort teardown */
      })
      const remoteTransport = await this.loadRemoteTransportModule()
      const remoteTransportContext =
        remoteTransport.getMcpRemoteTransportContext(
          serverParams,
          remoteTransportBackend,
        )
      console.error(
        `[YOLO] Failed to list tools for MCP server "${name}":`,
        remoteTransportContext
          ? remoteTransport.getMcpRemoteTransportDiagnostics(
              remoteTransportContext,
            )
          : { transport: serverParams.transport },
        error,
      )
      return {
        name,
        config: serverConfig,
        status: McpServerStatus.Error,
        error: remoteTransportContext
          ? remoteTransport.createMcpRemoteTransportError({
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
    options: { httpBackend?: McpRemoteTransportBackend } = {},
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
        const remoteTransport = await this.loadRemoteTransportModule()
        const remoteTransportFactory =
          this.remoteTransportFactory ??
          remoteTransport.createMcpRemoteTransportFactory({
            env: this.defaultEnv ?? {},
          })
        return new StreamableHTTPClientTransport(new URL(serverParams.url), {
          ...remoteTransportFactory.createHttpOptions(
            serverParams,
            options.httpBackend,
          ),
        })
      }
      case 'sse': {
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- SSEClientTransport is deprecated but still required for legacy SSE servers during MCP migration period
        const { SSEClientTransport } = await import(
          '@modelcontextprotocol/sdk/client/sse.js'
        )
        const remoteTransport = await this.loadRemoteTransportModule()
        const remoteTransportFactory =
          this.remoteTransportFactory ??
          remoteTransport.createMcpRemoteTransportFactory({
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

  private getAvailableToolsCacheKey(
    includeBuiltinTools: boolean,
    chatModelModalities: ChatModelModality[] | undefined,
  ): string {
    // Modalities are part of the cache key because built-in tool schemas
    // (notably fs_read) are tailored per-model. Sort to be stable across the
    // few call sites that may pass them in different order.
    const modalityFingerprint = chatModelModalities
      ? [...chatModelModalities].sort().join(',')
      : 'superset'
    return `${includeBuiltinTools ? 'with_builtin' : 'mcp_only'}|${modalityFingerprint}`
  }

  public async listAvailableTools({
    includeBuiltinTools = false,
    chatModelModalities,
  }: {
    includeBuiltinTools?: boolean
    chatModelModalities?: ChatModelModality[]
  } = {}): Promise<McpTool[]> {
    const cacheKey = this.getAvailableToolsCacheKey(
      includeBuiltinTools,
      chatModelModalities,
    )
    const cached = this.availableToolsCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const availableTools = this.remoteMcpDisabled
      ? []
      : (
          await Promise.all(
            this.servers.map(async (server): Promise<McpTool[]> => {
              if (server.status !== McpServerStatus.Connected) {
                return []
              }
              try {
                const toolList = await server.client.listTools({})
                return toolList.tools
                  .filter(
                    (tool) => !server.config.toolOptions[tool.name]?.disabled,
                  )
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
          ...getLocalFileTools({
            vaultBasePath: getVaultBasePath(this.app),
            chatModelModalities,
          })
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
    allowedTools.add(requestToolName)
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
        this.allowedToolsByConversation
          .get(conversationId)
          ?.has(allowanceKey) ||
        this.allowedToolsByConversation
          .get(conversationId)
          ?.has(requestToolName)
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
    conversationId,
    roundId,
    conversationMessages,
    signal,
    requireReview = false,
    chatModelId,
    workspaceScope,
    allowedSkillPaths,
    subagentParentContext,
    runContext,
  }: {
    name: string
    args?: Record<string, unknown> | undefined
    id?: string
    conversationId?: string
    roundId?: string
    conversationMessages?: ChatMessage[]
    signal?: AbortSignal
    requireReview?: boolean
    chatModelId?: string
    workspaceScope?: AssistantWorkspaceScope
    allowedSkillPaths?: readonly string[]
    runContext?: AgentRunContext
    subagentParentContext?: SubagentParentContext
  }): Promise<ToolCallResponse> {
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

    // Hoisted so the catch branch can route ConnectionClosed errors back to
    // the right server for self-healing.
    let remoteServerName: string | undefined
    let remoteClient: McpClient | undefined

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
          getRagEngine: this.getRagEngine,
          conversationId,
          conversationMessages,
          roundId,
          toolCallId: id,
          toolName,
          args: parsedArgs ?? {},
          requireReview,
          signal: compositeSignal,
          chatModelId,
          workspaceScope,
          allowedSkillPaths,
          runContext,
          subagentParentContext,
          promptSourceWatcher: this.promptSourceWatcher,
        })
        if (localResult.status === ToolCallResponseStatus.Success) {
          return {
            status: ToolCallResponseStatus.Success,
            data: {
              type: 'text',
              text: localResult.text,
              contentParts: localResult.contentParts,
              metadata: localResult.metadata,
            },
          }
        }
        if (localResult.status === ToolCallResponseStatus.Aborted) {
          return {
            status: ToolCallResponseStatus.Aborted,
            // 透传中断时已采集的部分输出（外部 CLI 等场景）
            ...(localResult.data !== undefined && { data: localResult.data }),
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

      if (this.remoteMcpDisabled) {
        throw new McpNotAvailableException()
      }

      const server = this.servers.find((server) => server.name === serverName)
      if (!server) {
        throw new Error(`MCP server ${serverName} not found`)
      }
      if (server.status !== McpServerStatus.Connected) {
        throw new Error(`MCP server ${serverName} is not connected`)
      }
      const { client } = server
      remoteServerName = serverName
      remoteClient = client

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
      // Prefer signal state over error inspection: SDK packages signal-driven
      // cancellation as McpError(-32001 RequestTimeout), which wouldn't match
      // a name-based `AbortError` check.
      if (compositeSignal.aborted) {
        return {
          status: ToolCallResponseStatus.Aborted,
        }
      }

      // Self-heal fallback: if the SDK reported the transport is closed,
      // schedule a reconnect for that server. We still return Error for this
      // call — MCP tools may have side effects, so we don't transparently
      // replay the request.
      // JSON-RPC error code -32000 is broadly reserved for "server error" and
      // can be returned by well-behaved servers, so we additionally require
      // that the client's transport is actually gone (SDK clears it in
      // `_onclose`) before treating this as a connection loss.
      if (
        this.getMcpErrorCode(error) === MCP_CONNECTION_CLOSED_CODE &&
        remoteServerName &&
        remoteClient &&
        remoteClient.transport === undefined
      ) {
        this.handleUnexpectedServerClose(remoteServerName, remoteClient)
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
    const toolAbortController = this.activeToolCalls.get(id)
    if (toolAbortController) {
      toolAbortController.abort()
      this.activeToolCalls.delete(id)
      return true
    }
    return false
  }

  // Mark a client as intentionally closed before calling close(), so the
  // onclose-driven self-heal path skips reconnect for our own teardown.
  private closeClient(client: McpClient): Promise<void> {
    this.intentionalClientCloses.add(client)
    return client.close()
  }

  // Extract a numeric JSON-RPC / MCP error code without importing SDK runtime
  // enums, so this stays robust across SDK versions.
  private getMcpErrorCode(error: unknown): number | undefined {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof (error as { code: unknown }).code === 'number'
    ) {
      return (error as { code: number }).code
    }
    return undefined
  }

  // Called when an MCP client unexpectedly disconnects (e.g. stdio server
  // crashed or closed its end). Idempotent and guards against stale clients,
  // races with settings changes, and unbounded reconnect loops.
  private handleUnexpectedServerClose(name: string, client: McpClient): void {
    if (this.intentionalClientCloses.has(client)) {
      return
    }
    // Treat this client as drained from now on — guards against double-firing
    // and against the same client being targeted by the callTool fallback.
    this.intentionalClientCloses.add(client)

    const current = this.servers.find((s) => s.name === name)
    if (
      !current ||
      current.status !== McpServerStatus.Connected ||
      current.client !== client ||
      !current.config.enabled
    ) {
      return
    }

    const now = Date.now()
    const record = this.reconnectAttempts.get(name)
    if (record && now - record.windowStart < RECONNECT_WINDOW_MS) {
      if (record.count >= RECONNECT_MAX_ATTEMPTS) {
        console.warn(
          `[YOLO] MCP server "${name}" disconnected ${record.count} times within ${Math.round((now - record.windowStart) / 1000)}s — giving up on auto-reconnect.`,
        )
        this.updateServers((prev) =>
          prev.map((s) =>
            s.name === name
              ? {
                  name,
                  config: current.config,
                  status: McpServerStatus.Error,
                  error: new Error(
                    `MCP server "${name}" disconnected repeatedly. Disable and re-enable it in settings to retry.`,
                  ),
                }
              : s,
          ),
        )
        return
      }
      record.count += 1
    } else {
      this.reconnectAttempts.set(name, { count: 1, windowStart: now })
    }

    // Supersede any in-flight connection attempt for this server.
    this.connectionAborts.get(name)?.abort()
    const controller = new AbortController()
    this.connectionAborts.set(name, controller)

    this.updateServers((prev) =>
      prev.map((s) =>
        s.name === name
          ? {
              name,
              config: current.config,
              status: McpServerStatus.Connecting,
            }
          : s,
      ),
    )

    void (async () => {
      try {
        const reconnected = await this.connectServer(
          current.config,
          controller.signal,
        )

        if (controller.signal.aborted) {
          if (reconnected.status === McpServerStatus.Connected) {
            void this.closeClient(reconnected.client).catch(() => {
              /* best-effort teardown of orphan client */
            })
          }
          return
        }

        if (this.connectionAborts.get(name) === controller) {
          this.connectionAborts.delete(name)
        }

        // Settings may have toggled this server off mid-reconnect.
        const latest = this.servers.find((s) => s.name === name)
        if (!latest || !latest.config.enabled) {
          if (reconnected.status === McpServerStatus.Connected) {
            void this.closeClient(reconnected.client).catch(() => {
              /* best-effort teardown of orphan client */
            })
          }
          return
        }

        this.updateServers((prev) =>
          prev.map((s) => (s.name === name ? reconnected : s)),
        )
      } catch (error) {
        // `connectServer` normally swallows transport errors into an Error
        // state, but dynamic imports / diagnostics construction can still
        // throw. Without this catch the promise becomes an unhandled
        // rejection and the server stays stuck in Connecting.
        console.error(
          `[YOLO] MCP server "${name}" auto-reconnect crashed:`,
          error,
        )
        if (this.connectionAborts.get(name) === controller) {
          this.connectionAborts.delete(name)
        }
        if (controller.signal.aborted) {
          return
        }
        this.updateServers((prev) =>
          prev.map((s) =>
            s.name === name
              ? {
                  name,
                  config: current.config,
                  status: McpServerStatus.Error,
                  error:
                    error instanceof Error ? error : new Error(String(error)),
                }
              : s,
          ),
        )
      }
    })()
  }
}
