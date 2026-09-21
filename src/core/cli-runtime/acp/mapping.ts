import type {
  ContentBlock,
  Diff,
  PermissionOption,
  Plan,
  PlanEntry,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  Usage,
  UsageUpdate,
} from '@agentclientprotocol/sdk'

import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../../types/chat'
import type { ContentPart } from '../../../types/llm/request'
import type { ResponseUsage } from '../../../types/llm/response'
import {
  type CliToolCallCapability,
  type FileChangeRows,
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  type ToolEditSummaryFile,
  createCompleteToolCallArguments,
} from '../../../types/tool-call.types'
import { createToolEditSummary } from '../../../utils/chat/editSummary'
import type { CurrentFileText } from '../../tools/file-change-resolver'
import {
  buildFileChangeRowsFromContent,
  buildFileChangeRowsFromTexts,
  withoutLineNumbers,
} from '../../tools/file-change-rows'
import { createCliToolCallRequest, toCliEditSummaryPath } from '../tool-call'
import type {
  CliApprovalDecision,
  CliContextUsage,
  CliReasoningEffortOption,
  CliRuntimeId,
  CliRuntimeModel,
} from '../types'

const ACP_PLAN_MESSAGE_ID = 'acp-plan'

const stringify = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}

/** Best-effort rendering of one ACP content block into plain/markdown text. */
export const contentBlockToText = (block: ContentBlock): string => {
  if (block.type === 'text') return block.text
  if (block.type === 'image') {
    return block.uri
      ? `![image](${block.uri})`
      : `![image](data:${block.mimeType};base64,${block.data})`
  }
  if (block.type === 'audio') return '[audio attachment]'
  if (block.type === 'resource_link') {
    return `[${block.name}](${block.uri})`
  }
  // Embedded resource: prefer inline text when the agent provided it.
  const resource = block.resource
  if (resource && 'text' in resource && typeof resource.text === 'string') {
    return resource.text
  }
  return stringify(block)
}

const toolCallContentToText = (content: readonly ToolCallContent[]): string =>
  content
    .map((item) => {
      if (item.type === 'content') return contentBlockToText(item.content)
      if (item.type === 'diff') return `Modified ${item.path}`
      return '[terminal output]'
    })
    .join('\n\n')

/**
 * Extracts a shell command string for `command_execution` presentation. ACP's
 * `rawInput` is agent-defined (`unknown`), so this only recognizes a common
 * `{ command: string }` shape and otherwise falls back to the tool call title.
 */
const extractAcpCommandText = (state: AcpToolCallState): string => {
  const rawInput = state.rawInput
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const command = (rawInput as Record<string, unknown>).command
    if (typeof command === 'string') return command
  }
  return state.title
}

const mapAcpToolKindToCapability = (
  kind: ToolKind | undefined,
): 'command_execution' | 'file_change' | undefined => {
  if (kind === 'execute') return 'command_execution'
  if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    return 'file_change'
  }
  return undefined
}

/**
 * The call's capability, from the protocol alone — never from which agent
 * sent it. `kind` comes first; a call whose `kind` classifies nothing (it is
 * optional, and omitted means `other`) but that has reported a `diff` is a
 * file change all the same: a `diff` item is ACP's own statement that the
 * call changes that file.
 */
const getAcpToolCallCapability = (
  state: AcpToolCallState,
): CliToolCallCapability | undefined =>
  mapAcpToolKindToCapability(state.kind) ??
  (state.diffs.length > 0 ? 'file_change' : undefined)

/**
 * What one path of a call is shown and counted from. ACP does not say
 * whether a `diff`'s texts are the whole file or only the replaced span, and
 * agents differ (Hermes reports whole files, CodeBuddy the span), so a
 * reported diff's line numbers are unproven: counted from 1, they are right
 * for a whole file and wrong for a span. Once the call has completed the
 * runtime settles it against the file on disk (`resolveAcpWholeFileDiff`),
 * and a path it could settle is shown from those whole-file texts.
 */
type AcpShownDiff = { diff: Diff; wholeFile: boolean }

const getAcpShownDiffs = (state: AcpToolCallState): AcpShownDiff[] =>
  state.diffs.map((diff) => {
    const whole = state.wholeFileDiffs?.find(
      (candidate) => candidate.path === diff.path,
    )
    return whole ? { diff: whole, wholeFile: true } : { diff, wholeFile: false }
  })

/**
 * The card's file-change rows — one per path, already folded and truncated,
 * so what persists with the request is bounded no matter how large the files
 * are. Rows from a diff not settled against disk carry no line numbers:
 * showing numbers that may be wrong is worse than showing none.
 *
 * `oldText` carries ACP's three meanings through: a string is the prior
 * content (a real diff), `null` is a new file (everything added), and an
 * omitted field says nothing about the prior state, so only the written
 * content is shown, marked as such (`afterOnly`).
 */
