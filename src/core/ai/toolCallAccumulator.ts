import { ToolCallDelta } from '../../types/llm/response'
import {
  type ToolCallArguments,
  createCompleteToolCallArguments,
  createPartialToolCallArguments,
} from '../../types/tool-call.types'
import { parseJsonObjectText } from '../../utils/chat/tool-arguments'

export type CanonicalToolEvent =
  | {
      type: 'call.start'
      turnKey: string
      callKey: string
      index: number
      provider: string
      receivedAt: number
      id?: string
      metadata?: {
        thoughtSignature?: string
      }
    }
  | {
      type: 'call.name.set'
      turnKey: string
      callKey: string
      toolName: string
      receivedAt: number
    }
  | {
      type: 'call.args.append'
      turnKey: string
      callKey: string
      chunk: string
      receivedAt: number
    }
  | {
      type: 'call.seal'
      turnKey: string
      callKey: string
      reason: 'explicit_done' | 'stream_end' | 'turn_handoff'
      receivedAt: number
    }
  | {
      type: 'turn.handoff'
      turnKey: string
      reason: 'tool_calls_finish' | 'stream_end'
      receivedAt: number
    }

type AssemblyKind = 'none' | 'append_text'
type StreamState = 'open' | 'sealed' | 'aborted'
type ParseState = 'not_attempted' | 'valid' | 'invalid'
type ExecState = 'blocked' | 'ready' | 'running' | 'done' | 'failed'

type ToolCallRecord = {
  turnKey: string
  callKey: string
  index: number
  provider: string
  id?: string
  metadata?: {
    thoughtSignature?: string
  }
  toolName?: string
  assemblyKind: AssemblyKind
  rawArgsText: string
  parsedArgs?: Record<string, unknown>
  parseError?: string
  streamState: StreamState
  parseState: ParseState
  execState: ExecState
  handoffReady: boolean
  sealReason?: 'explicit_done' | 'stream_end' | 'turn_handoff'
  createdAt: number
  updatedAt: number
}

export type AccumulatedToolCallSnapshot = {
  index: number
  id?: string
  metadata?: {
    thoughtSignature?: string
  }
  function?: {
    name?: string
    arguments?: ToolCallArguments
  }
  streamState: StreamState
  parseState: ParseState
  handoffReady: boolean
}

const getCallKey = (index: number): string => `index:${index}`

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const createRecord = (
  event: Extract<CanonicalToolEvent, { type: 'call.start' }>,
): ToolCallRecord => ({
  turnKey: event.turnKey,
  callKey: event.callKey,
  index: event.index,
  provider: event.provider,
  id: event.id,
  metadata: event.metadata,
  assemblyKind: 'none',
  rawArgsText: '',
  streamState: 'open',
  parseState: 'not_attempted',
  execState: 'blocked',
  handoffReady: false,
  createdAt: event.receivedAt,
  updatedAt: event.receivedAt,
})

const finalizeParse = (record: ToolCallRecord): void => {
  if (record.assemblyKind === 'none') {
    record.parseState = 'not_attempted'
    record.execState = 'blocked'
    return
  }

  const parsed = parseJsonObjectText(record.rawArgsText)
  if (parsed) {
    record.parsedArgs = parsed
    record.parseError = undefined
    record.parseState = 'valid'
    return
  }

  record.parsedArgs = undefined
  record.parseError = 'Invalid JSON object'
  record.parseState = 'invalid'
  record.execState = 'blocked'
}

export class ToolCallAccumulator {
  private readonly turnKey: string
  private readonly records = new Map<string, ToolCallRecord>()

  constructor(turnKey: string) {
    this.turnKey = turnKey
  }

