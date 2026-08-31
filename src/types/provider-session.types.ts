/**
 * Binding between a YOLO conversation and a native session owned by a
 * provider's own runtime.
 *
 * Mirrors what `ChatConversationCliSession` does for CLI runtimes, and for the
 * same reason: the transcript, its compaction and its resume/fork mechanics
 * all live inside the provider's runtime, so YOLO persists a stable reference
 * to it rather than a second copy of the history. Re-deriving any of that here
 * would be a bug, not a feature.
 *
 * Only providers that own a native session use this. Every other provider is
 * stateless and never reads or writes it.
 */
export type ProviderSession = {
  /** Provider whose runtime owns `nativeSessionId`. */
  providerId: string
  /** Session id as the provider's own runtime knows it. */
  nativeSessionId: string
  /**
   * Turn id → the native transcript entry that turn ended at.
   *
   * Editing or regenerating a message makes YOLO's history diverge from the
   * native transcript, which is still on its original branch. The anchor for
   * the turn being branched from is what lets the provider fork the native
   * session at the matching point instead of losing the history or replaying
   * it.
   */
  anchors: Record<string, string>
  /** Turn id the native transcript currently ends at. */
  tipTurnId?: string
}

/**
 * How a provider reads and records its native session for the turn in flight.
 *
 * Supplied per request by the caller that owns the conversation, so the
 * provider never reaches for storage itself and the orchestration layer never
 * has to know what a native session id is.
 */
export type ProviderSessionAccessor = {
  /**
   * Turn this one continues from, or `undefined` when it opens the
   * conversation. A provider compares it against `ProviderSession.tipTurnId`
   * to tell "the next turn" from "a turn branching off an earlier point".
   */
  parentTurnId?: string
  /** Turn being produced now; the key its anchor is recorded under. */
  turnId: string
  /**
   * The stored session, loaded on demand. Async because it may have to come
   * off disk — the in-memory pool is gone after an Obsidian restart, but the
   * pointer it was using is not.
   */
  read(): Promise<ProviderSession | undefined>
  /**
   * Record the session this turn ended on. Returns immediately; persistence is
   * best-effort, and a lost write costs the next turn a cold start rather than
   * correctness.
   */
  write(next: ProviderSession): void
}
