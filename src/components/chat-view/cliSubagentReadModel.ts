import type { CliRuntimeId } from '../../core/cli-runtime'
import type { ChatMessage } from '../../types/chat'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'

import type {
  SubagentDetailStats,
  SubagentDisplayStatus,
} from './tool-cards/SubagentCardView'

export type CliSubagentPresentation = {
  toolCallId: string
  runtimeId: CliRuntimeId
  title?: string
  modelName?: string
  prompt?: string
  taskId?: string
  status: SubagentDisplayStatus
  subtitle?: string
  transcript: ChatMessage[]
  detailStats?: SubagentDetailStats
}

export type CliSubagentReadModel = {
  visibleMessages: ChatMessage[]
  presentationsByToolCallId: ReadonlyMap<string, CliSubagentPresentation>
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const readString = (
  record: JsonRecord | null,
  key: string,
): string | undefined =>
  typeof record?.[key] === 'string' ? record[key] : undefined

const responseStructuredResult = (
  response: ToolCallResponse,
): JsonRecord | null =>
  response.status === ToolCallResponseStatus.Success
    ? asRecord(response.data.metadata?.cliToolResult)
    : null

const responseTextRecord = (response: ToolCallResponse): JsonRecord | null => {
  if (response.status !== ToolCallResponseStatus.Success) return null
  try {
    return asRecord(JSON.parse(response.data.text) as unknown)
  } catch {
    return null
  }
}

const toBaseStatus = (response: ToolCallResponse): SubagentDisplayStatus => {
  switch (response.status) {
    case ToolCallResponseStatus.Running:
      return 'running'
    case ToolCallResponseStatus.Error:
      return 'error'
    case ToolCallResponseStatus.Aborted:
    case ToolCallResponseStatus.Rejected:
      return 'aborted'
    case ToolCallResponseStatus.Success:
      return 'success'
    default:
      return 'dispatched'
  }
}

const getMessageParentCallId = (message: ChatMessage): string | undefined => {
  if (message.role === 'assistant') {
    return (
      message.metadata?.cliSubagentParentCallId ??
      message.toolCallRequests?.find(
        (request) => request.metadata?.cliToolCall?.parentCallId,
      )?.metadata?.cliToolCall?.parentCallId
    )
  }
  if (message.role !== 'tool') return undefined
  return message.toolCalls.find(
    ({ request }) => request.metadata?.cliToolCall?.parentCallId,
  )?.request.metadata?.cliToolCall?.parentCallId
}

const splitClaudeChildActivity = (
  messages: readonly ChatMessage[],
): {
  visibleMessages: ChatMessage[]
  transcriptByParentCallId: Map<string, ChatMessage[]>
} => {
  const visibleMessages: ChatMessage[] = []
  const transcriptByParentCallId = new Map<string, ChatMessage[]>()
  for (const message of messages) {
    const parentCallId = getMessageParentCallId(message)
    if (!parentCallId) {
      visibleMessages.push(message)
      continue
    }
    const transcript = transcriptByParentCallId.get(parentCallId) ?? []
    transcript.push(message)
    transcriptByParentCallId.set(parentCallId, transcript)
  }
  return { visibleMessages, transcriptByParentCallId }
}

const collectResponses = (
  messages: readonly ChatMessage[],
): Map<string, ToolCallResponse> => {
  const responses = new Map<string, ToolCallResponse>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const toolCall of message.toolCalls) {
      responses.set(toolCall.request.id, toolCall.response)
    }
  }
  return responses
}

const latestAssistantText = (
  messages: readonly ChatMessage[],
): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = message.content.trim() || message.reasoning?.trim()
    if (text) return text.split('\n').at(-1)
  }
  return undefined
}

const extractStructuredText = (
  record: JsonRecord | null,
): string | undefined => {
  const result = readString(record, 'result') ?? readString(record, 'summary')
  if (result) return result.trim().split('\n').at(-1)
  const content = record?.content
  if (!Array.isArray(content)) return undefined
  const texts = content.flatMap((item): string[] => {
    const block = asRecord(item)
    return typeof block?.text === 'string' ? [block.text] : []
  })
  return texts.join('\n').trim().split('\n').at(-1)
}

