export type JsonRpcId = string | number

export type JsonRpcError = {
  code: number
  message: string
  data?: unknown
}

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string }
  | { type: 'skill'; name: string; path: string }

export type CodexThreadItem =
  | { type: 'userMessage'; id: string; content: CodexUserInput[] }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      status: string
      aggregatedOutput: string | null
      exitCode: number | null
      durationMs: number | null
    }
  | {
      type: 'fileChange'
      id: string
      changes: Array<{
        path: string
        kind:
          | { type: 'add' }
          | { type: 'delete' }
          | { type: 'update'; move_path: string | null }
        diff: string
      }>
      status: string
    }
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      status: string
      arguments: unknown
      result: unknown
      error: unknown
    }

export type CodexTurn = {
  id: string
  items: CodexThreadItem[]
  status: string
  error: { message?: string } | null
}

export type CodexThread = {
  id: string
  preview: string
  path: string | null
  cwd: string
  createdAt: number
  updatedAt: number
  name: string | null
  turns: CodexTurn[]
  modelProvider?: string
}

export type ThreadListResponse = {
  data: CodexThread[]
  nextCursor: string | null
}

export type ThreadReadResponse = { thread: CodexThread }
export type ThreadRollbackResponse = { thread: CodexThread }
export type ThreadStartResponse = {
  thread: CodexThread
  model?: string
  reasoningEffort?: string | null
}
export type ThreadResumeResponse = {
  thread: CodexThread
  model?: string
  reasoningEffort?: string | null
}
export type TurnStartResponse = { turn: CodexTurn }

export type CodexModel = {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  supportedReasoningEfforts: Array<{
    reasoningEffort: string
    description: string
  }>
  defaultReasoningEffort: string
  isDefault: boolean
}

export type ModelListResponse = {
  data: CodexModel[]
  nextCursor: string | null
}

export type CodexNotification = {
  method: string
  params: Record<string, unknown>
}

export type CodexServerRequest = {
  id: JsonRpcId
  method: string
  params: Record<string, unknown>
}
