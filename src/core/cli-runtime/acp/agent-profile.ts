import type { CliRuntimeId } from '../types'

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
   * Slash command text this agent understands as a manual-compaction
   * trigger (e.g. Hermes's `/compress`), sent as an ordinary
   * `session/prompt`. `AcpCliRuntime` has no ACP-level compaction call to
   * make, so this is the only lever `compact()` has; agents that don't
   * expose one leave it `undefined` and `compact()` throws.
   */
  compactCommand?: string
}>
