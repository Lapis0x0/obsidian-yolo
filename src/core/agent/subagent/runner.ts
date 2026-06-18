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
    { jsSandboxSettings: parent.mcpManager.getJsSandboxSettings() },
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

  try {
    await runtime.run(runInput)
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