const buildAcpFileChangeRows = (
  shown: readonly AcpShownDiff[],
): FileChangeRows[] =>
  shown.map(({ diff: { path, oldText, newText }, wholeFile }) => {
    const rows =
      oldText === undefined
        ? buildFileChangeRowsFromContent(path, newText)
        : buildFileChangeRowsFromTexts(path, oldText ?? '', newText)
    return wholeFile ? rows : withoutLineNumbers(rows)
  })

/** `request.metadata.fileChangeRows` for a file-change call that has diffs. */
const getAcpFileChangeRows = (
  capability: CliToolCallCapability | undefined,
  state: AcpToolCallState,
): FileChangeRows[] | undefined =>
  capability === 'file_change' && state.diffs.length > 0
    ? buildAcpFileChangeRows(getAcpShownDiffs(state))
    : undefined

/**
 * Settles one reported diff against the file on disk after its call
 * completed, returning the diff as whole-file texts, or `null` when the disk
 * does not bear it out:
 *
 * - the file equals `newText` — the report already was the whole file;
 * - `newText` occurs exactly once in the file — the report was the replaced
 *   span, and putting `oldText` back in its place is the file before the call;
 * - anything else (the file changed again since, the span is ambiguous, an
 *   absent or unknown `oldText` has nothing to put back) — no claim is made.
 *
 * Decided from the protocol fields and the disk alone, never from which
 * agent sent the diff.
 */
export const resolveAcpWholeFileDiff = (
  diff: Diff,
  disk: CurrentFileText,
): Diff | null => {
  if (disk.state !== 'text') return null
  if (disk.text === diff.newText) return diff
  if (typeof diff.oldText !== 'string' || diff.newText === '') return null
  const at = disk.text.indexOf(diff.newText)
  if (at < 0 || disk.text.indexOf(diff.newText, at + 1) >= 0) return null
  return {
    path: diff.path,
    oldText:
      disk.text.slice(0, at) +
      diff.oldText +
      disk.text.slice(at + diff.newText.length),
    newText: disk.text,
  }
}

/**
 * True for a completed file-change call whose diffs have not been settled
 * against disk yet — the runtime's cue to read the files once.
 */
export const isAcpDiskSettlementPending = (state: AcpToolCallState): boolean =>
  state.status === 'completed' &&
  state.wholeFileDiffs === undefined &&
  state.diffs.length > 0 &&
  getAcpToolCallCapability(state) === 'file_change'

const mapAcpToolCallStatusToResponseStatus = (
  status: ToolCallStatus,
):
  | ToolCallResponseStatus.Running
  | ToolCallResponseStatus.Success
  | ToolCallResponseStatus.Error => {
  if (status === 'completed') return ToolCallResponseStatus.Success
  if (status === 'failed') return ToolCallResponseStatus.Error
  return ToolCallResponseStatus.Running
}

/**
 * Folds the `diff` items of one incoming `content` array into the diffs this
 * call has already reported, keyed by path.
 *
 * ACP makes `content` a full replacement on every update, and agents use that
 * as specified: Hermes reports the edit's `diff` on the pending `tool_call`,
 * then completes with a `tool_call_update` whose `content` is only the result
 * text. Reading diffs off the latest `content` therefore finds none by the
 * time the call succeeds. Remembering them apart from `content` keeps the
 * replacement semantics intact while holding on to what the call changed.
 *
 * Per path, `newText` follows the latest report — a later update is the newer
 * truth about where the file ended up. `oldText` keeps the first *known*
 * report: it describes the file before this call touched it, and a later
 * re-report can only be relative to an intermediate state of the same call.
 * An omitted `oldText` states nothing, so a later report is allowed to fill
 * it in; `null` does state something (the file did not exist) and is kept.
 *
 * Paths are recorded in the one form every consumer keys on
 * (`toCliEditSummaryPath` against the agent's `cwd`): agents differ here —
 * CodeBuddy reports absolute paths, Hermes paths relative to its cwd — and
 * the rows, the `editSummary` and the review snapshot must all name one file
 * the same way, as must two reports of it in different forms.
 */
