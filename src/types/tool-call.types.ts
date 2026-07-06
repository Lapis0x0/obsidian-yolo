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
  operation: ToolEditOperation
  undoStatus: Exclude<ToolEditUndoStatus, 'partial'>
  reviewRoundId?: string
}

export type ToolEditSummary = {
  files: ToolEditSummaryFile[]
  totalFiles: number
  totalAddedLines: number
  totalRemovedLines: number
  undoStatus: ToolEditUndoStatus
}

export type ToolFsReadOperationSummary =
  | {
      type: 'full'
      isPdf: boolean
    }
  | {
      type: 'lines'
      startLine: number
      endLine: number
      isPdf: boolean
    }

export type ToolCallRequest = {
  id: string
  name: string
  arguments?: ToolCallArguments
  metadata?: {
    thoughtSignature?: string
    argumentDiagnostics?: ToolCallArgumentDiagnostics
  }
}

export type ToolCallResponse =
  | {
      status:
        | ToolCallResponseStatus.PendingApproval
        | ToolCallResponseStatus.Rejected
        | ToolCallResponseStatus.Running
        | ToolCallResponseStatus.AwaitingUserInput
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
