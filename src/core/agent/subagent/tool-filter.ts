import { SUBAGENT_BLOCKED_TOOL_NAMES } from './constants'

const blockedSet = new Set(SUBAGENT_BLOCKED_TOOL_NAMES)

/**
 * Intersect parent-allowed tools with the subagent runtime deny-list.
 * Parent enablement, approval mode, and workspace scope still apply downstream.
 *
 * The deny-list is static (baseline only): see `SUBAGENT_BLOCKED_TOOL_NAMES`.
 * Tools that require approval are no longer filtered here — their approval
 * requests route to the parent conversation's SubagentCard (see
 * `docs/plans/2026-06-18-subagent-tool-approval-routing.md`).
 */
export function filterAllowedToolsForSubagent(
  parentAllowedToolNames: string[] | undefined,
): string[] {
  if (!parentAllowedToolNames) {
    return []
  }

  const filtered = parentAllowedToolNames.filter(
    (name) => !blockedSet.has(name),
  )
  return filtered.length > 0 ? filtered : []
}

export function isSubagentBlockedToolName(toolName: string): boolean {
  return blockedSet.has(toolName)
}
