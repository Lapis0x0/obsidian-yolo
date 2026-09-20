import type { AcpAgentProfile } from '../acp/agent-profile'

import { resolveCodebuddyCommand } from './resolve-command'

/**
 * CodeBuddy Code's ACP plug-in point: `codebuddy --acp` over stdio.
 *
 * Authentication is deliberately absent. Every method CodeBuddy advertises
 * (iOA, Google/GitHub, WeChat, enterprise domain) completes in a browser or
 * on a phone, which an Obsidian pane cannot host, so this profile never
 * calls `authenticate` and the agent runs on whatever credential the CLI
 * already cached — the user logs in once by running `codebuddy` in a
 * terminal, or supplies `CODEBUDDY_API_KEY` for the enterprise build.
 * Until then `session/new` fails with CodeBuddy's own "Authentication
 * required" error, which surfaces to the user as-is.
 */
export const codebuddyAgentProfile: AcpAgentProfile = {
  runtimeId: 'codebuddy',
  displayName: 'CodeBuddy',
  resolveCommand: (env, cliPathOverride) =>
    resolveCodebuddyCommand(env, process.platform, cliPathOverride),
  // CodeBuddy compacts through the same `/compact` slash command its TUI
  // uses; it runs the agent's PreCompact hooks and replies in prose rather
  // than emitting a structured ACP event, so `AcpCliRuntime.compact()`
  // draws the `compaction_boundary` itself once the prompt resolves.
  compactCommand: '/compact',
  /**
   * CodeBuddy exposes its permission policy as ACP session modes, using the
   * same vocabulary as its `--permission-mode` flag. Of the eight ids it
   * advertises, three carry the product's Agent/Plan + YOLO state:
   *
   * - `plan` — analyse without editing files or running commands.
   * - `acceptEdits` — auto-approve file edits, still ask for everything else.
   * - `bypassPermissions` — skip approval prompts for the session.
   *
   * `fullAccess` goes further still (it drops the checks CodeBuddy keeps
   * even under bypass, for dangerous commands) and is not reachable from the
   * product's YOLO toggle: YOLO means "stop asking me", not "disarm the
   * agent's own safety floor". `auto`, `dontAsk` and `delegate` describe
   * policies the product has no state for.
   */
  resolveSessionModeId: ({ mode, yoloEnabled }) => {
    if (mode === 'plan') return 'plan'
    return yoloEnabled ? 'bypassPermissions' : 'acceptEdits'
  },
}