const buildClaudePresentations = (
  visibleMessages: readonly ChatMessage[],
  transcriptByParentCallId: ReadonlyMap<string, ChatMessage[]>,
): Map<string, CliSubagentPresentation> => {
  const responses = collectResponses(visibleMessages)
  const presentations = new Map<string, CliSubagentPresentation>()
  for (const message of visibleMessages) {
    if (message.role !== 'assistant') continue
    for (const request of message.toolCallRequests ?? []) {
      const metadata = request.metadata?.cliToolCall
      if (metadata?.runtimeId !== 'claude-code' || metadata.name !== 'Agent') {
        continue
      }
      const args = getToolCallArgumentsObject(request.arguments) ?? {}
      const response = responses.get(request.id) ?? {
        status: ToolCallResponseStatus.Running,
      }
      const structured = responseStructuredResult(response)
      const structuredStatus = readString(structured, 'status')
      const transcript = transcriptByParentCallId.get(request.id) ?? []
      const status =
        structuredStatus === 'async_launched'
          ? 'running'
          : structuredStatus === 'completed'
            ? 'success'
            : structuredStatus === 'failed' || structuredStatus === 'errored'
              ? 'error'
              : toBaseStatus(response)
      const totalTokens =
        typeof structured?.totalTokens === 'number'
          ? structured.totalTokens
          : undefined
      const toolUseCount =
        typeof structured?.totalToolUseCount === 'number'
          ? structured.totalToolUseCount
          : undefined
      const durationMs =
        typeof structured?.totalDurationMs === 'number'
          ? structured.totalDurationMs
          : undefined
      presentations.set(request.id, {
        toolCallId: request.id,
        runtimeId: 'claude-code',
        title:
          typeof args.description === 'string'
            ? args.description.trim()
            : undefined,
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        modelName:
          readString(structured, 'resolvedModel') ??
          (typeof args.model === 'string' ? args.model : undefined),
        taskId: readString(structured, 'agentId'),
        status,
        subtitle:
          latestAssistantText(transcript) ?? extractStructuredText(structured),
        transcript,
        ...(durationMs || toolUseCount || totalTokens
          ? { detailStats: { durationMs, toolUseCount, totalTokens } }
          : {}),
      })
    }
  }
  return presentations
}

type CodexAgentState = { status?: string; message?: string }

const readCodexAgentStates = (
  response: ToolCallResponse,
): Array<[string, CodexAgentState]> => {
  const states =
    responseStructuredResult(response)?.agentsStates ??
    responseTextRecord(response)?.agentsStates ??
    responseTextRecord(response)
  const record = asRecord(states)
  if (!record) return []
  return Object.entries(record).flatMap(([threadId, value]) => {
    const state = asRecord(value)
    if (!state) return []
    return [
      [
        threadId,
        {
          ...(typeof state.status === 'string' ? { status: state.status } : {}),
          ...(typeof state.message === 'string'
            ? { message: state.message }
            : {}),
        },
      ] as [string, CodexAgentState],
    ]
  })
}

const mapCodexAgentStatus = (
  state: CodexAgentState | undefined,
  response: ToolCallResponse,
): SubagentDisplayStatus => {
  switch (state?.status) {
    case 'pendingInit':
    case 'running':
      return 'running'
    case 'completed':
      return 'success'
    case 'errored':
    case 'notFound':
      return 'error'
    case 'interrupted':
    case 'shutdown':
      return 'aborted'
    default:
      return response.status === ToolCallResponseStatus.Success
        ? 'dispatched'
        : toBaseStatus(response)
  }
}

const compactPromptTitle = (prompt: string | undefined): string | undefined => {
  const compact = prompt?.replace(/\s+/g, ' ').trim()
  if (!compact) return undefined
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact
}

const buildCodexPresentations = (
  messages: readonly ChatMessage[],
): Map<string, CliSubagentPresentation> => {
  const responses = collectResponses(messages)
  const latestStates = new Map<string, CodexAgentState>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const { response } of message.toolCalls) {
      for (const [threadId, state] of readCodexAgentStates(response)) {
        latestStates.set(threadId, state)
      }
    }
  }

  const presentations = new Map<string, CliSubagentPresentation>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const request of message.toolCallRequests ?? []) {
      const metadata = request.metadata?.cliToolCall
      if (
        metadata?.runtimeId !== 'codex' ||
        metadata.eventType !== 'collabAgentToolCall' ||
        metadata.name !== 'spawnAgent'
      ) {
        continue
      }
      const args = getToolCallArgumentsObject(request.arguments) ?? {}
      const receiverThreadIds = Array.isArray(args.receiverThreadIds)
        ? args.receiverThreadIds.filter(
            (value): value is string => typeof value === 'string',
          )
        : []
      const taskId = receiverThreadIds[0]
      const response = responses.get(request.id) ?? {
        status: ToolCallResponseStatus.Running,
      }
      const state = taskId ? latestStates.get(taskId) : undefined
      const prompt = typeof args.prompt === 'string' ? args.prompt : undefined
      presentations.set(request.id, {
        toolCallId: request.id,
        runtimeId: 'codex',
        title: compactPromptTitle(prompt),
        prompt,
        modelName: typeof args.model === 'string' ? args.model : undefined,
        taskId,
        status: mapCodexAgentStatus(state, response),
        subtitle: state?.message,
        transcript: [],
      })
    }
  }
  return presentations
}

export const buildCliSubagentReadModel = (
  messages: readonly ChatMessage[],
  runtimeId: CliRuntimeId,
): CliSubagentReadModel => {
  if (runtimeId === 'claude-code') {
    const { visibleMessages, transcriptByParentCallId } =
      splitClaudeChildActivity(messages)
    return {
      visibleMessages,
      presentationsByToolCallId: buildClaudePresentations(
        visibleMessages,
        transcriptByParentCallId,
      ),
    }
  }
  return {
    visibleMessages: [...messages],
    presentationsByToolCallId: buildCodexPresentations(messages),
  }
}
