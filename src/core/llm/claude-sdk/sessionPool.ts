import type { Options } from '@yolo/claude-agent-sdk-runtime'

import type {
  ClaudeProcessSupport,
  ClaudeSdkModule,
} from '../../cli-runtime/claude/types'

import { ClaudeLiveSession } from './liveSession'

/**
 * How long a session stays warm after its turn ends.
 *
 * A warm subprocess holds a large resident set that never shrinks, so it is
 * only worth keeping for as long as the person is plausibly still in the
 * conversation. Past that, the next turn pays a spawn and resumes by session
 * id — slower, never wrong.
 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * How many subprocesses may be warm at once.
 *
 * One, deliberately. Only one conversation is being typed into at a time, and
 * a second warm session would cost as much memory again to save a spawn on a
 * conversation the user has already left. Switching conversations evicts the
 * previous session; the next turn there resumes by session id.
 */
const MAX_LIVE_SESSIONS = 1

export type ClaudeSessionSpec = {
  /** Identifies the conversation this session belongs to. */
  key: string
  /** Session id to resume, or `undefined` to open a new session. */
  resume?: string
  /**
   * Fork the resumed session at this transcript entry instead of continuing
   * it. Set when the conversation branched — an edited or regenerated
   * message — so the native transcript follows YOLO's history instead of
   * staying on the branch it was already on.
   */
  resumeAt?: string
  model?: string
  /**
   * Fingerprint of the session-start options that cannot be changed by a
   * control request — the system prompt and the tool/permission policy. A
   * change means the session has to be rebuilt, resuming the same id in place
   * so no history is lost.
   */
  startupFingerprint: string
}

/**
 * Keeps at most one Claude Code subprocess warm, keyed by conversation.
 *
 * Module-level rather than per-provider: provider clients are rebuilt whenever
 * settings change, and a subprocess must outlive that or every settings edit
 * would cost the user a respawn.
 */
class ClaudeSdkSessionPool {
  private live = new Map<string, ClaudeLiveSession>()
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  async acquire(args: {
    sdk: ClaudeSdkModule
    processSupport: ClaudeProcessSupport
    spec: ClaudeSessionSpec
    buildOptions: (spec: ClaudeSessionSpec) => Options
  }): Promise<ClaudeLiveSession> {
    const { spec } = args
    this.cancelIdle(spec.key)

    const existing = this.live.get(spec.key)
    // A fork always needs a fresh spawn: `resumeSessionAt`/`forkSession` are
    // session-start options that no control request can apply to a live one.
    // So is a changed startup fingerprint, for the same reason.
    const reusable =
      existing !== undefined &&
      !existing.dead &&
      spec.resumeAt === undefined &&
      existing.sessionId === spec.resume &&
      existing.startupFingerprint === spec.startupFingerprint

    if (reusable && existing) {
      if (spec.model !== undefined && existing.model !== spec.model) {
        try {
          await existing.setModel(spec.model)
        } catch {
          // A session that will not take a control request is not one to keep.
          this.drop(spec.key)
          return this.spawn(args)
        }
      }
      return existing
    }

    if (existing) this.drop(spec.key)
    return this.spawn(args)
  }

  /**
   * Let a conversation's session go cold after `IDLE_TIMEOUT_MS`.
   *
   * Call once the turn's stream is fully consumed — a timer armed mid-turn
   * could fire into a session still writing its answer.
   */
  release(key: string): void {
    const session = this.live.get(key)
    if (!session) return
    if (session.dead) {
      this.live.delete(key)
      return
    }
    this.cancelIdle(key)
    const timer = setTimeout(() => {
      this.idleTimers.delete(key)
      this.drop(key)
    }, IDLE_TIMEOUT_MS)
    this.idleTimers.set(key, timer)
  }

  /** Close every warm session. Called when the plugin unloads. */
  disposeAll(): void {
    for (const key of [...this.live.keys()]) this.drop(key)
  }

  private spawn(args: {
    sdk: ClaudeSdkModule
    processSupport: ClaudeProcessSupport
    spec: ClaudeSessionSpec
    buildOptions: (spec: ClaudeSessionSpec) => Options
  }): ClaudeLiveSession {
    const { spec } = args
    // Evict before spawning, so the cap is never briefly exceeded.
    while (this.live.size >= MAX_LIVE_SESSIONS) {
      const oldest = this.live.keys().next()
      if (oldest.done) break
      this.drop(oldest.value)
    }

    const session = ClaudeLiveSession.start({
      sdk: args.sdk,
      processSupport: args.processSupport,
      options: args.buildOptions(spec),
      sessionId: spec.resume,
      model: spec.model,
      startupFingerprint: spec.startupFingerprint,
    })
    this.live.set(spec.key, session)
    return session
  }

  private drop(key: string): void {
    this.cancelIdle(key)
    const session = this.live.get(key)
    this.live.delete(key)
    session?.close()
  }

  private cancelIdle(key: string): void {
    const timer = this.idleTimers.get(key)
    if (!timer) return
    clearTimeout(timer)
    this.idleTimers.delete(key)
  }
}

export const claudeSdkSessionPool = new ClaudeSdkSessionPool()
