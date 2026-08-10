/** Tracks the user-visible reasoning phase of one assistant response. */
export class ReasoningPhaseTracker {
  private hasReasoning = false
  private durationMsValue: number | undefined

  constructor(private readonly startedAt = Date.now()) {}

  observeReasoning(): void {
    if (this.durationMsValue === undefined) this.hasReasoning = true
  }

  settle(now = Date.now()): number | undefined {
    if (!this.hasReasoning) return undefined
    if (this.durationMsValue === undefined) {
      this.durationMsValue = Math.max(0, now - this.startedAt)
    }
    return this.durationMsValue
  }

  get durationMs(): number | undefined {
    return this.durationMsValue
  }
}