const mergeAcpDiffs = (
  previous: readonly Diff[],
  content: readonly ToolCallContent[] | null | undefined,
  cwd: string | undefined,
): Diff[] => {
  const incoming = (content ?? []).filter(
    (item): item is Extract<ToolCallContent, { type: 'diff' }> =>
      item.type === 'diff',
  )
  if (incoming.length === 0) return [...previous]
  const byPath = new Map<string, Diff>(
    previous.map((diff) => [diff.path, diff]),
  )
  for (const item of incoming) {
    const { oldText, newText } = item
    const path = toCliEditSummaryPath(item.path, cwd)
    const known = byPath.get(path)
    byPath.set(path, {
      path,
      oldText: known && known.oldText !== undefined ? known.oldText : oldText,
      newText,
    })
  }
  return [...byPath.values()]
}

/** Builds a `ToolEditSummary` from the diffs an ACP call reported, reusing
 * the shared line-diff engine. ACP-driven edits happen outside YOLO's own
 * file-tool executor, so — like Codex's file-change mapping — undo is marked
 * unavailable rather than claiming a snapshot that was never captured.
 *
 * Every file names `reviewRoundId`, the round its review snapshot is stored
 * under (`recordCliEditReviewSnapshot`): the call's own tool message id, set
 * explicitly because the id the transcript ends up giving the message is not
 * guaranteed to be the one it was emitted with. */
const buildAcpEditSummary = (
  shown: readonly AcpShownDiff[],
  reviewRoundId: string,
): ReturnType<typeof createToolEditSummary> => {
  const files = shown.flatMap(({ diff }): ToolEditSummaryFile[] => {
    // ACP gives `oldText` three meanings: a string is the prior content,
    // `null` means the file is new, and an omitted field says nothing about
    // the prior state. Counting the last case as a creation would report
    // every line as added — so the path is listed without line stats.
    if (diff.oldText === undefined) {
      return [
        {
          path: diff.path,
          addedLines: 0,
          removedLines: 0,
          lineStatsAvailable: false,
          operation: 'edit',
          undoStatus: 'unavailable',
          reviewRoundId,
        },
      ]
    }
    const summary = createToolEditSummary({
      path: diff.path,
      beforeContent: diff.oldText ?? '',
      afterContent: diff.newText,
      beforeExists: diff.oldText !== null,
      afterExists: true,
      reviewRoundId,
    })
    return summary
      ? summary.files.map((file) => ({
          ...file,
          undoStatus: 'unavailable' as const,
        }))
      : []
  })
  if (files.length === 0) return undefined
  const totalsComplete = files.every(
    (file) => file.lineStatsAvailable !== false,
  )
  return {
    files,
    totalFiles: files.length,
    totalAddedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
    totalRemovedLines: files.reduce((sum, file) => sum + file.removedLines, 0),
    ...(totalsComplete ? {} : { totalLineStatsAvailable: false }),
    undoStatus: 'unavailable',
  }
}

/** The tool card's identity — one owner for the `acp-result-` id. */
export const acpToolMessageId = (toolCallId: string): string =>
  `acp-result-${toolCallId}`

const buildAcpToolMessage = (
  request: ToolCallRequest,
  response: ToolCallResponse,
): ChatToolMessage => ({
  role: 'tool',
  id: acpToolMessageId(request.id),
  toolCalls: [{ request, response }],
})

const toolPair = ({
  request,
  response,
}: {
  request: ToolCallRequest
  response: ToolCallResponse
}): [ChatAssistantMessage, ChatToolMessage] => [
  {
    role: 'assistant',
    id: `acp-request-${request.id}`,
    content: '',
    toolCallRequests: [request],
    metadata: { generationState: 'completed' },
  },
  buildAcpToolMessage(request, response),
]

export type AcpToolCallState = {
  toolCallId: string
  title: string
  name?: string
  kind?: ToolKind
  status: ToolCallStatus
  content: ToolCallContent[]
  /**
   * Every file diff this call has reported, one per path — held apart from
   * `content`, which each update replaces wholesale. See `mergeAcpDiffs`.
   */
  diffs: Diff[]
  /**
   * `diffs` settled against disk as whole-file texts once the call completed
   * (`resolveAcpWholeFileDiff`), one per path that could be settled.
   * `undefined` until the runtime has done so; `[]` when no path could.
   */
  wholeFileDiffs?: Diff[]
  rawInput?: unknown
}

/** `cwd` is the agent's working directory, which its relative paths are
 * relative to (see `mergeAcpDiffs`). */
export const applyAcpToolCall = (
  update: ToolCall,
  cwd?: string,
): AcpToolCallState => ({
  toolCallId: update.toolCallId,
  title: update.title,
  name: update.name ?? undefined,
  kind: update.kind,
  status: update.status ?? 'pending',
  content: update.content ?? [],
  diffs: mergeAcpDiffs([], update.content, cwd),
  rawInput: update.rawInput,
})

