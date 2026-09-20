import type { AcpAgentProfile } from '../acp/agent-profile'

import { HERMES_DEFAULT_PROFILE_ID } from './profiles'
import { resolveHermesCommand } from './resolve-command'

/**
 * Hermes's ACP plug-in point: `hermes acp` over stdio (SQLite-backed
 * sessions, `session/load`-replayable). `AcpAgentProfile.resolveCommand` is
 * agent-agnostic and carries no profile argument, so this generic
 * install-detection path always resolves against the default Hermes
 * profile; `hermes/factory.ts` calls `resolveHermesCommand` directly with a
 * real per-conversation profile id for actual launches.
 */
export const hermesAgentProfile: AcpAgentProfile = {
  runtimeId: 'hermes',
  displayName: 'Hermes',
  resolveCommand: (env, cliPathOverride) =>
    resolveHermesCommand(
      env,
      process.platform,
      cliPathOverride,
      HERMES_DEFAULT_PROFILE_ID,
    ),
  // Hermes's ACP server intercepts this slash command at the prompt entry
  // point and returns a plain-text summary; it emits no structured ACP
  // compaction event, so `AcpCliRuntime.compact()` synthesizes the
  // `compaction_boundary` itself once the prompt round-trip resolves.
  compactCommand: '/compress',
  // Hermes exposes its edit-approval policy as ACP session modes. Agent maps
  // to the workspace-scoped policy so edits inside the vault stop asking
  // while anything outside it still does; YOLO maps to the session-wide one.
  // Plan mode never reaches an agent-mode policy (the product collapses
  // `yoloEnabled` to false there), so it stays on the ask-every-time default.
  resolveSessionModeId: ({ mode, yoloEnabled }) => {
    if (mode === 'plan') return 'default'
    return yoloEnabled ? 'dont_ask' : 'accept_edits'
  },
}
