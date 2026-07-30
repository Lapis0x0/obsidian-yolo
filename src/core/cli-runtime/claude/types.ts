import type {
  Options,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  SpawnOptions,
  SpawnedProcess,
} from '@yolo/claude-agent-sdk-runtime'

export type ClaudeSdkQuery = AsyncGenerator<SDKMessage, void> & {
  interrupt(): Promise<unknown>
  initializationResult(): Promise<unknown>
  close(): void
}

export type ClaudeSdkModule = {
  query(input: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: Options
  }): ClaudeSdkQuery
  listSessions(options?: { dir?: string }): Promise<SDKSessionInfo[]>
  getSessionMessages(
    sessionId: string,
    options?: { dir?: string },
  ): Promise<SessionMessage[]>
}

export type ClaudeProcessSupport = {
  cliPath: string
  env: Record<string, string | undefined>
  spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess
}

export type ClaudePluginPathInput = {
  assistantId?: string
  enabledSkillNames: string[]
}

export type ClaudePluginPathProvider = (
  input: ClaudePluginPathInput,
) => Promise<string[]>

export type ClaudeSdkLoader = () => Promise<ClaudeSdkModule>
export type ClaudeProcessSupportResolver = () => Promise<ClaudeProcessSupport>
