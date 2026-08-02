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
  supportedModels(): Promise<ModelInfo[]>
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  applyFlagSettings(settings: {
    effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  }): Promise<void>
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
}

export type ClaudeProcessSupport = {
  cliPath: string
  env: Record<string, string | undefined>
  createAbortController: () => AbortController
  spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess
}

export type ClaudeSdkLoader = () => Promise<ClaudeSdkModule>
export type ClaudeProcessSupportResolver = () => Promise<ClaudeProcessSupport>
