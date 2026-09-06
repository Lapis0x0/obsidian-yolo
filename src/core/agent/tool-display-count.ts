import type { Assistant } from '../../types/assistant.types'
import type { McpTool } from '../../types/mcp.types'
import { getLocalFileToolServerName } from '../mcp/localFileTools'
import { parseToolName } from '../mcp/tool-name-utils'
import { listCapabilities } from '../tools/registry'

import {
  type ModuleToolSetEnablementV1,
  getEnabledAssistantToolNames,
} from './tool-preferences'

/**
 * The unit this counts in, which has to be the unit the agent editor renders
 * in or the two disagree in front of the user (a `58 / 56 active` was exactly
 * that: this file used to fold only `fs_edit` and `web_access` into one unit
 * from a hand-written pair of member-name sets, while the editor folds *every*
 * capability into one row — so every other multi-tool capability counted once
 * per member here and once per capability there).
 *
 * Derived from the capability registry rather than listed here, for the reason
 * AGENTS.md gives: `capabilities/` is the single registration point, and a
 * side table beside it is a second source of truth that nothing keeps in step.
 *
 * A module tool set is one unit for the same reason — the editor renders it as
 * one capability row, and its tools belong to the module rather than to the
 * user's own configuration. Only remote MCP tools count one apiece, which is
 * also how the editor lists them.
 */
function displayUnitOf(
  serverName: string,
  shortName: string,
  isBuiltin: boolean,
  capabilityByToolName: ReadonlyMap<string, string>,
  moduleToolSetServerNames: ReadonlySet<string>,
): string | null {
  if (isBuiltin) {
    const capabilityId = capabilityByToolName.get(shortName)
    return capabilityId === undefined ? null : `capability:${capabilityId}`
  }
  return moduleToolSetServerNames.has(serverName) ? `set:${serverName}` : null
}

/** Counts enabled tools using the same grouped, currently-visible units as the agent editor. */
export function countEnabledVisibleAssistantTools(
  assistant: Pick<
    Assistant,
    | 'toolPreferences'
    | 'enabledToolNames'
    | 'includeBuiltinTools'
    | 'builtinCapabilityPreferences'
  > | null,
  availableTools: readonly McpTool[],
  moduleToolSets: readonly ModuleToolSetEnablementV1[] = [],
): number {
  const enabledToolNames = new Set(
    getEnabledAssistantToolNames(assistant, moduleToolSets),
  )
  const localServerName = getLocalFileToolServerName()
  const capabilityByToolName = new Map<string, string>()
  for (const capability of listCapabilities()) {
    for (const tool of capability.tools) {
      capabilityByToolName.set(tool.name, capability.id)
    }
  }
  const moduleToolSetServerNames = new Set(
    moduleToolSets.map((set) => set.serverName),
  )

  // Members present in this catalog, per unit. Built from `availableTools`
  // rather than from the registry so a capability whose member is gated off at
  // runtime is judged on the members that actually shipped — the same
  // `presentMembers` rule the editor's rows are built with.
  const unitMembers = new Map<string, string[]>()
  let count = 0

  for (const tool of availableTools) {
    let serverName = localServerName
    let shortName = tool.name

    try {
      const parsed = parseToolName(tool.name)
      serverName = parsed.serverName
      shortName = parsed.toolName
    } catch {
      // Match the agent editor: malformed names are treated as built-in tools.
    }

    const isBuiltin = serverName === localServerName
    if (isBuiltin && assistant?.includeBuiltinTools === false) {
      continue
    }

    const unit = displayUnitOf(
      serverName,
      shortName,
      isBuiltin,
      capabilityByToolName,
      moduleToolSetServerNames,
    )
    if (unit !== null) {
      const members = unitMembers.get(unit)
      if (members) members.push(tool.name)
      else unitMembers.set(unit, [tool.name])
      continue
    }

    if (enabledToolNames.has(tool.name)) {
      count += 1
    }
  }

  // A unit counts as enabled only when all of its present members are, which
  // is what the editor's own row toggle means.
  for (const members of unitMembers.values()) {
    if (members.every((member) => enabledToolNames.has(member))) {
      count += 1
    }
  }

  return count
}
