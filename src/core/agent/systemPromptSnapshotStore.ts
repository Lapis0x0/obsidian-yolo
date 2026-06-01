import type { SystemPromptSections } from '../../utils/chat/requestContextBuilder'

/**
 * Frozen system-prompt payload for one conversation: the ordered sections and
 * the joined system message text. Both are captured together so the bytes the
 * model sees in the system message stay stable for the whole conversation,
 * preserving provider prefix caches even when memory / project instructions /
 * time variables change mid-conversation.
 */
export type SystemPromptSnapshot = {
  systemSections: SystemPromptSections
  systemContent: string
}

type StoreEntry = {
  fingerprint: string
  snapshot: SystemPromptSnapshot
}

/**
 * Per-conversation cache of the resolved system prompt. Held by `AgentService`
 * (a plugin-level singleton) so it survives `RequestContextBuilder` rebuilds
 * triggered by unrelated settings churn.
 *
 * A snapshot is keyed by `conversationId`; the stored `fingerprint` captures
 * every settings-level input that legitimately changes the system prompt.
 * A fingerprint mismatch is treated as a miss so the snapshot refreshes when
 * (and only when) the relevant configuration changes.
 */
type InflightEntry = {
  fingerprint: string
  promise: Promise<SystemPromptSnapshot>
}

export class SystemPromptSnapshotStore {
  private map = new Map<string, StoreEntry>()
  // In-flight `create` builds, keyed by conversationId. Concurrent real
  // requests for the same (conversation, fingerprint) — e.g. multi-model
  // compare runs in `Promise.allSettled` — share ONE build so the first frozen
  // snapshot wins instead of a slower branch overwriting it with post-write
  // memory.
  private inflight = new Map<string, InflightEntry>()

  /**
   * Return the frozen snapshot for `conversationId` when it matches
   * `fingerprint`, otherwise resolve a fresh one via `build`.
   *
   * - `reuseOnly: false` (real request path): a miss builds the snapshot and
   *   writes it, so subsequent iterations / turns reuse it via fingerprint hit.
   *   Concurrent misses are coalesced onto a single build.
   * - `reuseOnly: true` (estimate / breakdown path): a hit is reused; a miss is
   *   built but NOT written, so token-panel / compaction estimates never freeze
   *   the system prompt ahead of the real request.
   */
  async getOrCreate(
    conversationId: string,
    fingerprint: string,
    build: () => Promise<SystemPromptSnapshot>,
    opts: { reuseOnly: boolean },
  ): Promise<SystemPromptSnapshot> {
    const existing = this.map.get(conversationId)
    if (existing && existing.fingerprint === fingerprint) {
      return existing.snapshot
    }

    if (opts.reuseOnly) {
      // Estimate path: compute fresh, never write or coalesce.
      return build()
    }

    const pending = this.inflight.get(conversationId)
    if (pending && pending.fingerprint === fingerprint) {
      return pending.promise
    }

    const entry: InflightEntry = { fingerprint, promise: build() }
    this.inflight.set(conversationId, entry)
    try {
      const snapshot = await entry.promise
      // Commit only if this build is still the active one. If the conversation
      // was evicted (e.g. cleared mid-run) or superseded by a newer fingerprint
      // while building, do not write a now-stale snapshot back.
      if (this.inflight.get(conversationId) === entry) {
        this.map.set(conversationId, { fingerprint, snapshot })
      }
      return snapshot
    } finally {
      if (this.inflight.get(conversationId) === entry) {
        this.inflight.delete(conversationId)
      }
    }
  }

  /** Drop the snapshot for one conversation (delete / new-topic semantics). */
  evict(conversationId: string): void {
    this.map.delete(conversationId)
    this.inflight.delete(conversationId)
  }

  /** Drop every snapshot. */
  clear(): void {
    this.map.clear()
    this.inflight.clear()
  }
}
