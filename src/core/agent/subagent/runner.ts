import { v4 as uuidv4 } from 'uuid'

import type { TaskSource } from '../../../types/chat'
import type { ChatMessage, ChatUserMessage } from '../../../types/chat'
import type { ChatModel } from '../../../types/chat-model.types'
import type {
  LLMProvider,
  LLMProviderApiType,
} from '../../../types/provider.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { collectTotalAssistantUsage } from '../../../utils/chat/llmUsage'
import { formatErrorMessageWithCauses } from '../../../utils/error-message'
import type { BaseLLMProvider } from '../../llm/base'
import { type YoloAgentEvent, conversationStateToEvents } from '../agent-api'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'
import { CitationRegistry } from '../citationRegistry'
import { liveTaskStreamBus } from '../live-stream/taskStreamBus'
import { NativeAgentRuntime } from '../native-runtime'
import type { AgentConversationState } from '../service'
import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from '../types'

import {
  SUBAGENT_DEFAULT_SYSTEM_PROMPT,
  SUBAGENT_MAX_AUTO_ITERATIONS,
} from './constants'
import type { SubagentParentContext } from './parent-context'
import { subagentRuntimeRegistry } from './runtime-registry'
import { subagentTaskRegistry } from './task-registry'
import { filterAllowedToolsForSubagent } from './tool-filter'
import type {
  SubagentAcceptedResult,
  SubagentResult,
  SubagentTaskRecord,
} from './types'

export type RunSubagentParams = {
  description: string
  prompt: string
  conversationId: string
  source: TaskSource
  parent: SubagentParentContext
  childModel: {
    providerClient: BaseLLMProvider<LLMProvider>
    model: ChatModel
    apiType?: LLMProviderApiType | null
  }
  signal?: AbortSignal
}

function countToolUses(messages: ChatMessage[]): number {
  return messages.reduce((count, message) => {
    if (message.role !== 'tool') {
      return count
    }
    return (
      count +
      message.toolCalls.filter(
        (toolCall) =>
          toolCall.response.status === ToolCallResponseStatus.Success,
      ).length
    )
  }, 0)
}

/**
 * True when the subagent's last `tool` message still has a tool call awaiting
 * user approval (or the equivalent `ask_user_question` paused state). The
 * runtime returns from `run()` in this case (loop-worker emits `done` when
 * `hasPendingTools=true`), but the work is NOT actually complete — we should
 * wait for `approveToolCall` / `rejectToolCall` to resolve it and then
 * continue, instead of pushing a (false) completion to the parent.
 */
function hasUnresolvedApproval(messages: ChatMessage[]): boolean {
  const last = messages.at(-1)
  if (!last || last.role !== 'tool') return false
  return last.toolCalls.some(
    (toolCall) =>
      toolCall.response.status === ToolCallResponseStatus.PendingApproval ||
      toolCall.response.status === ToolCallResponseStatus.AwaitingUserInput,
  )
}

/**
 * A paused parallel tool batch may contain a mixture of calls that are still
 * awaiting a decision and calls that the user already approved but are still
 * executing. The subagent must not continue until every call in that batch
 * has reached a terminal response.
 */
export function hasUnsettledApprovalBatch(messages: ChatMessage[]): boolean {
  const last = messages.at(-1)
  if (!last || last.role !== 'tool') return false
  return last.toolCalls.some(
    (toolCall) =>
      toolCall.response.status === ToolCallResponseStatus.PendingApproval ||
      toolCall.response.status === ToolCallResponseStatus.AwaitingUserInput ||
      toolCall.response.status === ToolCallResponseStatus.Running,
  )
}

/**
 * NativeAgentRuntime keeps assistant/tool messages in its own transcript
 * across repeated `run()` calls. A continuation must therefore reuse only
 * the original request-message prefix; feeding the runtime snapshot back as
 * `input.messages` would append the same transcript twice on the next LLM
 * request and produce an invalid assistant/tool sequence.
 */
export function buildSubagentContinuationInput(
  input: AgentRuntimeRunInput,
): AgentRuntimeRunInput {
  return {
    ...input,
    requestMessages: input.requestMessages ?? input.messages,
  }
}

