import type { PiRuntimeDialect } from '../pi/dialect'
import type { PiRpcRecord } from '../pi/transport'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * oh-my-pi removed pi's `agent_settled` event outright — there is no such
 * event anywhere in the fork — and moved terminality onto `agent_end`: an
 * `isTerminal: false` says an async task is still driving this turn forward,
 * anything else (including the field being absent) ends it.
 *
 * omp also answers a prompt it never handed to the agent with a
 * `prompt_result` frame carrying `agentInvoked: false`. That is the end of
 * the turn just as surely — no agent event will follow it — so it settles
 * here too. `agentInvoked: true` only announces that the agent is now
 * running, and settles nothing.
 *
 * Neither rule may be applied to pi: pi's `agent_end` has no `isTerminal`
 * field and can legitimately repeat after a retry or a compaction, so
 * treating it as terminal would end pi's turns early.
 */
export const isOmpTurnSettled = (event: PiRpcRecord): boolean => {
  switch (event.type) {
    case 'agent_end':
      return event.isTerminal !== false
    case 'prompt_result':
      return event.agentInvoked === false
    default:
      return false
  }
}

/**
 * omp's `prompt` response reports whether the prompt actually reached the
 * agent. `agentInvoked: false` means it was fully handled locally (a pure
 * slash command, for instance) and no turn events will ever arrive, so the
 * caller has to close the turn itself. Anything else — including the field
 * being absent, as on `abort_and_prompt` — takes the normal event path.
 */
export const isOmpPromptSettledWithoutAgentRun = (
  promptResponse: unknown,
): boolean => isRecord(promptResponse) && promptResponse.agentInvoked === false

/**
 * oh-my-pi (can1357/oh-my-pi) is a hard fork of pi speaking the same native
 * RPC protocol, so it runs on pi's engine and contributes only its own
 * differences here.
 */
export const OMP_RUNTIME_DIALECT: PiRuntimeDialect = {
  runtimeId: 'omp',
  command: 'omp',
  notFoundMessage:
    'omp CLI was not found on this device. Install oh-my-pi (bun install -g @oh-my-pi/pi-coding-agent), or set a custom CLI path in Settings → Agent, then retry.',
  isTurnSettled: isOmpTurnSettled,
  isPromptSettledWithoutAgentRun: isOmpPromptSettledWithoutAgentRun,
}
