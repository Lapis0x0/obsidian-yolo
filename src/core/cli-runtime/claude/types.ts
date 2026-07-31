import type {
  ModelInfo,
  Options,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKSessionInfo,
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
  applyFlagSettings(settings: {
    effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  }): Promise<void>
  close(): void
}

export type ClaudeSdkModule = {
  query(input: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: Options
  }): ClaudeSdkQuery
  listSessions(options?: {
    dir?: string
    limit?: number
    offset?: number
  }): Promise<SDKSessionInfo[]>
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
