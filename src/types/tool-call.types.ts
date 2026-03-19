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

export type ToolCallRequest = {
  id: string
  name: string
  arguments?: ToolCallArguments
  metadata?: {
    thoughtSignature?: string
  }
}

export type ToolCallResponse =
  | {
      status:
        | ToolCallResponseStatus.PendingApproval
        | ToolCallResponseStatus.Rejected
        | ToolCallResponseStatus.Running
    }
  | {
      status: ToolCallResponseStatus.Success
      data: {
        type: 'text'
        text: string
      }
    }
  | {
      status: ToolCallResponseStatus.Error
      error: string
    }
  | {
      status: ToolCallResponseStatus.Aborted
    }

export enum ToolCallResponseStatus {
  PendingApproval = 'pending_approval',
  Rejected = 'rejected',
  Running = 'running',
  Success = 'success',
  Error = 'error',
  Aborted = 'aborted',
}
