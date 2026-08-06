import { ReasoningPhaseTracker } from './reasoningPhaseTracker'

describe('ReasoningPhaseTracker', () => {
  it('does not report a duration without reasoning', () => {
    const tracker = new ReasoningPhaseTracker(100)

    expect(tracker.settle(500)).toBeUndefined()
  })

  it('freezes the duration after reasoning settles', () => {
    const tracker = new ReasoningPhaseTracker(100)
    tracker.observeReasoning()

    expect(tracker.settle(500)).toBe(400)
    expect(tracker.settle(900)).toBe(400)
  })
})