/**
 * Auto-reject every still-pending tool call on the runtime's last tool
 * message. Used as the 5-minute timeout fallback so a paused subagent does
 * not stall forever if the user never gets around to approving. The error
 * text is intentionally explicit so the model has enough context to decide
 * whether to retry differently or surface the situation to the user.
 *
 * Exported for unit tests; production callers should let the runner's
 * approval gate trigger this on its `setTimeout`.
 */
export function autoRejectPendingApprovals(runtime: NativeAgentRuntime): void {
  const snapshot = runtime.getSnapshot()
  const last = snapshot.messages.at(-1)
  if (!last || last.role !== 'tool') return
  for (const toolCall of last.toolCalls) {
    if (toolCall.response.status === ToolCallResponseStatus.PendingApproval) {
      runtime.setToolCallResponse(toolCall.request.id, {
        status: ToolCallResponseStatus.Error,
        error:
          'Tool approval timed out: the user did not respond within 5 minutes, so this call was auto-rejected. Try a different approach or summarise the situation in your final reply so the user can take over.',
      })
    }
  }
}

/** Auto-reject window for paused subagent tool calls. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

function extractLastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'assistant' && message.content.trim().length > 0) {
      return message.content.trim()
    }
  }
  return ''
}

function appendActivityLine(lines: string[], toolCallId: string, line: string) {
  lines.push(line)
  liveTaskStreamBus.push({
    type: 'stderr',
    toolCallId,
    chunk: `${line}\n`,
    ts: Date.now(),
  })
}

function projectSubagentEvent({
  event,
  parentToolCallId,
  activityLines,
}: {
  event: YoloAgentEvent
  parentToolCallId: string
  activityLines: string[]
}): string | undefined {
  if (event.type === 'state') {
    if (event.status === 'running') {
      liveTaskStreamBus.push({
        type: 'status',
        toolCallId: parentToolCallId,
        status: 'running',
      })
    }
    return undefined
  }

  if (event.type === 'tool') {
    appendActivityLine(
      activityLines,
      parentToolCallId,
      `[tool] ${event.name} ${event.status}`,
    )
    return undefined
  }

  if (event.type === 'completed') {
    if (event.text) {
      liveTaskStreamBus.push({
        type: 'stdout',
        toolCallId: parentToolCallId,
        chunk: event.text,
        ts: Date.now(),
      })
    }
    appendActivityLine(activityLines, parentToolCallId, '[state] completed')
    liveTaskStreamBus.push({
      type: 'status',
      toolCallId: parentToolCallId,
      status: 'done',
    })
    return event.text
  }

  if (event.type === 'error') {
    appendActivityLine(
      activityLines,
      parentToolCallId,
      `[error] ${event.message}`,
    )
    liveTaskStreamBus.push({
      type: 'status',
      toolCallId: parentToolCallId,
      status: 'done',
    })
  }

  return undefined
}

async function runChildAgent(
  record: SubagentTaskRecord,
  parent: SubagentParentContext,
  childModel: RunSubagentParams['childModel'],
): Promise<void> {
  const startedAt = record.createdAt
  const childUserMessage: ChatUserMessage = {
    role: 'user',
    id: uuidv4(),
    content: null,
    promptContent: record.prompt,
    mentionables: [],
  }

  const childAllowedToolNames = filterAllowedToolsForSubagent(
    parent.allowedToolNames,
  )

  const loopConfig: AgentRuntimeLoopConfig = {
    enableTools: parent.loopConfig.enableTools,
    includeBuiltinTools: parent.loopConfig.includeBuiltinTools,
    maxAutoIterations: SUBAGENT_MAX_AUTO_ITERATIONS,
  }

  const runtime = new NativeAgentRuntime(loopConfig)
  const citationRegistry = new CitationRegistry()
  const abortController = record.abortController
  const parentToolCallId = record.source.toolCallId
  const activityLines: string[] = []
  type Tracker = Parameters<typeof conversationStateToEvents>[0]['previous']
  let previous: Tracker = {
    assistantTextById: new Map(),
    toolStatusById: new Map(),
  }

  liveTaskStreamBus.push({
    type: 'status',
    toolCallId: parentToolCallId,
    status: 'starting',
  })
  appendActivityLine(activityLines, parentToolCallId, '[state] starting')

  const runInput: AgentRuntimeRunInput = {
    providerClient: childModel.providerClient,
    model: childModel.model,
    apiType: childModel.apiType,
    messages: [childUserMessage],
    requestMessages: [childUserMessage],
    conversationId: record.taskId,
    sourceUserMessageId: childUserMessage.id,
    assistantId: parent.assistantId,
    requestContextBuilder: parent.requestContextBuilder,
    mcpManager: parent.mcpManager,
    allowedToolNames: childAllowedToolNames,
    toolPreferences: parent.toolPreferences,
    toolServerPreferences: parent.toolServerPreferences,
    workspaceScope: parent.workspaceScope,
    allowedSkillPaths: parent.allowedSkillPaths,
    enableToolDisclosure: parent.enableToolDisclosure,
    reasoningLevel: parent.reasoningLevel,
    requestParams: parent.requestParams,
    abortSignal: abortController.signal,
    systemPromptOverride: SUBAGENT_DEFAULT_SYSTEM_PROMPT,
    toolApprovalConversationId: parent.conversationId,
    bypassToolApproval: parent.bypassToolApproval,
    runContext: { citationRegistry },
  }

  const unsubscribe = runtime.subscribe((snapshot) => {
    const state: AgentConversationState = {
      conversationId: record.taskId,
      status: abortController.signal.aborted ? 'aborted' : 'running',
      messages: snapshot.messages,
      compaction: snapshot.compaction,
      pendingCompactionAnchorMessageId:
        snapshot.pendingCompactionAnchorMessageId,
    }
    subagentTaskRegistry.update(record.taskId, {
      liveTranscript: snapshot.messages,
    })
    const nextEvents = conversationStateToEvents({
      state,
      sourceUserMessageId: childUserMessage.id,
      previous,
    })
    previous = nextEvents.nextTracker
    for (const event of nextEvents.events) {
      projectSubagentEvent({
        event,
        parentToolCallId,
        activityLines,
      })
    }
  })

  // While the runtime is paused on a PendingApproval tool call, this promise
  // gates the next loop iteration. Resolved by `resumeRun` (called from
  // `AgentService.approveToolCall` / `rejectToolCall` after they patch the
  // runtime's tool call response). Recreated for each pause so multiple
  // sequential approvals work.
  let approvalResolver: (() => void) | null = null
  const wakeApprovalGate = (): void => {
    if (approvalResolver) {
      approvalResolver()
      approvalResolver = null
    }
  }
  const resumeRun = async (): Promise<void> => {
    if (!hasUnsettledApprovalBatch(runtime.getSnapshot().messages)) {
      wakeApprovalGate()
    }
  }

  // If the user aborts the whole subagent while it's paused on approval, wake
  // the loop so it can exit promptly.
  const abortListener = () => {
    wakeApprovalGate()
  }
  abortController.signal.addEventListener('abort', abortListener, {
    once: true,
  })

  subagentRuntimeRegistry.register({
    taskId: record.taskId,
    runtime,
    mcpManager: parent.mcpManager,
    parentConversationId: record.conversationId,
    parentToolCallId,
    resumeRun,
  })

  try {
    let nextRunInput: AgentRuntimeRunInput = runInput
    while (true) {
      await runtime.run(nextRunInput)
      const snapshotAfterRun = runtime.getSnapshot()
      if (
        abortController.signal.aborted ||
        !hasUnresolvedApproval(snapshotAfterRun.messages)
      ) {
        break
      }
      // Subagent paused on a tool that needs the user's approval. Wait for
      // the SubagentCard's approval block to resolve it, then resume with
      // the patched messages as the continuation input.
      const timeoutHandle = setTimeout(() => {
        // 5-minute fallback: if the user has not approved/rejected, mark every
        // still-pending tool call as Error with a structured message so the
        // model can read "why it failed" and try a different approach. We
        // reject the whole batch (rather than just one) because we cannot
        // know which call the user was on the fence about, and the model's
        // best move is usually to abandon the batch and re-plan.
        autoRejectPendingApprovals(runtime)
        void resumeRun()
      }, APPROVAL_TIMEOUT_MS)
      try {
        await new Promise<void>((resolve) => {
          approvalResolver = resolve
        })
      } finally {
        clearTimeout(timeoutHandle)
      }
      if (abortController.signal.aborted) {
        break
      }
      nextRunInput = buildSubagentContinuationInput(runInput)
    }

    const snapshot = runtime.getSnapshot()
    const finalMessages = snapshot.messages
    const content = extractLastAssistantText(finalMessages)
    const completedEventText =
      projectSubagentEvent({
        event: {
          type: 'completed',
          conversationId: record.taskId,
          text: content,
        },
        parentToolCallId,
        activityLines,
      }) ?? content
    const completedAt = Date.now()
    const result: SubagentResult = {
      taskId: record.taskId,
      status: abortController.signal.aborted ? 'aborted' : 'completed',
      content: completedEventText,
      activityLog: activityLines.join('\n'),
      durationMs: completedAt - startedAt,
      toolUseCount: countToolUses(finalMessages),
      usage: collectTotalAssistantUsage(finalMessages),
      prompt: record.prompt,
      modelName: childModel.model.name ?? childModel.model.model,
      transcript: finalMessages,
    }

    subagentTaskRegistry.update(record.taskId, {
      status: result.status,
      completedAt,
      liveTranscript: finalMessages,
      result,
    })
  } catch (error) {
    const completedAt = Date.now()
    const status = abortController.signal.aborted ? 'aborted' : 'failed'
    const errorMessage = formatErrorMessageWithCauses(error)
    appendActivityLine(
      activityLines,
      parentToolCallId,
      status === 'aborted' ? '[state] aborted' : `[error] ${errorMessage}`,
    )
    liveTaskStreamBus.push({
      type: 'status',
      toolCallId: parentToolCallId,
      status: 'done',
    })
    subagentTaskRegistry.update(record.taskId, {
      status,
      completedAt,
      error: errorMessage,
      activityLog: activityLines.join('\n'),
      result: {
        taskId: record.taskId,
        status,
        content: errorMessage,
        activityLog: activityLines.join('\n'),
        durationMs: completedAt - startedAt,
        toolUseCount: 0,
        prompt: record.prompt,
        modelName: childModel.model.name ?? childModel.model.model,
      },
    })
  } finally {
    subagentRuntimeRegistry.unregister(record.taskId)
    abortController.signal.removeEventListener('abort', abortListener)
    // Defensive: if the loop is still sleeping in `await new Promise(...)`,
    // ensure the gate is resolved so we don't leak the promise on the
    // exception path either.
    wakeApprovalGate()
  }

  unsubscribe()

  const updatedRecord = subagentTaskRegistry.get(record.taskId)
  if (updatedRecord && updatedRecord.status !== 'running') {
    backgroundTaskCompletionBus.pushCompleted({
      kind: 'subagent',
      taskId: updatedRecord.taskId,
      conversationId: updatedRecord.conversationId,
      record: updatedRecord,
    })
  }
}

export async function runSubagent(
  params: RunSubagentParams,
): Promise<SubagentAcceptedResult> {
  const {
    description,
    prompt,
    conversationId,
    source,
    parent,
    childModel,
    signal,
  } = params

  if (signal?.aborted) {
    throw new Error('Subagent dispatch was aborted before start.')
  }

  const title = description.trim()
  if (!title) {
    throw new Error('description is required.')
  }
  const taskPrompt = prompt.trim()
  if (!taskPrompt) {
    throw new Error('prompt is required.')
  }

  const taskId = `sub_${uuidv4().replace(/-/g, '').slice(0, 12)}`
  const abortController = new AbortController()
  if (signal) {
    signal.addEventListener('abort', () => abortController.abort(), {
      once: true,
    })
  }

  const record: SubagentTaskRecord = {
    taskId,
    conversationId,
    source,
    title,
    status: 'running',
    createdAt: Date.now(),
    prompt: taskPrompt,
    abortController,
  }

  subagentTaskRegistry.register(record)

  void runChildAgent(record, parent, childModel).catch(() => {
    // Errors are persisted on the record; avoid unhandled rejection.
  })

  return {
    accepted: true,
    taskId,
    title,
    status: 'running',
    note: 'Subagent started asynchronously. The result will arrive as a follow-up background event when the child run completes.',
    modelName: childModel.model.name ?? childModel.model.model,
  }
}

export function abortAllSubagentTasks(): void {
  subagentTaskRegistry.abortAll()
}
