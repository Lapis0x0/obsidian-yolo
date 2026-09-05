import type { CliRuntimeId } from '../types'

import { isPiAgentSettled } from './mapping'
import type { PiRpcRecord } from './transport'

/**
 * Everything that differs between the CLI runtimes this engine drives.
 *
 * `pi/` is the protocol engine — the RPC framing, event mapping, session
 * handling and process lifecycle of `pi --mode rpc`. oh-my-pi (`omp`) is a
 * hard fork speaking the same protocol, so it reuses all of that and supplies
 * only its own differences through this record. Anything the two runtimes
 * genuinely agree on stays unconditional in the engine; a field only earns a
 * place here once the two are observably different.
 */
export type PiRuntimeDialect = Readonly<{
  /**
   * Host runtime id this engine instance runs as — the id it stamps onto
   * `CliSessionRef`s and tool-call metadata, and the key its CLI path
   * override is stored under.
   */
  runtimeId: CliRuntimeId
  /** Executable base name, also how the runtime is named in error text. */
  command: string
  /** Shown when the executable cannot be found on this device. */
  notFoundMessage: string
  /**
   * Is this event the end of the current turn? The only signal the engine has
   * for closing a turn out, and the two runtimes disagree on it: pi has a
   * dedicated `agent_settled` event, while omp removed it in favour of
   * `agent_end` plus an `isTerminal` flag. Applying either rule to the other
   * runtime breaks it, so it is always taken from the dialect.
   */
  isTurnSettled: (event: PiRpcRecord) => boolean
  /**
   * Did this `prompt` response already finish the turn locally, without
   * running the agent at all? omp answers a prompt it handled itself (a pure
   * slash command, say) with `agentInvoked: false` and then emits no turn
   * events, so the engine has to close the turn from the response. pi always
   * runs the agent and leaves this undefined.
   */
  isPromptSettledWithoutAgentRun?: (promptResponse: unknown) => boolean
}>

export const PI_RUNTIME_DIALECT: PiRuntimeDialect = {
  runtimeId: 'pi',
  command: 'pi',
  notFoundMessage:
    'pi CLI was not found on this device. Install pi (npm i -g @earendil-works/pi-cli, package name may vary), or set a custom CLI path in Settings → Agent, then retry.',
  isTurnSettled: isPiAgentSettled,
}