export const applyAcpToolCallUpdate = (
  current: AcpToolCallState | undefined,
  update: ToolCallUpdate,
  cwd?: string,
): AcpToolCallState => ({
  toolCallId: update.toolCallId,
  title: update.title ?? current?.title ?? update.toolCallId,
  name: update.name ?? current?.name ?? undefined,
  kind: update.kind ?? current?.kind,
  status: update.status ?? current?.status ?? 'pending',
  content: update.content ?? current?.content ?? [],
  diffs: mergeAcpDiffs(current?.diffs ?? [], update.content, cwd),
  ...(current?.wholeFileDiffs
    ? { wholeFileDiffs: current.wholeFileDiffs }
    : {}),
  rawInput: update.rawInput !== undefined ? update.rawInput : current?.rawInput,
})

export const mapAcpToolCallState = (
  state: AcpToolCallState,
  runtimeId: CliRuntimeId,
): [ChatAssistantMessage, ChatToolMessage] => {
  const capability = getAcpToolCallCapability(state)
  const request = createCliToolCallRequest({
    id: state.toolCallId,
    input:
      capability === 'command_execution'
        ? { command: extractAcpCommandText(state) }
        : (state.rawInput ?? {}),
    metadata: {
      runtimeId,
      eventType: 'tool_call',
      name: state.name ?? state.title,
      ...(capability ? { capability } : {}),
    },
    fileChangeRows: getAcpFileChangeRows(capability, state),
  })
  const responseStatus = mapAcpToolCallStatusToResponseStatus(state.status)
  const response: ToolCallResponse =
    responseStatus === ToolCallResponseStatus.Error
      ? {
          status: ToolCallResponseStatus.Error,
          error: toolCallContentToText(state.content) || 'Tool call failed.',
        }
      : responseStatus === ToolCallResponseStatus.Running
        ? { status: ToolCallResponseStatus.Running }
        : {
            status: ToolCallResponseStatus.Success,
            data: {
              type: 'text',
              text: toolCallContentToText(state.content),
              ...(capability === 'file_change'
                ? (() => {
                    const editSummary = buildAcpEditSummary(
                      getAcpShownDiffs(state),
                      acpToolMessageId(state.toolCallId),
                    )
                    return editSummary ? { metadata: { editSummary } } : {}
                  })()
                : {}),
            },
          }
  return toolPair({ request, response })
}

const renderAcpPlanEntry = (entry: PlanEntry): string => {
  const box =
    entry.status === 'completed'
      ? '[x]'
      : entry.status === 'in_progress'
        ? '[~]'
        : '[ ]'
  return `- ${box} ${entry.content}`
}

export const renderAcpPlan = (plan: Plan): string =>
  plan.entries.map(renderAcpPlanEntry).join('\n')

export const buildAcpPlanMessage = (plan: Plan): ChatAssistantMessage => ({
  role: 'assistant',
  id: ACP_PLAN_MESSAGE_ID,
  content: renderAcpPlan(plan),
  metadata: { generationState: 'completed' },
})

/**
 * Per-turn token counts for the assistant footer. ACP's own field docs
 * describe these as session-cumulative, but agents report what their provider
 * returned for the turn (Hermes passes through the turn's `prompt_tokens` /
 * `completion_tokens`), and the wire carries no way to tell the two apart —
 * so this maps them as the turn metrics the footer expects.
 */
export const mapAcpTurnUsage = (usage: Usage): ResponseUsage => ({
  prompt_tokens: usage.inputTokens,
  completion_tokens: usage.outputTokens,
  total_tokens: usage.totalTokens,
  ...(usage.cachedReadTokens
    ? { cache_read_input_tokens: usage.cachedReadTokens }
    : {}),
  ...(usage.cachedWriteTokens
    ? { cache_creation_input_tokens: usage.cachedWriteTokens }
    : {}),
})

/**
 * ACP reports context pressure as a `used`/`size` pair, with no per-category
 * breakdown and no cache statistics — an agent that estimates rather than
 * counts (Hermes does) still reports through this same shape, so the ring
 * shows an approximation for those agents.
 */
export const mapAcpUsageUpdate = (
  update: UsageUpdate,
): CliContextUsage | null => {
  if (!Number.isFinite(update.used) || update.used < 0) return null
  const maxContextTokens =
    Number.isFinite(update.size) && update.size > 0 ? update.size : null
  return {
    promptTokens: Math.floor(update.used),
    maxContextTokens:
      maxContextTokens === null ? null : Math.floor(maxContextTokens),
  }
}

/**
 * `live`: streaming a prompt this client itself just sent — every
 * `user_message_chunk` echo is suppressed unconditionally. For a normal
 * turn it is redundant with the local optimistic user message; for a
 * synthetic prompt the runtime injects on its own (e.g. `compact()`
 * sending Hermes's `/compress`) there never was a local user message to
 * begin with, and none should appear — suppressing the echo either way is
 * exactly what both cases need.
 * `replay`: hydrating a stored session via `session/load` — there is no
 * local user message to fall back on, so `user_message_chunk` is the only
 * source of user turns and must be aggregated into `ChatUserMessage`s.
 */
