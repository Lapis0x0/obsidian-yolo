import type { JsSandboxSettings } from '../../mcp/jsSandboxSettings'

import { buildSubagentBlockedToolNames } from './constants'

type SubagentBlockListOptions = {
  jsSandboxSettings?: JsSandboxSettings | null
}

const buildBlockedSet = (options?: SubagentBlockListOptions): Set<string> =>
  new Set(buildSubagentBlockedToolNames(options))

/**
 * Intersect parent-allowed tools with the subagent runtime deny-list.
 * Parent enablement, approval mode, and workspace scope still apply downstream.
 *
 * The deny-list is dynamic: see {@link buildSubagentBlockedToolNames}. Callers
 * with access to `McpManager` should pass `getJsSandboxSettings()` so JS sandbox
 * is denied to subagents whenever any high-risk extension capability is on.
 */
export function filterAllowedToolsForSubagent(
  parentAllowedToolNames: string[] | undefined,
  options?: SubagentBlockListOptions,
): string[] {
  if (!parentAllowedToolNames) {
    return []
  }

  const blockedSet = buildBlockedSet(options)
  const filtered = parentAllowedToolNames.filter(
    (name) => !blockedSet.has(name),
  )
  return filtered.length > 0 ? filtered : []
}

export function isSubagentBlockedToolName(
  toolName: string,
  options?: SubagentBlockListOptions,
): boolean {
  return buildBlockedSet(options).has(toolName)
}
