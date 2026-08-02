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

export type SkillsListResponse = {
  data: Array<{
    cwd: string
    skills: Array<{
      name: string
      description: string
      path: string
      enabled: boolean
    }>
  }>
}

export type ThreadCompactStartResponse = Record<string, never>

export type CodexThreadItem =
  | {
      type: 'userMessage'
      id: string
      clientId?: string | null
      content: CodexUserInput[]
    }
  | {
      type: 'agentMessage'
      id: string
      text: string
      phase?: string | null
    }
  | { type: 'hookPrompt'; id: string; fragments: unknown[] }
  | { type: 'plan'; id: string; text: string }
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
  | {
      type: 'dynamicToolCall'
      id: string
      namespace: string | null
      tool: string
      arguments: unknown
      status: string
      contentItems: unknown[] | null
      success: boolean | null
    }
  | {
      type: 'collabAgentToolCall'
      id: string
      tool: string
      status: string
      senderThreadId: string
      receiverThreadIds: string[]
      prompt: string | null
      model: string | null
      reasoningEffort: string | null
      agentsStates: Record<string, unknown>
    }
  | {
      type: 'webSearch'
      id: string
      query: string
      action: unknown
    }
  | { type: 'imageView'; id: string; path: string }
  | {
      type: 'imageGeneration'
      id: string
      status: string
      revisedPrompt: string | null
      result: string
      savedPath?: string
    }
  | { type: 'enteredReviewMode'; id: string; review: string }
  | { type: 'exitedReviewMode'; id: string; review: string }
  | { type: 'contextCompaction'; id: string }

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
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      readOnlyAccess: { type: string }
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }
  | {
      type: 'readOnly'
      access: { type: string }
      networkAccess: boolean
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

export type CodexRawResponseItem =
  | {
      type: 'custom_tool_call'
      status?: string
      call_id: string
      name: string
      input: string
    }
  | {
      type: 'function_call'
      status?: string
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'custom_tool_call_output'
      call_id: string
      name?: string
      output:
        | string
        | Array<
            | { type: 'input_text'; text: string }
            | { type: 'input_image'; image_url: string; detail?: string }
            | { type: 'encrypted_content'; encrypted_content: string }
          >
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string | unknown[]
    }

export type CodexServerRequest = {
  id: JsonRpcId
  method: string
  params: Record<string, unknown>
}
