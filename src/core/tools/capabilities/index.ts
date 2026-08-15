import { memoryCapability } from './memory'

/**
 * The single registration point for all built-in capabilities.
 *
 * This task's scope is limited to D1 (skeleton) + D2 (the `memory`
 * capability sample); D3 (`subagent_delegation`) and the remaining
 * capabilities are explicitly out of scope and land in later work. Once they
 * land, add them here — this is the only place a new capability needs to be
 * registered.
 */
export const CAPABILITIES = [memoryCapability] as const
