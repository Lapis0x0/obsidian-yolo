import type { ContentPart } from './llm/request'

export type ToolCallArguments =
  | {
      kind: 'partial'
      rawText: string
    }
  | {
      kind: 'complete'
      value: Record<string, unknown>
      rawText?: string
    }

export type ToolCallArgumentDiagnostics = {
  streamState?: 'open' | 'sealed' | 'aborted'
  parseState?: 'not_attempted' | 'valid' | 'invalid' | 'repaired'
  sealReason?: 'explicit_done' | 'stream_end' | 'turn_handoff'
  rawArgsLength?: number
  rawArgsHead?: string
  finishReason?: string | null
  timedOut?: boolean
  aborted?: boolean
  deliveryMode?: string
  parseError?: string
  repairApplied?: boolean
  repairActions?: string[]
}

export const isToolCallArgumentsRecord = (
  value: unknown,
): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const getToolCallArgumentsText = (
  args?: ToolCallArguments,
): string | undefined => {
  if (!args) {
    return undefined
  }

  if (args.kind === 'partial') {
    return args.rawText
  }

  return args.rawText ?? JSON.stringify(args.value)
}

export const getToolCallArgumentsObject = (
  args?: ToolCallArguments,
): Record<string, unknown> | undefined => {
  return args?.kind === 'complete' ? args.value : undefined
}

export const createCompleteToolCallArguments = ({
  value,
  rawText,
}: {
  value: Record<string, unknown>
  rawText?: string
}): ToolCallArguments => {
  return {
    kind: 'complete',
    value,
    rawText,
  }
}

export const createPartialToolCallArguments = (
  rawText: string,
): ToolCallArguments => {
  return {
    kind: 'partial',
    rawText,
  }
}

export type ToolEditUndoStatus =
  | 'available'
  | 'applied'
  | 'partial'
  | 'unavailable'

export type ToolEditOperation = 'edit' | 'create' | 'delete'

export type ToolEditSummaryFile = {
  path: string
  addedLines: number
  removedLines: number
  /** False when the provider reports the changed path but no per-file diff. */
  lineStatsAvailable?: boolean
  operation: ToolEditOperation
  undoStatus: Exclude<ToolEditUndoStatus, 'partial'>
  reviewRoundId?: string
}

export type ToolEditSummary = {
  files: ToolEditSummaryFile[]
  totalFiles: number
  totalAddedLines: number
  totalRemovedLines: number
  /**
   * False when the totals themselves are incomplete — i.e. some file's lines
   * could not be counted at all, so summing the files under-reports the turn.
   *
   * This is NOT the same as every file having `lineStatsAvailable: false`: a
   * provider that only reports turn-wide insertions/deletions (Claude CLI)
   * marks each file unavailable while the totals stay exact. Omitted means the
   * totals are trustworthy.
   */
  totalLineStatsAvailable?: boolean
  undoStatus: ToolEditUndoStatus
}

export type ToolFsReadOperationSummary =
  | {
      type: 'full'
      isPdf: boolean
      /**
       * Canonical names of skills read by this call. Present only when every
       * requested path was a successfully resolved skill.
       */
      skillNames?: string[]
    }
  | {
      type: 'lines'
      startLine: number
      endLine: number
      isPdf: boolean
      /**
       * Canonical names of skills read by this call. Present only when every
       * requested path was a successfully resolved skill.
       */
      skillNames?: string[]
    }

export type CliToolCallCapability =
  | 'command_execution'
  | 'file_change'
  | 'user_question'
  | 'permission_request'

/**
 * Provider-native identity for a CLI tool call.
 *
 * `name` and `namespace` are deliberately separate: CLI adapters must not
 * encode provenance or namespaces into the shared `ToolCallRequest.name`.
 * Presentation data is derived by an optional capability adapter and never
 * replaces the provider-native arguments.
 */
export type CliToolCallMetadata = {
  runtimeId: 'claude-code' | 'codex' | 'hermes' | 'pi'
  eventType: string
  name: string
  namespace?: string
  parentCallId?: string
  capability?: CliToolCallCapability
  presentationArguments?: Record<string, unknown>
}

export type ToolCallRequest = {
  id: string
  name: string
  arguments?: ToolCallArguments
  metadata?: {
    thoughtSignature?: string
    argumentDiagnostics?: ToolCallArgumentDiagnostics
    cliToolCall?: CliToolCallMetadata
    /**
     * Module chat mode tool approval, fixed at tool-call creation time by
     * `AgentToolGateway` and never recomputed afterward — every consumer
     * (gateway initial state, approve-after-review execution, the recovery
     * path, and the UI) must read this persisted value rather than the live
     * module registry, so a module upgrade/disable/reload never changes the
     * outcome for an already-created call. Present only for tool calls
     * created during a module chat mode run; absent (including for
     * historical/pre-D3 sessions) means "not a module chat mode call" and
     * every consumer falls back to its pre-D3 behavior.
     */
    approvalPolicy?: 'auto' | 'always-require-user'
    /**
     * Execution constraints fixed alongside `approvalPolicy` at creation
     * time, for the two execution paths that call `McpManager.callTool`
     * directly instead of going through `AgentToolGateway`
     * (`AgentService.approveToolCall` and the chat UI's pending-tool-call
     * recovery path) — neither has access to the gateway's live
     * `bashReadOnly` option, so it must be persisted on the request itself.
     */
    executionConstraints?: {
      bashReadOnly?: boolean
    }
  }
}

export type ToolCallResponse =
  | {
      status:
        | ToolCallResponseStatus.PendingApproval
        | ToolCallResponseStatus.Running
        | ToolCallResponseStatus.AwaitingUserInput
    }
  | {
      status: ToolCallResponseStatus.Rejected
      reason?: string
    }
  | {
      status: ToolCallResponseStatus.Success
      data: {
        type: 'text'
        text: string
        contentParts?: ContentPart[]
        metadata?: {
          editSummary?: ToolEditSummary
          fsReadOperation?: ToolFsReadOperationSummary
          /** Provider-native structured output used by CLI presentation adapters. */
          cliToolResult?: unknown
          appliedAt?: number
          truncated?: { totalBytes: number; omittedBytes: number }
        }
      }
    }
  | {
      status: ToolCallResponseStatus.Error
      error: string
    }
  | {
      status: ToolCallResponseStatus.Aborted
      /** 中断时已采集的输出（可选）。存在时表示已有部分输出；不存在时表示启动前就被取消。 */
      data?: {
        type: 'text'
        text: string
        metadata?: {
          truncated?: { totalBytes: number; omittedBytes: number }
        }
      }
    }

export enum ToolCallResponseStatus {
  PendingApproval = 'pending_approval',
  Rejected = 'rejected',
  Running = 'running',
  Success = 'success',
  Error = 'error',
  Aborted = 'aborted',
  /**
   * The tool call (currently only `ask_user_question`) is paused waiting for
   * the user to submit answers in a dedicated chat panel. Treated as a
   * "still-active" state: the agent run cannot continue and the gateway will
   * not auto-execute it.
   */
  AwaitingUserInput = 'awaiting_user_input',
}
