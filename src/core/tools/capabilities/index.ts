import { memoryCapability } from './memory'
import { subagentDelegationCapability } from './subagent-delegation'

/**
 * The single registration point for all built-in capabilities.
 *
 * This task's scope is D1 (skeleton) + D2 (`memory`) + D3
 * (`subagent_delegation`) — Phase 1's two skeleton-validating samples. The
 * remaining 10 capabilities land in D6. Once they do, add them here — this
 * is the only place a new capability needs to be registered.
 */
export const CAPABILITIES = [
  memoryCapability,
  subagentDelegationCapability,
] as const
