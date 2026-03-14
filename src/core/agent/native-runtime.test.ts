import { shouldProceedToToolPhase } from './tool-phase'

describe('shouldProceedToToolPhase', () => {
  it('returns true when tool call requests exist even if model terminated', () => {
    const turnResult = {
      toolCallRequests: [{ id: 'call-1' }],
      modelTerminated: true,
    }
    const result = shouldProceedToToolPhase(turnResult)

    expect(result).toBe(true)
  })

  it('returns false when tool call requests are empty', () => {
    const turnResult = {
      toolCallRequests: [],
      modelTerminated: false,
    }
    const result = shouldProceedToToolPhase(turnResult)

    expect(result).toBe(false)
  })
})