export type AcpSessionAggregatorMode = 'live' | 'replay'

/**
 * Aggregates streaming `SessionUpdate` notifications into `ChatMessage`
 * upserts. Instantiated once per bound ACP session (live turns and
 * `session/load` replay share the same aggregation rules, only differing on
 * `user_message_chunk` per `mode`) and reset when the runtime rebinds to a
 * different session.
 */
export class AcpSessionAggregator {
  private readonly assistantText = new Map<string, string>()
  private readonly thoughtText = new Map<string, string>()
  private readonly userText = new Map<string, string>()
  private readonly toolCalls = new Map<string, AcpToolCallState>()
  /**
   * Scopes the ids used when aggregating live chunks. ACP only requires that
   * chunks of the same message share a `messageId`, not that the id is unique
   * across turns — so both omitted ids and recycled explicit ids are keyed
   * by `turnSequence`. Advanced once per live turn (`beginTurn`) and once
   * per id-less `user_message_chunk` in replay.
   */
  private turnSequence = 0
  /**
   * After a `tool_call`, later `agent_message_chunk`s are a new assistant
   * bubble — otherwise every delta in the turn shares one id and the UI
   * paints the whole answer above the tools.
   */
  private textSegment = 0
  private splitNextAssistantText = false

  /** `cwd`: the agent's working directory, see `mergeAcpDiffs`. */
  constructor(
    private readonly mode: AcpSessionAggregatorMode = 'live',
    private readonly cwd?: string,
  ) {}

  reset(): void {
    this.assistantText.clear()
    this.thoughtText.clear()
    this.userText.clear()
    this.toolCalls.clear()
    this.turnSequence = 0
    this.textSegment = 0
    this.splitNextAssistantText = false
  }

  /**
   * What this tool call last reported through `session/update`. Read by the
   * approval path, whose `session/request_permission` payload is only an
   * increment over these notifications (see `buildPendingApprovalMessages`).
   */
  getToolCall(toolCallId: string): AcpToolCallState | undefined {
    return this.toolCalls.get(toolCallId)
  }

  /**
   * Records what settling a completed call against disk found (see
   * `resolveAcpWholeFileDiff`) and returns its re-mapped messages, now drawn
   * from the whole-file texts. Nothing when the call is no longer known —
   * the session was reset while the files were being read.
   */
  settleToolCallAgainstDisk(
    toolCallId: string,
    wholeFileDiffs: Diff[],
    runtimeId: CliRuntimeId,
  ): ChatMessage[] {
    const current = this.toolCalls.get(toolCallId)
    if (!current) return []
    const state = { ...current, wholeFileDiffs }
    this.toolCalls.set(toolCallId, state)
    return mapAcpToolCallState(state, runtimeId)
  }

  /** Advances the aggregation epoch. Call once per live turn, before the prompt is sent. */
  beginTurn(): void {
    this.turnSequence += 1
    this.textSegment = 0
    this.splitNextAssistantText = false
  }

  /**
   * Fallback ids are already epoch-scoped (`stream-1`). Explicit `messageId`s
   * must be too: ACP only requires that chunks of the same message share an
   * id, not that the id is unique across turns. Hermes (and others) recycle
   * the same value, which would otherwise upsert into the previous turn.
   */
  // ACP delivers `messageId` as `string | null | undefined`; absent and
  // explicitly-null both mean "no id", and `?.trim()` collapses them together.
  private scopeLiveMessageId(
    messageId: string | null | undefined,
    kind: string,
  ): string {
    const explicit = messageId?.trim()
    if (!explicit) return `${kind}-${this.turnSequence}`
    if (this.turnSequence === 0) return explicit
    return `${explicit}@${this.turnSequence}`
  }

  private scopeAssistantTextId(messageId: string | null | undefined): string {
    if (this.splitNextAssistantText) {
      this.textSegment += 1
      this.splitNextAssistantText = false
    }
    const base = this.scopeLiveMessageId(messageId, 'stream')
    return this.textSegment > 0 ? `${base}.${this.textSegment}` : base
  }

