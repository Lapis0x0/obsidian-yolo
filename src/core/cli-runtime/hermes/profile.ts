import type { AcpAgentProfile } from '../acp/agent-profile'

import { resolveHermesCommand } from './resolve-command'

/** Hermes's ACP plug-in point: `hermes acp` over stdio (SQLite-backed sessions, `session/load`-replayable). */
export const hermesAgentProfile: AcpAgentProfile = {
  runtimeId: 'hermes',
  displayName: 'Hermes',
  resolveCommand: (env, cliPathOverride) =>
    resolveHermesCommand(env, process.platform, cliPathOverride),
}
