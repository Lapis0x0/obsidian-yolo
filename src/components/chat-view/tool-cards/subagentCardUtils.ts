import type { LiveTaskViewSnapshot } from '../../../hooks/useLiveTaskStream'
import type {
  ChatSubagentResultMessage,
  SubagentResultStatus,
} from '../../../types/chat'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'
import { formatTokenCount } from '../../../utils/llm/formatTokenCount'

export type SubagentCardArgs = {
  title?: string
}

export function parseAcceptedSubagentResponse(response: ToolCallResponse): {
  taskId?: string
  modelName?: string
  title?: string
} {
  if (response.status !== ToolCallResponseStatus.Success) {
    return {}
  }
  try {
    const parsed = JSON.parse(response.data.text) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    return {
      taskId: typeof record.taskId === 'string' ? record.taskId : undefined,
      modelName:
        typeof record.modelName === 'string' ? record.modelName : undefined,
      title: typeof record.title === 'string' ? record.title : undefined,
    }
  } catch {
    return {}
  }
}

export function mapSubagentResultStatus(
  status: SubagentResultStatus,
): ToolCallResponseStatus {
  switch (status) {
    case 'completed':
      return ToolCallResponseStatus.Success
    case 'aborted':
      return ToolCallResponseStatus.Aborted
    case 'failed':
    default:
      return ToolCallResponseStatus.Error
  }
}

export function resolveSubagentEffectiveStatus({
  subagentResult,
  stream,
  response,
}: {
  subagentResult?: ChatSubagentResultMessage
  stream: LiveTaskViewSnapshot | null
  response: ToolCallResponse
}): ToolCallResponseStatus {
  if (subagentResult) {
    return mapSubagentResultStatus(subagentResult.status)
  }
  if (stream?.source === 'live') {
    if (stream.status === 'starting' || stream.status === 'running') {
      return ToolCallResponseStatus.Running
    }
    if (response.status === ToolCallResponseStatus.Error) {
      return ToolCallResponseStatus.Error
    }
    if (response.status === ToolCallResponseStatus.Aborted) {
      return ToolCallResponseStatus.Aborted
    }
    return ToolCallResponseStatus.Success
  }
  return response.status
}

export function collectSubagentActivityText({
  subagentResult,
  stream,
  initialStderr,
  initialStdout,
  fallbackError,
}: {
  subagentResult?: ChatSubagentResultMessage
  stream: LiveTaskViewSnapshot | null
  initialStderr?: string
  initialStdout?: string
  fallbackError?: string
}): string {
  if (subagentResult?.activityLog) {
    return subagentResult.activityLog
  }
  if (stream !== null) {
    return [stream.stderr, stream.stdout, fallbackError]
      .filter((text): text is string => Boolean(text))
      .join('\n')
  }
  return [initialStderr, initialStdout, fallbackError]
    .filter((text): text is string => Boolean(text))
    .join('\n')
}

export function normalizeActivityLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function formatSubagentActivityLine(line: string): string {
  const toolMatch = line.match(/^\[tool\]\s+(.+?)\s+(running|success|error)$/i)
  if (toolMatch) {
    const [, toolName, status] = toolMatch
    if (status.toLowerCase() === 'running') {
      return toolName
    }
    return `${toolName} · ${status.toLowerCase()}`
  }
  if (line.startsWith('[state]')) {
    return line.slice('[state]'.length).trim()
  }
  if (line.startsWith('[error]')) {
    return line.slice('[error]'.length).trim()
  }
  return line
}

export function getLatestActivityLine(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.startsWith('[state] completed')) continue
    return formatSubagentActivityLine(line)
  }
  return undefined
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes}m${rest}s`
}

export function buildSubagentCompletionSummary({
  subagentResult,
  t,
}: {
  subagentResult: ChatSubagentResultMessage
  t: (key: string, fallback?: string) => string
}): string {
  const parts: string[] = []
  switch (subagentResult.status) {
    case 'completed':
      parts.push(t('chat.subagent.statusCompleted', 'Completed'))
      break
    case 'aborted':
      parts.push(t('chat.subagent.statusAborted', 'Aborted'))
      break
    case 'failed':
      parts.push(t('chat.subagent.statusFailed', 'Failed'))
      break
  }
  if (subagentResult.toolUseCount > 0) {
    parts.push(
      t('chat.subagent.toolUseCount', '{count} tools').replace(
        '{count}',
        String(subagentResult.toolUseCount),
      ),
    )
  }
  if (subagentResult.durationMs > 0) {
    parts.push(formatDuration(subagentResult.durationMs))
  }
  if (subagentResult.usage && subagentResult.usage.total_tokens > 0) {
    parts.push(
      t('chat.subagent.tokenCount', '{count} tokens').replace(
        '{count}',
        formatTokenCount(subagentResult.usage.total_tokens),
      ),
    )
  }
  return parts.join(' · ')
}
