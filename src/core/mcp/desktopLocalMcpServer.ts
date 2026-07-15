import type { App } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod/v4'

import { BAKED_PLUGIN_VERSION } from '../../constants/bakedVersion'
import type { YoloSettings } from '../../settings/schema/setting.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { loadDesktopNodeModule } from '../../utils/platform/desktopNodeModule'
import type { AgentService } from '../agent/service'
import type { RAGEngine } from '../rag/ragEngine'

import {
  type ExternalAgentTask,
  ExternalAgentTaskService,
} from './externalAgentTasks'
import { callLocalFileTool } from './localFileTools'
import {
  LOCAL_MCP_SERVER_HOST,
  LOCAL_MCP_SERVER_PATH,
  type LocalMcpServerRuntime,
  type LocalMcpServerState,
  getLocalMcpServerUrl,
} from './localMcpServerConfig'
import type { McpManager } from './mcpManager'

type HttpServer = import('node:http').Server
type IncomingMessage = import('node:http').IncomingMessage
type ServerResponse = import('node:http').ServerResponse
type McpServer = import('@modelcontextprotocol/sdk/server/mcp.js').McpServer
type RegisteredTool =
  import('@modelcontextprotocol/sdk/server/mcp.js').RegisteredTool
type StreamableHTTPServerTransport =
  import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport

type LocalMcpSession = {
  server: McpServer
  transport: StreamableHTTPServerTransport
  agentStartTool: RegisteredTool
  lastAccessedAt: number
}

type DesktopLocalMcpServerOptions = {
  app: App
  getSettings: () => YoloSettings
  getAgentService: () => Promise<AgentService>
  getMcpManager: () => Promise<McpManager>
  getRagEngine: () => Promise<RAGEngine>
  openConversation: (conversationId: string) => Promise<void>
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024
const MAX_SESSIONS = 16
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000

const searchInputSchema = {
  mode: z
    .enum(['keyword', 'rag', 'hybrid'])
    .optional()
    .describe('Search mode. Defaults to hybrid.'),
  scope: z
    .enum(['files', 'dirs', 'content', 'all'])
    .optional()
    .describe('Search scope. RAG and hybrid support content or all.'),
  query: z.string().optional().describe('Search query.'),
  path: z
    .string()
    .optional()
    .describe('Optional vault-relative file or folder path.'),
  maxResults: z.number().int().min(1).max(300).optional(),
  caseSensitive: z.boolean().optional(),
  ragMinSimilarity: z.number().min(0).max(1).optional(),
  ragLimit: z.number().int().min(1).max(300).optional(),
}

const taskIdInputSchema = {
  taskId: z.uuid().describe('Task ID returned by agent_task_start.'),
}

const textResult = (value: unknown, isError = false) => ({
  content: [
    {
      type: 'text' as const,
      text: typeof value === 'string' ? value : JSON.stringify(value),
    },
  ],
  ...(isError ? { isError: true } : {}),
})

const serializeTask = (task: ExternalAgentTask) => ({
  taskId: task.taskId,
  status: task.status,
  ...(task.result !== undefined ? { result: task.result } : {}),
  ...(task.error !== undefined ? { error: task.error } : {}),
})

const buildAgentCatalog = (settings: YoloSettings): string => {
  if (settings.assistants.length === 0) {
    return 'No agents are currently configured.'
  }
  return settings.assistants
    .map((assistant) => {
      const description = assistant.description?.trim()
      return `- ${assistant.id}: ${assistant.name}${description ? ` - ${description}` : ''}`
    })
    .join('\n')
}

const buildAgentStartDescription = (settings: YoloSettings): string =>
  `Start a YOLO agent as a persistent background task. The task uses the agent's model, tools, permissions, skills, and workspace scope configured in Obsidian. Omit assistantId to use the current default agent. Available agents:\n${buildAgentCatalog(settings)}`

const buildAgentStartInputSchema = (settings: YoloSettings) => ({
  prompt: z.string().min(1).max(100_000).describe('Task to execute.'),
  assistantId: z
    .string()
    .optional()
    .describe(
      `Agent ID. Omit to use the current default. Available IDs: ${settings.assistants
        .map((assistant) => assistant.id)
        .join(', ')}`,
    ),
})

const getHeader = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  const value = request.headers[name]
  return Array.isArray(value) ? undefined : value
}

