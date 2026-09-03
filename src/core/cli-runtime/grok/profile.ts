import type { AcpAgentProfile } from '../acp/agent-profile'

import { selectGrokSubscriptionAuthMethod } from './auth'
import { resolveGrokCommand } from './resolve-command'

/**
 * Official Grok Build ACP profile. Authentication stays inside the signed
 * CLI: YOLO requests only the already cached subscription credential and
 * never reads or persists Grok's token files itself.
 */
export const grokAgentProfile: AcpAgentProfile = {
  runtimeId: 'grok',
  displayName: 'Grok',
  resolveCommand: (env, cliPathOverride) =>
    resolveGrokCommand(env, process.platform, cliPathOverride),
  selectAuthMethod: (init) =>
    selectGrokSubscriptionAuthMethod(init.authMethods ?? []),
}
