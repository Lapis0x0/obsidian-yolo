import type {
  LearningGenerationAgentEvent,
  LearningGenerationHost,
} from './host'

export type ToolCallRecord = {
  name: string
  status: string
  arguments?: Record<string, unknown>
}

export type CollectorResult = {
  startedAt: number
  completedAt: number
  toolCalls: ToolCallRecord[]
}

export type PhaseDebugData = {
  label: string
  startedAt: number
  completedAt: number
  toolCalls: ToolCallRecord[]
  outputLength: number
  output: string
  meta: Record<string, string>
}

export type ChapterDebugData = {
  chapterIndex: number
  chapterTitle: string
  startedAt: number
  completedAt: number
  toolCalls: ToolCallRecord[]
  outputLength: number
  output: string
  count: number
}

/** Collects tool-call events from an agent stream for debug logging. */
export class PhaseDebugCollector {
  private readonly startedAt = Date.now()
  private readonly toolCalls: ToolCallRecord[] = []

  recordToolCall(event: LearningGenerationAgentEvent & { type: 'tool' }): void {
    if (event.status !== 'completed' && event.status !== 'error') return
    this.toolCalls.push({
      name: event.name,
      status: event.status,
      ...(event.arguments ? { arguments: event.arguments } : {}),
    })
  }

  finalize(): CollectorResult {
    return {
      startedAt: this.startedAt,
      completedAt: Date.now(),
      toolCalls: this.toolCalls,
    }
  }
}

export function emitPhaseDebugLog(
  host: LearningGenerationHost,
  data: PhaseDebugData,
): void {
  if (!host.isDebugEnabled()) return
  const durationStr = `${((data.completedAt - data.startedAt) / 1000).toFixed(1)}s`
  const metaParts = Object.entries(data.meta).map(
    ([key, value]) => `${key}: ${value}`,
  )
  metaParts.push(`duration: ${durationStr}`)
  // eslint-disable-next-line no-console -- Preserve grouped learning diagnostics when debug capture is enabled.
  console.groupCollapsed(
    `[yolo-learning] ${data.label} completed  ${metaParts.join(', ')}`,
  )
  if (data.toolCalls.length > 0) {
    console.debug(`tool-calls (${data.toolCalls.length}):`)
    data.toolCalls.forEach((tc, index) =>
      console.debug(
        `  #${index + 1} ${tc.name}  ${formatToolCallArgs(tc)}  ${tc.status}`,
      ),
    )
  }
  console.debug(`output length: ${data.outputLength}`)
  console.debug('output:')
  console.debug(data.output)
  // eslint-disable-next-line no-console -- Close the grouped learning diagnostics above.
  console.groupEnd()
}

export function emitChaptersDebugLog(
  host: LearningGenerationHost,
  chapters: ChapterDebugData[],
  phaseLabel = 'kp-generator',
  countLabel = 'pts',
): void {
  if (!host.isDebugEnabled() || chapters.length === 0) return
  const sorted = [...chapters].sort((a, b) => a.chapterIndex - b.chapterIndex)
  const totalDuration = sorted.reduce(
    (sum, ch) => sum + ch.completedAt - ch.startedAt,
    0,
  )
  const totalCalls = sorted.reduce((sum, ch) => sum + ch.toolCalls.length, 0)
  const totalCount = sorted.reduce((sum, ch) => sum + ch.count, 0)
  // eslint-disable-next-line no-console -- Preserve grouped learning diagnostics when debug capture is enabled.
  console.groupCollapsed(
    `[yolo-learning] ${phaseLabel} completed (${sorted.length} chapters, ${(totalDuration / 1000).toFixed(1)}s, ${totalCalls} calls, ${totalCount} ${countLabel})`,
  )
  for (const ch of sorted) {
    const durationStr = `${((ch.completedAt - ch.startedAt) / 1000).toFixed(1)}s`
    // eslint-disable-next-line no-console -- Group each chapter under the aggregate diagnostics.
    console.groupCollapsed(
      `ch${ch.chapterIndex} "${ch.chapterTitle}"  ${durationStr}  ${ch.toolCalls.length} call  ${ch.count} ${countLabel}  ${ch.outputLength}c`,
    )
    if (ch.toolCalls.length > 0) {
      console.debug(`tool-calls (${ch.toolCalls.length}):`)
      ch.toolCalls.forEach((tc, index) =>
        console.debug(
          `  #${index + 1} ${tc.name}  ${formatToolCallArgs(tc)}  ${tc.status}`,
        ),
      )
    }
    console.debug('output:')
    console.debug(ch.output)
    // eslint-disable-next-line no-console -- Close the chapter diagnostics group above.
    console.groupEnd()
  }
  // eslint-disable-next-line no-console -- Close the aggregate learning diagnostics group above.
  console.groupEnd()
}

function formatToolCallArgs(tc: ToolCallRecord): string {
  if (!tc.arguments) return ''
  const parts: string[] = []
  const args = tc.arguments
  if (typeof args.path === 'string') parts.push(`path="${args.path}"`)
  if (typeof args.page === 'number') parts.push(`page=${args.page}`)
  if (typeof args.startLine === 'number' && typeof args.endLine === 'number') {
    parts.push(`lines=${args.startLine}-${args.endLine}`)
  } else if (typeof args.startLine === 'number') {
    parts.push(`startLine=${args.startLine}`)
  }
  return parts.join('  ')
}
