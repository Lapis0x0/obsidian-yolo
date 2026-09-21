import {
  type CliToolCallMetadata,
  type FileChangeRows,
  type ToolCallArguments,
  type ToolCallRequest,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { toEditSummaryPath } from '../tools/native/paths'

const toArgumentsRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value }

export const createCliToolCallRequest = ({
  id,
  metadata,
  input,
  arguments: providedArguments,
  fileChangeRows,
}: {
  id: string
  metadata: CliToolCallMetadata
  input?: unknown
  arguments?: ToolCallArguments
  /** What a `file_change` call changed, built by the runtime's mapping layer
   * (`core/tools/file-change-rows.ts`); the card draws it as given. */
  fileChangeRows?: FileChangeRows[]
}): ToolCallRequest => ({
  id,
  name: metadata.name,
  arguments:
    providedArguments ??
    createCompleteToolCallArguments({ value: toArgumentsRecord(input) }),
  metadata: {
    cliToolCall: metadata,
    ...(fileChangeRows ? { fileChangeRows } : {}),
  },
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

/**
 * The path a CLI file change is recorded under — in its `editSummary`, its
 * card rows, and its review snapshot alike, so one file is one row in the
 * edit summary panel whichever form the agent reported it in.
 *
 * It is the rule native writes follow (`toEditSummaryPath`): vault-relative
 * for a file inside the vault, unchanged outside it. A relative path is left
 * as it is, because it is already relative to the agent's working directory,
 * and `cwd` is that directory — the vault root for every CLI runtime. It is
 * `undefined` only where the provider reported none (a Codex transcript
 * without `cwd`), and then there is nothing to relativize against.
 */
export const toCliEditSummaryPath = (
  path: string,
  cwd: string | undefined,
): string => (cwd === undefined ? path : toEditSummaryPath(path, cwd))
