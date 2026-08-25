import type { SDKMessage } from '@yolo/claude-agent-sdk-runtime'

import type {
  LLMResponseStreaming,
  ProviderExecutedToolCall,
  ResponseUsage,
} from '../../../types/llm/response'

/**
 * Facts about the turn that are not part of the response stream but that the
 * caller has to record: where the native session ended up, and how it closed.
 */
export type ClaudeTurnObservation = {
  sessionId?: string
  /**
   * Uuid of the last transcript entry this turn produced — the anchor a later
   * branch forks from. See `ProviderSession.anchors`.
   */
  lastUuid?: string
  finishReason?: string | null
  /** Set when the turn ended in an error the CLI reported rather than threw. */
  error?: string
}

const toResponseUsage = (usage: {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}): ResponseUsage => {
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheCreation = usage.cache_creation_input_tokens ?? 0
  const promptTokens = (usage.input_tokens ?? 0) + cacheRead + cacheCreation
  const completionTokens = usage.output_tokens ?? 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreation > 0
      ? { cache_creation_input_tokens: cacheCreation }
      : {}),
  }
}

/**
 * Turns one Claude Agent SDK turn into YOLO's streaming response shape.
 *
 * The SDK runs its own agent loop, so the tools it calls are work already
 * done, not work for YOLO to do. They travel as `providerToolRun` receipts and
 * never as `tool_calls`, which would make YOLO's tool gateway execute them a
 * second time.
 *
 * One SDK assistant message that calls tools is one run. Runs are what give
 * the answer its shape: text, then a run, then more text. Emitting them
 * positionally is what lets the conversation keep that order — see
 * `providerToolRun`.
 *
 * Stateful across one turn: it tracks the runs it has emitted so a later
 * `tool_result` can complete the matching call, and whether token-level deltas
 * arrived so the complete assistant message is not replayed as duplicate text.
 */
export class ClaudeTurnMapper {
  readonly observation: ClaudeTurnObservation = {}

  /** Tool runs in the order the SDK opened them. */
  private readonly runs: ProviderExecutedToolCall[][] = []
  private readonly runIndexByToolId = new Map<string, number>()
  /**
   * Set once a token-level delta arrives, which only happens under
   * `includePartialMessages`. From then on the complete assistant message
   * would duplicate text already streamed, so its text blocks are skipped.
   * Decided from the stream rather than from the flag, so the mapper stays
   * correct either way.
   */
  private streamingText = false

  constructor(
    private readonly id: string,
    private readonly model: string,
  ) {}

  map(message: SDKMessage): LLMResponseStreaming | null {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init')
          this.observation.sessionId = message.session_id
        return null

      case 'stream_event': {
        // Subagents get their own nested stream; splicing it into the answer
        // would bury it under a transcript of somebody else's work.
        if (message.parent_tool_use_id !== null) return null
        const event = message.event
        if (event.type !== 'content_block_delta') return null
        if (event.delta.type === 'text_delta') {
          if (event.delta.text.length === 0) return null
          this.streamingText = true
          return this.chunk({ content: event.delta.text })
        }
        if (event.delta.type === 'thinking_delta') {
          if (event.delta.thinking.length === 0) return null
          return this.chunk({ reasoning: event.delta.thinking })
        }
        return null
      }

      case 'assistant': {
        if (message.parent_tool_use_id !== null) return null
        this.observation.lastUuid = message.uuid
        // One SDK assistant message is one API call, and its usage is that
        // call's alone. Reporting it here is what makes YOLO's per-call
        // accounting — the call count, the breakdown, and above all "context
        // used", which reads the last call's input — describe the run. The
        // run total on the `result` message is the sum of these; letting that
        // sum stand in for a single call would inflate the context reading by
        // however many steps the SDK took.
        const usage = toResponseUsage(message.message.usage)
        let content = ''
        const run: ProviderExecutedToolCall[] = []
        for (const block of message.message.content) {
          if (block.type === 'text') {
            if (this.streamingText) continue
            content += block.text
          } else if (block.type === 'tool_use') {
            this.runIndexByToolId.set(block.id, this.runs.length)
            run.push({
              id: block.id,
              name: block.name,
              input: (block.input ?? undefined) as
                | Record<string, unknown>
                | undefined,
              status: 'running',
            })
          }
        }
        if (run.length > 0) this.runs.push(run)
        if (content.length === 0 && run.length === 0) return null
        return this.chunk(
          {
            ...(content.length > 0 ? { content } : {}),
            ...(run.length > 0 ? { providerToolRun: [...run] } : {}),
          },
          null,
          usage,
        )
      }

      case 'user': {
        // Tool results come back as a user message the SDK synthesised for its
        // own loop. Completing the matching receipt is the only reason to look
        // at it — its text is not part of the answer.
        if (message.parent_tool_use_id !== null) return null
        this.observation.lastUuid = message.uuid
        const blocks = message.message.content
        if (!Array.isArray(blocks)) return null
        // The SDK answers one assistant message's tool calls at a time, so
        // every result here belongs to the same run.
        let completedRunIndex: number | undefined
        for (const block of blocks) {
          if (block.type !== 'tool_result') continue
          const runIndex = this.runIndexByToolId.get(block.tool_use_id)
          if (runIndex === undefined) continue
          const run = this.runs[runIndex]
          const callIndex = run.findIndex(
            (call) => call.id === block.tool_use_id,
          )
          if (callIndex < 0) continue
          run[callIndex] = {
            ...run[callIndex],
            status: block.is_error ? 'error' : 'success',
            ...(typeof block.content === 'string' && block.content.length > 0
              ? { resultText: block.content }
              : {}),
          }
          completedRunIndex = runIndex
        }
        if (completedRunIndex === undefined) return null
        return this.chunk({
          providerToolRun: [...this.runs[completedRunIndex]],
        })
      }

      case 'result': {
        this.observation.sessionId = message.session_id
        this.observation.lastUuid = message.uuid
        // No usage here on purpose: `message.usage` is the run's total, and
        // the assistant messages above have already reported the calls it is
        // the sum of.
        if (message.subtype === 'success') {
          this.observation.finishReason = message.stop_reason ?? 'stop'
        } else {
          this.observation.finishReason = 'stop'
          this.observation.error = `Claude Code run ended: ${message.subtype}`
        }
        return this.chunk({}, this.observation.finishReason ?? 'stop')
      }

      default:
        return null
    }
  }

  private chunk(
    delta: LLMResponseStreaming['choices'][number]['delta'],
    finishReason: string | null = null,
    usage?: ResponseUsage,
  ): LLMResponseStreaming {
    return {
      id: this.id,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{ finish_reason: finishReason, delta }],
      ...(usage ? { usage } : {}),
    }
  }
}