  apply(update: SessionUpdate, runtimeId: CliRuntimeId): ChatMessage[] {
    if (update.sessionUpdate === 'user_message_chunk') {
      if (this.mode === 'live') {
        // Echo of the prompt we just sent; the local user message already covers it.
        return []
      }
      if (!update.messageId) this.turnSequence += 1
      this.textSegment = 0
      this.splitNextAssistantText = false
      const messageId = update.messageId ?? `user-${this.turnSequence}`
      const text = `${this.userText.get(messageId) ?? ''}${contentBlockToText(update.content)}`
      this.userText.set(messageId, text)
      const message: ChatUserMessage = {
        role: 'user',
        id: `acp-user-${messageId}`,
        content: null,
        promptContent: text,
        mentionables: [],
      }
      return [message]
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      const messageId = this.scopeAssistantTextId(update.messageId)
      const text = `${this.assistantText.get(messageId) ?? ''}${contentBlockToText(update.content)}`
      this.assistantText.set(messageId, text)
      return [
        {
          role: 'assistant',
          id: `acp-assistant-${messageId}`,
          content: text,
          metadata: { generationState: 'streaming' },
        },
      ]
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      const messageId = this.scopeLiveMessageId(update.messageId, 'thought')
      const text = `${this.thoughtText.get(messageId) ?? ''}${contentBlockToText(update.content)}`
      this.thoughtText.set(messageId, text)
      return [
        {
          role: 'assistant',
          id: `acp-thought-${messageId}`,
          content: '',
          reasoning: text,
          metadata: { generationState: 'streaming' },
        },
      ]
    }
    if (update.sessionUpdate === 'tool_call') {
      this.splitNextAssistantText = true
      const state = applyAcpToolCall(update, this.cwd)
      this.toolCalls.set(state.toolCallId, state)
      return mapAcpToolCallState(state, runtimeId)
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const state = applyAcpToolCallUpdate(
        this.toolCalls.get(update.toolCallId),
        update,
        this.cwd,
      )
      this.toolCalls.set(state.toolCallId, state)
      return mapAcpToolCallState(state, runtimeId)
    }
    if (update.sessionUpdate === 'plan') {
      return [buildAcpPlanMessage(update)]
    }
    // plan_update / plan_removed / available_commands_update /
    // current_mode_update / config_option_update / session_info_update:
    // unstable or out of scope for v1 (no UI surface yet) — ignored rather
    // than guessed at. `usage_update` produces no message either, but it does
    // feed the context ring; the runtime reads it through `mapAcpUsageUpdate`.
    return []
  }
}

/** Upserts by message id, matching the controller's own upsert semantics. */
export const upsertAcpMessage = (
  messages: ChatMessage[],
  message: ChatMessage,
): void => {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index < 0) messages.push(message)
  else messages[index] = message
}

/**
 * `known` is the state this tool call already reported through
 * `session/update`, looked up by the caller.
 *
 * ACP types `session/request_permission`'s `toolCall` as a *`ToolCallUpdate`*
 * — an increment over what the agent already sent, not a self-contained
 * description. Agents act on that: CodeBuddy's permission request carries
 * only `toolCallId` and `rawInput`, having announced `title: "Bash"` and the
 * call's `kind` in the preceding `tool_call` notification. Reading the
 * request alone therefore leaves the approval card with no title to show but
 * the raw tool-call id, and no `kind` to classify the call by — so the card
 * the user is asked to approve would be headed `chatcmpl-tool-90ed20f2…`
 * while the very same call renders as "Bash" everywhere else.
 *
 * Merging the remembered state underneath the request restores both. The
 * request still wins field by field, because an increment that *does* carry
 * a field is the newer truth.
 */
export const buildPendingApprovalMessages = (
  request: RequestPermissionRequest,
  runtimeId: CliRuntimeId,
  known?: AcpToolCallState,
  cwd?: string,
): [ChatAssistantMessage, ChatToolMessage] => {
  const toolCall = request.toolCall
  const title = toolCall.title ?? known?.title ?? toolCall.toolCallId
  const state: AcpToolCallState = {
    toolCallId: toolCall.toolCallId,
    title,
    name: toolCall.name ?? known?.name ?? undefined,
    kind: toolCall.kind ?? known?.kind ?? undefined,
    status: toolCall.status ?? 'pending',
    content: toolCall.content ?? known?.content ?? [],
    diffs: mergeAcpDiffs(known?.diffs ?? [], toolCall.content, cwd),
    rawInput: toolCall.rawInput ?? known?.rawInput,
  }
  const capability = getAcpToolCallCapability(state)
  const fileChangeRows = getAcpFileChangeRows(capability, state)
  const argumentsValue =
    capability === 'command_execution'
      ? { command: extractAcpCommandText(state) }
      : ((state.rawInput as Record<string, unknown> | undefined) ?? {})
  const toolCallRequest: ToolCallRequest = {
    id: toolCall.toolCallId,
    name: state.name ?? title,
    arguments: createCompleteToolCallArguments({ value: argumentsValue }),
    metadata: {
      cliToolCall: {
        runtimeId,
        eventType: 'requestPermission',
        name: state.name ?? title,
        ...(capability ? { capability } : {}),
      },
      ...(fileChangeRows ? { fileChangeRows } : {}),
    },
  }
  return toolPair({
    request: toolCallRequest,
    response: { status: ToolCallResponseStatus.PendingApproval },
  })
}