  apply(event: CanonicalToolEvent): void {
    if (event.type === 'turn.handoff') {
      if (event.turnKey !== this.turnKey) {
        return
      }
      for (const record of this.records.values()) {
        if (record.streamState === 'sealed' && record.parseState === 'valid') {
          record.handoffReady = true
          record.execState = 'ready'
          record.updatedAt = event.receivedAt
        }
      }
      return
    }

    if (event.turnKey !== this.turnKey) {
      return
    }

    if (event.type === 'call.start') {
      const existing = this.records.get(event.callKey)
      if (!existing) {
        this.records.set(event.callKey, createRecord(event))
        return
      }
      existing.id ??= event.id
      existing.metadata ??= event.metadata
      existing.updatedAt = event.receivedAt
      return
    }

    const record = this.records.get(event.callKey)
    if (!record) {
      return
    }

    if (event.type === 'call.name.set') {
      if (record.streamState === 'sealed') {
        return
      }
      record.toolName = event.toolName
      record.updatedAt = event.receivedAt
      return
    }

    if (event.type === 'call.args.append') {
      if (record.streamState === 'sealed' || record.streamState === 'aborted') {
        return
      }
      record.assemblyKind = 'append_text'
      record.rawArgsText += event.chunk
      record.updatedAt = event.receivedAt
      return
    }

    if (event.type === 'call.seal') {
      if (record.streamState !== 'open') {
        return
      }
      record.streamState = 'sealed'
      record.sealReason = event.reason
      finalizeParse(record)
      record.updatedAt = event.receivedAt
    }
  }

  applyAll(events: CanonicalToolEvent[]): void {
    for (const event of events) {
      this.apply(event)
    }
  }

  sealOpenCalls(
    reason: Extract<CanonicalToolEvent, { type: 'call.seal' }>['reason'],
    receivedAt: number,
  ): void {
    for (const record of this.records.values()) {
      if (record.streamState !== 'open') {
        continue
      }
      this.apply({
        type: 'call.seal',
        turnKey: this.turnKey,
        callKey: record.callKey,
        reason,
        receivedAt,
      })
    }
  }

  handoff(
    reason: Extract<CanonicalToolEvent, { type: 'turn.handoff' }>['reason'],
    receivedAt: number,
  ): void {
    this.apply({
      type: 'turn.handoff',
      turnKey: this.turnKey,
      reason,
      receivedAt,
    })
  }

  getSnapshots(): AccumulatedToolCallSnapshot[] {
    return Array.from(this.records.values())
      .sort((a, b) => a.index - b.index)
      .map((record) => ({
        index: record.index,
        id: record.id,
        metadata: record.metadata,
        function:
          record.toolName || record.rawArgsText
            ? {
                name: record.toolName,
                arguments: this.toToolCallArguments(record),
              }
            : undefined,
        streamState: record.streamState,
        parseState: record.parseState,
        handoffReady: record.handoffReady,
      }))
  }

  private toToolCallArguments(
    record: ToolCallRecord,
  ): ToolCallArguments | undefined {
    if (record.streamState === 'sealed') {
      if (record.parseState !== 'valid' || !isRecord(record.parsedArgs)) {
        return undefined
      }
      return createCompleteToolCallArguments({
        value: record.parsedArgs,
        rawText: record.rawArgsText,
      })
    }

    if (record.rawArgsText.length === 0) {
      return undefined
    }

    return createPartialToolCallArguments(record.rawArgsText)
  }
}

export const createCanonicalToolEventsFromDeltas = ({
  turnKey,
  provider,
  deltas,
  receivedAt,
}: {
  turnKey: string
  provider: string
  deltas: ToolCallDelta[]
  receivedAt: number
}): CanonicalToolEvent[] => {
  const events: CanonicalToolEvent[] = []

  for (const delta of deltas) {
    const callKey = getCallKey(delta.index)

    events.push({
      type: 'call.start',
      turnKey,
      callKey,
      index: delta.index,
      provider,
      id: delta.id,
      metadata: delta.metadata,
      receivedAt,
    })

    const toolName = delta.function?.name?.trim()
    if (toolName) {
      events.push({
        type: 'call.name.set',
        turnKey,
        callKey,
        toolName,
        receivedAt,
      })
    }

    if (typeof delta.function?.arguments === 'string') {
      events.push({
        type: 'call.args.append',
        turnKey,
        callKey,
        chunk: delta.function.arguments,
        receivedAt,
      })
    }
  }

  return events
}
