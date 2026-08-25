import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@yolo/claude-agent-sdk-runtime'

import { AsyncPushQueue } from '../../cli-runtime/claude/asyncQueue'
import type {
  ClaudeProcessSupport,
  ClaudeSdkModule,
  ClaudeSdkQuery,
} from '../../cli-runtime/claude/types'

/**
 * Construct an SDK query with an abort controller the Node realm accepts.
 *
 * The SDK creates one additional controller synchronously for its
 * forwarded-abort channel. In Electron's renderer the ambient
 * `AbortController` belongs to Chromium and `node:events` rejects its signal,
 * so the global is swapped for the duration of construction — exactly as
 * `ClaudeCliRuntime.startSession` does.
 */
export const constructWithNodeRealmAbort = <T>(
  processSupport: ClaudeProcessSupport,
  construct: () => T,
): T => {
  const originalAbortController = globalThis.AbortController
  const NodeRealmAbortController = class {
    private readonly controller = processSupport.createAbortController()
    readonly signal = this.controller.signal

    abort(reason?: unknown): void {
      this.controller.abort(reason)
    }
  }
  try {
    globalThis.AbortController =
      NodeRealmAbortController as unknown as typeof AbortController
    return construct()
  } finally {
    globalThis.AbortController = originalAbortController
  }
}

/**
 * One Claude Code subprocess, kept alive across turns.
 *
 * `query({ prompt: 'text' })` spawns a process, runs one turn and exits, which
 * costs a subprocess spawn before the first token of every message. Passing an
 * async iterable as the prompt instead puts the CLI in streaming-input mode:
 * the process stays up and each turn is dispatched into a session that is
 * already warm.
 *
 * The price is memory — an idle session holds its resident set and does not
 * shrink — so sessions are not meant to be immortal. `ClaudeSdkSessionPool`
 * closes one after its conversation has been quiet for a while and opens a new
 * one on the next turn, resuming by session id.
 *
 * Everything here assumes turns are serialized per session, which the pool
 * guarantees. Two overlapping `turn()` calls would interleave their messages,
 * because there is one output stream and nothing on a message says which
 * prompt it answers.
 */
export class ClaudeLiveSession {
  /**
   * The SDK session this process is on. Set at spawn from `resume`, then kept
   * in step with what the CLI reports, so the pool can tell a reusable session
   * from one a fork has moved on from.
   */
  sessionId: string | undefined
  /** Last value pushed through a control request, so only changes are sent. */
  model: string | undefined
  /** See `ClaudeSessionSpec.startupFingerprint`. */
  readonly startupFingerprint: string

  private readonly query: ClaudeSdkQuery
  private readonly iterator: AsyncIterator<SDKMessage>
  private readonly input = new AsyncPushQueue<SDKUserMessage>()
  private isDead = false

  private constructor(args: {
    sdk: ClaudeSdkModule
    processSupport: ClaudeProcessSupport
    options: Options
    sessionId: string | undefined
    model: string | undefined
    startupFingerprint: string
  }) {
    this.sessionId = args.sessionId
    this.model = args.model
    this.startupFingerprint = args.startupFingerprint
    // The SDK would create this itself, but only the transport's own creation
    // is covered by the substitution below; handing it one built in Node's
    // realm keeps that guarantee independent of when the transport spawns.
    const abortController = args.processSupport.createAbortController()

    this.query = constructWithNodeRealmAbort(args.processSupport, () =>
      args.sdk.query({
        prompt: this.input,
        options: { ...args.options, abortController },
      }),
    )
    this.iterator = this.query[Symbol.asyncIterator]()
  }

  static start(args: {
    sdk: ClaudeSdkModule
    processSupport: ClaudeProcessSupport
    options: Options
    sessionId: string | undefined
    model: string | undefined
    startupFingerprint: string
  }): ClaudeLiveSession {
    return new ClaudeLiveSession(args)
  }

  /** True once the process has gone; the session must be replaced, not reused. */
  get dead(): boolean {
    return this.isDead
  }

  /**
   * Run one turn: push the prompt, then yield messages up to and including the
   * `result` that closes it.
   *
   * One message and one turn — the CLI runs a turn per message it reads, so a
   * second message would mean a second model call.
   */
  async *turn(content: MessageParam['content']): AsyncGenerator<SDKMessage> {
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage)

    for (;;) {
      let next: IteratorResult<SDKMessage>
      try {
        next = await this.iterator.next()
      } catch (error) {
        this.isDead = true
        throw error
      }
      // The stream ending mid-turn means the process is gone. Not an error we
      // can report from here; the caller sees a turn with no result message.
      if (next.done) {
        this.isDead = true
        return
      }
      yield next.value
      if (next.value.type === 'result') return
    }
  }

  /** Switch models mid-session. Cheap: no respawn, no lost conversation. */
  async setModel(model: string): Promise<void> {
    await this.query.setModel(model)
    this.model = model
  }

  /**
   * Stop the model without killing the process. The whole point of a live
   * session is that stopping costs a turn, not a respawn.
   */
  async interrupt(): Promise<void> {
    await this.query.interrupt()
  }

  /**
   * End the input stream, which lets the CLI exit on its own terms.
   *
   * Deliberately does not abort the controller. The SDK's transport reacts to
   * an abort by running its close path synchronously inside the signal's
   * dispatch, and that path calls `setTimeout(...).unref()` — Node's timer
   * API, which the renderer realm's `setTimeout` does not have. Thrown from an
   * event listener there is nothing to catch it, so it takes the window down.
   * Through `query.close()` the same path runs inside the SDK's own
   * try/catch instead, and ending the input is what actually stops the process.
   */
  close(): void {
    this.isDead = true
    this.input.close()
    this.query.close()
  }
}