/** ACP text/image content blocks for an outgoing `session/prompt` request. */
export const toAcpPromptBlocks = (
  content: string | ContentPart[],
): ContentBlock[] => {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  return content.map((part): ContentBlock => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'image_url') {
      const dataUrlMatch = part.image_url.url.match(
        /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/,
      )
      if (dataUrlMatch) {
        return {
          type: 'image',
          mimeType: dataUrlMatch[1],
          data: dataUrlMatch[2],
        }
      }
      return {
        type: 'resource_link',
        uri: part.image_url.url,
        name: 'image',
      }
    }
    throw new Error('This ACP runtime does not support PDF attachments.')
  })
}

/**
 * True for every block `toAcpPromptBlocks` produces from an `image_url`
 * part. Only base64 data URLs become an `image` block — an http(s) or
 * `app://` image becomes a `resource_link` named `image` — so a caller that
 * must keep images away from an agent has to match both kinds.
 */
export const isAcpImagePromptBlock = (block: ContentBlock): boolean =>
  block.type === 'image' ||
  (block.type === 'resource_link' && block.name === 'image')

/**
 * Maps our three-tier approval decision onto one of the `PermissionOption`s
 * the agent offered for this specific request:
 *  - `approve_once` -> the `allow_once` option
 *  - `approve_for_session` -> `allow_always`, falling back to `allow_once`
 *    when the agent didn't offer a session-scoped option
 *  - `reject` -> `reject_once`, falling back to `reject_always`
 * Returns `null` when no option of an acceptable kind was offered at all.
 */
export const resolveApprovalOptionId = (
  options: readonly PermissionOption[],
  decision: CliApprovalDecision,
): string | null => {
  const byKind = (kind: PermissionOption['kind']): string | null =>
    options.find((option) => option.kind === kind)?.optionId ?? null

  if (decision === 'approve_once') {
    return byKind('allow_once') ?? byKind('allow_always')
  }
  if (decision === 'approve_for_session') {
    return byKind('allow_always') ?? byKind('allow_once')
  }
  return byKind('reject_once') ?? byKind('reject_always')
}

/**
 * Per ACP's cancellation contract: "If the client cancels the prompt turn
 * via `session/cancel`, it MUST respond to [a pending `requestPermission`]
 * with `RequestPermissionOutcome::Cancelled`."
 */
export const buildCancelledApprovalOutcome = (): RequestPermissionResponse => ({
  outcome: { outcome: 'cancelled' },
})

// ---------------------------------------------------------------------------
// Session mode state
// ---------------------------------------------------------------------------

/**
 * `session/new` and `session/load` responses carry the agent's edit-policy
 * modes as `modes: { currentModeId, availableModes }` when it supports them
 * (ACP's Session Modes). `AcpCliRuntime` needs both halves: the id set to
 * check a profile-declared mode is actually offered before requesting it,
 * and the current id so a freshly bound session starts from the agent's
 * truth rather than whatever the previous session was left on.
 */
export type AcpSessionModeState = Readonly<{
  modeIds: ReadonlySet<string>
  currentModeId: string | null
}>

export const extractAcpSessionModeState = (
  response: unknown,
): AcpSessionModeState | null => {
  if (typeof response !== 'object' || response === null) return null
  const modes = (response as { modes?: unknown }).modes
  if (typeof modes !== 'object' || modes === null) return null
  const { availableModes, currentModeId } = modes as {
    availableModes?: unknown
    currentModeId?: unknown
  }
  if (!Array.isArray(availableModes)) return null
  const modeIds = new Set<string>()
  for (const raw of availableModes) {
    if (typeof raw !== 'object' || raw === null) continue
    const { id } = raw as { id?: unknown }
    if (typeof id === 'string' && id.length > 0) modeIds.add(id)
  }
  if (modeIds.size === 0) return null
  return {
    modeIds,
    currentModeId:
      typeof currentModeId === 'string' && currentModeId.length > 0
        ? currentModeId
        : null,
  }
}

// ---------------------------------------------------------------------------
// Session model state
// ---------------------------------------------------------------------------

