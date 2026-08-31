import type {
  ModelInfo,
  Options,
  PermissionMode,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
  SpawnOptions,
  SpawnedProcess,
} from '@yolo/claude-agent-sdk-runtime'

export type ClaudeSdkQuery = AsyncGenerator<SDKMessage, void> & {
  interrupt(): Promise<unknown>
  initializationResult(): Promise<SDKControlInitializeResponse>
  supportedCommands?(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  >
  reloadSkills?(): Promise<{
    skills: Array<{ name: string; description: string; argumentHint?: string }>
  }>
  /**
   * Hot-reloads plugin state (enable/disable/install/uninstall) into the live
   * session. YOLO does not consume the resolved value, so it stays untyped.
   */
  reloadPlugins?(): Promise<unknown>
  /**
   * Current connection status of all configured MCP servers (including
   * plugin-provided servers). Optional because it depends on the Claude
   * Agent SDK build; YOLO probes for it defensively.
   */
  mcpServerStatus?(): Promise<
    Array<{
      name: string
      status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
      serverInfo?: { name: string; version: string }
      error?: string
      scope?: string
      tools?: Array<{ name: string; description?: string }>
    }>
  >
  /** Reconnect an MCP server by name. Throws on failure. */
  reconnectMcpServer?(serverName: string): Promise<void>
  /** Enable or disable an MCP server by name. Throws on failure. */
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<void>
  supportedModels(): Promise<ModelInfo[]>
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  applyFlagSettings(settings: {
    effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  }): Promise<void>
  getContextUsage(): Promise<{
    categories: Array<{
      name: string
      tokens: number
      color: string
      isDeferred?: boolean
    }>
    totalTokens: number
    maxTokens: number
    rawMaxTokens: number
    percentage: number
    [key: string]: unknown
  }>
  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<{
    canRewind: boolean
    error?: string
    filesChanged?: string[]
    insertions?: number
    deletions?: number
  }>
  close(): void
}

export type ClaudeSdkModule = {
  query(input: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: Options
  }): ClaudeSdkQuery
  getSessionMessages(
    sessionId: string,
    options?: { dir?: string },
  ): Promise<SessionMessage[]>
  getSubagentMessages(
    sessionId: string,
    agentId: string,
    options?: { dir?: string },
  ): Promise<SessionMessage[]>
}

export type ClaudeProcessSupport = {
  cliPath: string
  /**
   * Absolute path to a Node.js executable capable of running `cliPath` when
   * it resolves to a JS entrypoint (`cli.js`/`cli-wrapper.cjs`) instead of a
   * native binstub. `null` when no usable Node install was found.
   */
  nodePath: string | null
  env: Record<string, string | undefined>
  createAbortController: () => AbortController
  spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess
}

export type ClaudeSdkLoader = () => Promise<ClaudeSdkModule>
export type ClaudeProcessSupportResolver = () => Promise<ClaudeProcessSupport>
