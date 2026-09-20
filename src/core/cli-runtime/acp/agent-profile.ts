import type { InitializeResponse } from '@agentclientprotocol/sdk'

import type { CliPermissionProfileUpdate, CliRuntimeId } from '../types'

export type AcpResolvedCommand = Readonly<{
  command: string
  args: string[]
}>

/**
 * Agent-specific plug-in point for the protocol-agnostic ACP client in this
 * directory. Everything else under `acp/` (process, transport, host, client,
 * mapping, `AcpCliRuntime`) is agent-agnostic and must never branch on which
 * agent is connected — Hermes is the first consumer, and future ACP agents
 * (Gemini CLI, Goose, opencode, ...) plug in by supplying their own profile.
 */
export type AcpAgentProfile = Readonly<{
  runtimeId: CliRuntimeId
  /** Human-readable agent name used in "not found" diagnostics, e.g. "Hermes". */
  displayName: string
  /**
   * Resolves the executable to launch. `cliPathOverride` (Settings → Agent)
   * takes priority; implementations fall back to auto-detection when it is
   * absent or does not point at an existing file. Returns `null` when no
   * executable can be found at all.
   */
  resolveCommand(
    env: NodeJS.ProcessEnv,
    cliPathOverride?: string,
  ): Promise<AcpResolvedCommand | null>
  /**
   * Optional authentication policy applied after ACP initialization and
   * before the host exposes a usable connection.
   */
  selectAuthMethod?(init: InitializeResponse): string | undefined
  /**
   * Slash command text this agent understands as a manual-compaction
   * trigger (e.g. Hermes's `/compress`), sent as an ordinary
   * `session/prompt`. `AcpCliRuntime` has no ACP-level compaction call to
   * make, so this is the only lever `compact()` has; agents that don't
   * expose one leave it `undefined` and `compact()` throws.
   */
  compactCommand?: string
  /**
   * Translates the product's permission profile (Agent/Plan + YOLO) into one
   * of the session mode ids this agent advertises in its `session/new` /
   * `session/load` response, which `AcpCliRuntime` then applies with
   * `session/set_mode`.
   *
   * ACP deliberately leaves mode ids up to each agent — the protocol carries
   * an id, a name and a description, but no machine-readable semantics — so
   * the mapping cannot be derived and has to be declared per agent here.
   * Agents that advertise no modes (or no mode matching a given profile)
   * leave this undefined / return `null`, and their own default policy
   * stands.
   */
  resolveSessionModeId?(update: CliPermissionProfileUpdate): string | null
}>
