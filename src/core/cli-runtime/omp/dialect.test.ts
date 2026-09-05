import { isPiAgentSettled } from '../pi/mapping'

import {
  OMP_RUNTIME_DIALECT,
  isOmpPromptSettledWithoutAgentRun,
  isOmpTurnSettled,
} from './dialect'

describe('omp turn-terminal dialect', () => {
  it('treats agent_end as terminal unless it says more work is coming', () => {
    // omp removed `agent_settled` entirely; `agent_end` is the terminal event,
    // and `isTerminal: false` is the only thing that keeps the turn open.
    expect(isOmpTurnSettled({ type: 'agent_end' })).toBe(true)
    expect(isOmpTurnSettled({ type: 'agent_end', isTerminal: true })).toBe(true)
    expect(isOmpTurnSettled({ type: 'agent_end', isTerminal: false })).toBe(
      false,
    )
  })

  it('never waits for pi’s agent_settled, which omp does not emit', () => {
    expect(isOmpTurnSettled({ type: 'agent_settled' })).toBe(false)
  })

  it('settles on a deferred prompt_result that never invoked the agent', () => {
    expect(
      isOmpTurnSettled({ type: 'prompt_result', agentInvoked: false }),
    ).toBe(true)
    // `agentInvoked: true` only announces that a turn is now running.
    expect(
      isOmpTurnSettled({ type: 'prompt_result', agentInvoked: true }),
    ).toBe(false)
  })

  it('leaves unrelated events alone', () => {
    expect(isOmpTurnSettled({ type: 'message_end' })).toBe(false)
    expect(isOmpTurnSettled({ type: 'ready' })).toBe(false)
  })

  it('does not leak the omp rule back into pi', () => {
    // pi has no `isTerminal` field and legitimately re-emits `agent_end` after
    // a retry or a compaction, so agent_end must never end a pi turn.
    expect(isPiAgentSettled({ type: 'agent_end' })).toBe(false)
    expect(isPiAgentSettled({ type: 'agent_end', isTerminal: true })).toBe(
      false,
    )
    expect(isPiAgentSettled({ type: 'agent_settled' })).toBe(true)
  })
})

describe('omp prompt responses that never reach the agent', () => {
  it('reports a locally handled prompt as already settled', () => {
    expect(isOmpPromptSettledWithoutAgentRun({ agentInvoked: false })).toBe(
      true,
    )
  })

  it('leaves every other response on the normal event path', () => {
    expect(isOmpPromptSettledWithoutAgentRun({ agentInvoked: true })).toBe(
      false,
    )
    // `abort_and_prompt` reports no `agentInvoked` at all.
    expect(isOmpPromptSettledWithoutAgentRun({})).toBe(false)
    expect(isOmpPromptSettledWithoutAgentRun(undefined)).toBe(false)
  })
})

describe('omp dialect wiring', () => {
  it('runs as its own runtime id on the omp executable', () => {
    expect(OMP_RUNTIME_DIALECT.runtimeId).toBe('omp')
    expect(OMP_RUNTIME_DIALECT.command).toBe('omp')
    expect(OMP_RUNTIME_DIALECT.isTurnSettled).toBe(isOmpTurnSettled)
    expect(OMP_RUNTIME_DIALECT.isPromptSettledWithoutAgentRun).toBe(
      isOmpPromptSettledWithoutAgentRun,
    )
  })
})
