import {
  type CliToolCallMetadata,
  type ToolCallArguments,
  type ToolCallRequest,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'

const toArgumentsRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value }

export const createCliToolCallRequest = ({
  id,
  metadata,
  input,
  arguments: providedArguments,
}: {
  id: string
  metadata: CliToolCallMetadata
  input?: unknown
  arguments?: ToolCallArguments
}): ToolCallRequest => ({
  id,
  name: metadata.name,
  arguments:
    providedArguments ??
    createCompleteToolCallArguments({ value: toArgumentsRecord(input) }),
  metadata: { cliToolCall: metadata },
})

export const getCliToolCallDisplayName = (
  metadata: CliToolCallMetadata,
): string =>
  metadata.namespace ? `${metadata.namespace}:${metadata.name}` : metadata.name

export const isCliToolCallCapability = (
  request: Pick<ToolCallRequest, 'metadata'>,
  capability: NonNullable<CliToolCallMetadata['capability']>,
): boolean => request.metadata?.cliToolCall?.capability === capability

export const getCliToolPresentationArguments = (
  request: Pick<ToolCallRequest, 'metadata'>,
): Record<string, unknown> | undefined =>
  request.metadata?.cliToolCall?.presentationArguments