/**
 * `session/new` and `session/load` responses may carry the agent's model list
 * as `models: { availableModels, currentModelId }` — the ACP model-selection
 * extension (paired with the `session/set_model` request) that Hermes and
 * other agents speak. The current SDK's typed responses omit the field (the
 * spec is migrating it to `configOptions`), so this reads the raw shape
 * defensively; `null` means the agent doesn't report models and the host
 * keeps its picker in the default-model placeholder state.
 */
export type AcpSessionModelState = Readonly<{
  models: CliRuntimeModel[]
  currentModelId: string | null
}>

export const extractAcpSessionModelState = (
  response: unknown,
): AcpSessionModelState | null => {
  if (typeof response !== 'object' || response === null) return null
  const models = (response as { models?: unknown }).models
  if (typeof models !== 'object' || models === null) return null
  const { availableModels, currentModelId } = models as {
    availableModels?: unknown
    currentModelId?: unknown
  }
  if (!Array.isArray(availableModels)) return null
  const mapped: CliRuntimeModel[] = []
  for (const raw of availableModels) {
    if (typeof raw !== 'object' || raw === null) continue
    const { modelId, name, description } = raw as {
      modelId?: unknown
      name?: unknown
      description?: unknown
    }
    if (typeof modelId !== 'string' || modelId.length === 0) continue
    mapped.push({
      id: modelId,
      label: typeof name === 'string' && name.length > 0 ? name : modelId,
      ...(typeof description === 'string' && description.length > 0
        ? { description }
        : {}),
      reasoningEfforts: [],
    })
  }
  if (mapped.length === 0) return null
  return {
    models: mapped,
    currentModelId:
      typeof currentModelId === 'string' && currentModelId.length > 0
        ? currentModelId
        : null,
  }
}

// ---------------------------------------------------------------------------
// Session config options (reasoning effort)
// ---------------------------------------------------------------------------

/**
 * ACP's session config options (`configOptions` on `session/new` /
 * `session/load`, written back with `session/set_config_option`) are a
 * generic list of agent-defined selectors. The spec does not define what any
 * of them *mean*, with one exception that matters here: `category` carries a
 * small reserved vocabulary — `mode`, `model`, `model_config`,
 * `thought_level` — specifically so a client can recognise the common
 * selectors without knowing the agent.
 *
 * This reads the `thought_level` one, which is the product's reasoning
 * effort. Everything else the agent advertises is deliberately ignored: the
 * option ids and values are free text, so an option this product has no
 * concept for cannot be rendered as anything more useful than a raw
 * dropdown, and guessing at its meaning would be worse than leaving it to
 * the agent's own default.
 */
export type AcpThoughtLevelState = Readonly<{
  /** The option's own id, needed to write the value back. */
  optionId: string
  /** Selectable levels, in the order the agent listed them. */
  options: readonly CliReasoningEffortOption[]
  /** Ids of every selectable level, for validating a write before sending it. */
  valueIds: ReadonlySet<string>
  currentValue: string | null
}>

/**
 * Select options arrive either flat or grouped; the product has no grouped
 * presentation for reasoning levels, so groups are flattened in order.
 */
const flattenSelectOptions = (
  options: unknown,
): { id: string; description?: string }[] => {
  if (!Array.isArray(options)) return []
  const flattened: { id: string; description?: string }[] = []
  for (const raw of options) {
    if (typeof raw !== 'object' || raw === null) continue
    const {
      value,
      description,
      options: grouped,
    } = raw as {
      value?: unknown
      description?: unknown
      options?: unknown
    }
    if (Array.isArray(grouped)) {
      flattened.push(...flattenSelectOptions(grouped))
      continue
    }
    if (typeof value !== 'string' || value.length === 0) continue
    flattened.push({
      id: value,
      ...(typeof description === 'string' && description.length > 0
        ? { description }
        : {}),
    })
  }
  return flattened
}

export const extractAcpThoughtLevelState = (
  response: unknown,
): AcpThoughtLevelState | null => {
  if (typeof response !== 'object' || response === null) return null
  const configOptions = (response as { configOptions?: unknown }).configOptions
  if (!Array.isArray(configOptions)) return null
  for (const raw of configOptions) {
    if (typeof raw !== 'object' || raw === null) continue
    const { id, type, category, currentValue, options } = raw as {
      id?: unknown
      type?: unknown
      category?: unknown
      currentValue?: unknown
      options?: unknown
    }
    if (category !== 'thought_level' || type !== 'select') continue
    if (typeof id !== 'string' || id.length === 0) continue
    const mapped = flattenSelectOptions(options)
    if (mapped.length === 0) return null
    return {
      optionId: id,
      options: mapped,
      valueIds: new Set(mapped.map((option) => option.id)),
      currentValue:
        typeof currentValue === 'string' && currentValue.length > 0
          ? currentValue
          : null,
    }
  }
  return null
}
