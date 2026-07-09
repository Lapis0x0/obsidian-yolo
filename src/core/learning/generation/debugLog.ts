import { isLLMDebugCaptureEnabled } from '../../llm/debugCapture'

import type { YoloAgentEvent } from '../../agent/agent-api'

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
  pointCount: number
}

/**
 * Collects tool-call events from an agent stream for debug logging.
 * Only active when `captureRawRequestDebug` is enabled.
 */
export class PhaseDebugCollector {
  private readonly startedAt: number
  private readonly toolCalls: ToolCallRecord[] = []

  constructor() {
    this.startedAt = Date.now()
  }

  recordToolCall(event: YoloAgentEvent & { type: 'tool' }): void {
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

export function emitPhaseDebugLog(data: PhaseDebugData): void {
  if (!isLLMDebugCaptureEnabled()) return

  const durationMs = data.completedAt - data.startedAt
  const durationStr = `${(durationMs / 1000).toFixed(1)}s`
  const lines: string[] = []

  lines.push(`${data.label} completed`)
  const metaParts = Object.entries(data.meta).map(
    ([key, value]) => `${key}: ${value}`,
  )
  metaParts.push(`duration: ${durationStr}`)
  lines.push(`  ${metaParts.join(', ')}`)

  if (data.toolCalls.length > 0) {
    lines.push(`  tool-calls (${data.toolCalls.length}):`)
    for (let i = 0; i < data.toolCalls.length; i += 1) {
      const tc = data.toolCalls[i]
      const argStr = formatToolCallArgs(tc)
      lines.push(`    #${i + 1} ${tc.name}  ${argStr}  ${tc.status}`)
    }
  }

  lines.push(`  output length: ${data.outputLength}`)
  lines.push('  output:')
  for (const line of data.output.split('\n')) {
    lines.push(`    ${line}`)
  }

  console.debug(`[yolo-learning] ${lines.join('\n')}`)
}

export function emitChaptersDebugLog(chapters: ChapterDebugData[]): void {
  if (!isLLMDebugCaptureEnabled()) return
  if (chapters.length === 0) return

  const sorted = [...chapters].sort((a, b) => a.chapterIndex - b.chapterIndex)
  const lines: string[] = []
  lines.push(`kp-generator completed (${sorted.length} chapters)`)

  for (const ch of sorted) {
    const durationStr = `${((ch.completedAt - ch.startedAt) / 1000).toFixed(1)}s`
    lines.push(
      `  ch${ch.chapterIndex} "${ch.chapterTitle}"  ${durationStr}  ${ch.toolCalls.length} call  ${ch.pointCount} pts  ${ch.outputLength}c`,
    )
  }

  const allToolCalls = sorted.flatMap((ch) =>
    ch.toolCalls.map((tc) => ({ ...tc, chapterIndex: ch.chapterIndex })),
  )
  if (allToolCalls.length > 0) {
    lines.push(`  tool-calls (${allToolCalls.length}):`)
    for (const tc of allToolCalls) {
      const argStr = formatToolCallArgs(tc)
      lines.push(
        `    ch${tc.chapterIndex}: ${tc.name}  ${argStr}  ${tc.status}`,
      )
    }
  }

  for (const ch of sorted) {
    lines.push(`  output ch${ch.chapterIndex}:`)
    for (const line of ch.output.split('\n')) {
      lines.push(`    ${line}`)
    }
  }

  console.debug(`[yolo-learning] ${lines.join('\n')}`)
}

function formatToolCallArgs(tc: ToolCallRecord): string {
  if (!tc.arguments) return ''

  const parts: string[] = []
  const args = tc.arguments

  if (typeof args.path === 'string') {
    parts.push(`path="${args.path}"`)
  }
  if (typeof args.page === 'number') {
    parts.push(`page=${args.page}`)
  }
  if (
    typeof args.startLine === 'number' &&
    typeof args.endLine === 'number'
  ) {
    parts.push(`lines=${args.startLine}-${args.endLine}`)
  } else if (typeof args.startLine === 'number') {
    parts.push(`startLine=${args.startLine}`)
  }

  return parts.length > 0 ? parts.join('  ') : ''
}