const tokensEqual = (left: string, right: string): boolean => {
  const maxLength = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  if (response.headersSent) return
  response.writeHead(statusCode, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

const sendProtocolError = (
  response: ServerResponse,
  statusCode: number,
  message: string,
): void =>
  sendJson(response, statusCode, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  })

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const rawChunk of request) {
    const chunk =
      rawChunk instanceof Uint8Array
        ? rawChunk
        : new TextEncoder().encode(String(rawChunk))
    bytes += chunk.byteLength
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      throw new Error('MCP request body is too large.')
    }
    chunks.push(chunk)
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(merged)
  if (!text.trim()) {
    throw new Error('MCP request body is empty.')
  }
  return JSON.parse(text) as unknown
}

export class DesktopLocalMcpServer implements LocalMcpServerRuntime {
  private readonly taskService: ExternalAgentTaskService
  private readonly listeners = new Set<(state: LocalMcpServerState) => void>()
  private readonly sessions = new Map<string, LocalMcpSession>()
  private httpServer: HttpServer | null = null
  private currentSettings: YoloSettings
  private lifecycleQueue: Promise<void> = Promise.resolve()
  private state: LocalMcpServerState
  private initialized = false
  private closing = false
  private pendingSessionInitializations = 0

  constructor(private readonly options: DesktopLocalMcpServerOptions) {
    this.currentSettings = options.getSettings()
    this.state = {
      status: 'stopped',
      url: getLocalMcpServerUrl(this.currentSettings.mcp.localServer.port),
    }
    this.taskService = new ExternalAgentTaskService({
      app: options.app,
      getSettings: options.getSettings,
      getAgentService: options.getAgentService,
      getMcpManager: options.getMcpManager,
      openConversation: options.openConversation,
    })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    try {
      await this.taskService.initialize()
      this.initialized = true
    } catch (error) {
      this.setState({
        status: 'error',
        url: getLocalMcpServerUrl(this.currentSettings.mcp.localServer.port),
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  updateSettings(settings: YoloSettings): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const previous = this.currentSettings.mcp.localServer
      const previousAgentCatalog = buildAgentCatalog(this.currentSettings)
      this.currentSettings = settings
      const next = settings.mcp.localServer
      if (!this.initialized) {
        try {
          await this.initialize()
        } catch {
          return
        }
      }
      if (!next.enabled) {
        await this.stopHttpServer()
        this.setState({
          status: 'stopped',
          url: getLocalMcpServerUrl(next.port),
        })
        return
      }
      if (!next.token.trim()) {
        await this.stopHttpServer()
        this.setState({
          status: 'error',
          url: getLocalMcpServerUrl(next.port),
          error: 'A local MCP server token is required.',
        })
        return
      }

      const requiresRestart =
        !this.httpServer ||
        previous.port !== next.port ||
        previous.token !== next.token
      if (requiresRestart) {
        await this.stopHttpServer()
        await this.startHttpServer(next.port)
        return
      }
      if (previousAgentCatalog !== buildAgentCatalog(settings)) {
        this.refreshAgentTools()
      }
    })
  }

  getState(): LocalMcpServerState {
    return { ...this.state }
  }

  subscribe(listener: (state: LocalMcpServerState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closing = true
    this.taskService.beginShutdown()
    await this.enqueueLifecycle(async () => {
      await this.stopHttpServer()
      await this.taskService.close()
      this.setState({
        status: 'stopped',
        url: getLocalMcpServerUrl(this.currentSettings.mcp.localServer.port),
      })
    })
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycleQueue.then(operation, operation)
    this.lifecycleQueue = next.catch(() => undefined)
    return next
  }

  private async startHttpServer(port: number): Promise<void> {
    this.setState({
      status: 'starting',
      url: getLocalMcpServerUrl(port),
    })
    try {
      const { createServer } =
        await loadDesktopNodeModule<typeof import('node:http')>('node:http')
      const server = createServer((request, response) => {
        void this.handleRequest(request, response)
      })
      server.on('clientError', (_error, socket) => {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      })
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, LOCAL_MCP_SERVER_HOST)
      })
      if (this.closing) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        return
      }
      this.httpServer = server
      this.setState({ status: 'running', url: getLocalMcpServerUrl(port) })
    } catch (error) {
      this.httpServer = null
      console.error('[YOLO] Failed to start local MCP server', error)
      this.setState({
        status: 'error',
        url: getLocalMcpServerUrl(port),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async stopHttpServer(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(
      sessions.map(async (session) => {
        await session.transport.close().catch(() => undefined)
        await session.server.close().catch(() => undefined)
      }),
    )

    const server = this.httpServer
    this.httpServer = null
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${LOCAL_MCP_SERVER_HOST}`)
      if (url.pathname !== LOCAL_MCP_SERVER_PATH) {
        sendProtocolError(response, 404, 'Not found.')
        return
      }
      if (!this.isAuthorized(request)) {
        response.setHeader('WWW-Authenticate', 'Bearer')
        sendProtocolError(response, 401, 'Unauthorized.')
        return
      }
      if (getHeader(request, 'origin')) {
        sendProtocolError(
          response,
          403,
          'Browser-origin requests are forbidden.',
        )
        return
      }

      await this.pruneStaleSessions()

      const sessionId = getHeader(request, 'mcp-session-id')
      const existingSession = sessionId
        ? this.sessions.get(sessionId)
        : undefined
      if (existingSession) {
        existingSession.lastAccessedAt = Date.now()
      }
      if (request.method === 'GET' || request.method === 'DELETE') {
        if (!existingSession) {
          sendProtocolError(response, 404, 'Unknown MCP session.')
          return
        }
        await existingSession.transport.handleRequest(request, response)
        return
      }
      if (request.method !== 'POST') {
        sendProtocolError(response, 405, 'Method not allowed.')
        return
      }

      const body = await readJsonBody(request)
      if (existingSession) {
        await existingSession.transport.handleRequest(request, response, body)
        return
      }
      const { isInitializeRequest } = await import(
        '@modelcontextprotocol/sdk/types.js'
      )
      if (sessionId || !isInitializeRequest(body)) {
        sendProtocolError(response, 400, 'A valid MCP session is required.')
        return
      }
      if (
        this.sessions.size + this.pendingSessionInitializations >=
        MAX_SESSIONS
      ) {
        sendProtocolError(response, 429, 'Too many MCP sessions.')
        return
      }

      this.pendingSessionInitializations += 1
      let session: LocalMcpSession | null = null
      try {
        session = await this.createSession()
        await session.transport.handleRequest(request, response, body)
      } catch (error) {
        if (session) {
          await this.closeSession(session)
        }
        throw error
      } finally {
        this.pendingSessionInitializations -= 1
      }
    } catch (error) {
      console.error('[YOLO] Local MCP request failed', error)
      sendProtocolError(
        response,
        500,
        error instanceof Error ? error.message : 'Internal server error.',
      )
    }
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const authorization = getHeader(request, 'authorization')
    if (!authorization?.startsWith('Bearer ')) return false
    const candidate = authorization.slice('Bearer '.length)
    return tokensEqual(candidate, this.currentSettings.mcp.localServer.token)
  }

  private async createSession(): Promise<LocalMcpSession> {
    const [{ McpServer }, { StreamableHTTPServerTransport }] =
      await Promise.all([
        import('@modelcontextprotocol/sdk/server/mcp.js'),
        import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
      ])
    const server = new McpServer({
      name: 'obsidian-yolo',
      version: BAKED_PLUGIN_VERSION || '0.0.0',
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: uuidv4,
      enableJsonResponse: true,
      allowedHosts: [
        `${LOCAL_MCP_SERVER_HOST}:${this.currentSettings.mcp.localServer.port}`,
        `localhost:${this.currentSettings.mcp.localServer.port}`,
      ],
      enableDnsRebindingProtection: true,
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, session)
      },
      onsessionclosed: async (sessionId) => {
        const closed = this.sessions.get(sessionId)
        this.sessions.delete(sessionId)
        if (closed) {
          await closed.server.close().catch(() => undefined)
        }
      },
    })
    const agentStartTool = this.registerTools(server)
    const session = {
      server,
      transport,
      agentStartTool,
      lastAccessedAt: Date.now(),
    }
    await server.connect(transport)
    return session
  }

  private registerTools(server: McpServer): RegisteredTool {
    server.registerTool(
      'vault_search',
      {
        description:
          'Search the Obsidian vault using YOLO keyword, semantic RAG, or hybrid retrieval. Results are grouped by file with relevant snippets.',
        inputSchema: searchInputSchema,
        annotations: { readOnlyHint: true },
      },
      async (args, extra) => {
        const result = await callLocalFileTool({
          app: this.options.app,
          settings: this.options.getSettings(),
          getRagEngine: this.options.getRagEngine,
          toolName: 'fs_search',
          args,
          signal: extra.signal,
        })
        if (result.status === ToolCallResponseStatus.Success) {
          return textResult(result.text)
        }
        if (result.status === ToolCallResponseStatus.Aborted) {
          return textResult('Search was cancelled.', true)
        }
        return textResult('Search failed.', true)
      },
    )

    const agentStartTool = server.registerTool(
      'agent_task_start',
      {
        description: buildAgentStartDescription(this.currentSettings),
        inputSchema: buildAgentStartInputSchema(this.currentSettings),
      },
      async ({ prompt, assistantId }) => {
        try {
          const task = await this.taskService.start({ prompt, assistantId })
          return textResult(serializeTask(task))
        } catch (error) {
          return textResult(
            error instanceof Error ? error.message : String(error),
            true,
          )
        }
      },
    )

    server.registerTool(
      'agent_task_get',
      {
        description:
          'Get the current status and final result of a YOLO agent task.',
        inputSchema: taskIdInputSchema,
        annotations: { readOnlyHint: true },
      },
      async ({ taskId }) => {
        const task = await this.taskService.get(taskId)
        return task
          ? textResult(serializeTask(task))
          : textResult(`Unknown taskId: ${taskId}`, true)
      },
    )

    server.registerTool(
      'agent_task_cancel',
      {
        description: 'Cancel a running YOLO agent task.',
        inputSchema: taskIdInputSchema,
        annotations: { destructiveHint: true },
      },
      async ({ taskId }) => {
        try {
          return textResult(
            serializeTask(await this.taskService.cancel(taskId)),
          )
        } catch (error) {
          return textResult(
            error instanceof Error ? error.message : String(error),
            true,
          )
        }
      },
    )
    return agentStartTool
  }

  private refreshAgentTools(): void {
    const description = buildAgentStartDescription(this.currentSettings)
    const paramsSchema = buildAgentStartInputSchema(this.currentSettings)
    for (const session of this.sessions.values()) {
      session.agentStartTool.update({ description, paramsSchema })
    }
  }

  private async pruneStaleSessions(): Promise<void> {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS
    const stale = [...this.sessions.entries()].filter(
      ([, session]) => session.lastAccessedAt < cutoff,
    )
    await Promise.all(
      stale.map(async ([sessionId, session]) => {
        this.sessions.delete(sessionId)
        await this.closeSession(session)
      }),
    )
  }

  private async closeSession(session: LocalMcpSession): Promise<void> {
    await session.transport.close().catch(() => undefined)
    await session.server.close().catch(() => undefined)
  }

  private setState(state: LocalMcpServerState): void {
    this.state = state
    for (const listener of this.listeners) {
      listener(this.getState())
    }
  }
}
