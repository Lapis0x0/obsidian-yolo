// Host-wide directory of module-contributed tool sets — the tools a module
// puts into *ordinary* chat, as opposed to `moduleChatModeRegistry.ts`'s
// mode-scoped ones. The two files are deliberately shaped the same way (Map +
// frozen snapshot + `subscribe`, consumed by `McpCoordinator` and replayed as
// in-process MCP tool servers); what differs is only the scope of the result.
//
// See docs/plans/09-03-whiteboard-agent-tools/master.md D1.

import type { BuiltinToolCategory } from '../tools/types'

import {
  MAX_MODULE_AGENT_TOOLS,
  snapshotModuleAgentToolBase,
} from './moduleAgent'
import { snapshotLocalizedText } from './moduleI18n'
import type {
  YoloModuleAgentToolV1,
  YoloModuleToolSetCategoryV1,
  YoloModuleToolSetV1,
} from './types'

/**
 * The module-facing category union must stay exactly the host's. A category
 * added on one side and not the other would either be unrenderable or
 * silently unreachable, so the two are pinned to each other here rather than
 * by a comment. (Assignability in both directions is set equality.)
 */
const _categoriesMatchHost: YoloModuleToolSetCategoryV1 extends BuiltinToolCategory
  ? BuiltinToolCategory extends YoloModuleToolSetCategoryV1
    ? true
    : never
  : never = true
void _categoriesMatchHost

/** Set-local id format — see `YoloModuleToolSetV1.id`. */
export const MODULE_TOOL_SET_ID_RE = /^[a-z][a-z0-9_]*$/
export const MAX_MODULE_TOOL_SETS_PER_MODULE = 2

/**
 * `yolo_<setId>` — inside `RESERVED_HOST_SERVER_PREFIX`, so a user-configured
 * MCP server can never answer to a module tool set's name.
 */
export function buildModuleToolSetServerName(setId: string): string {
  return `yolo_${setId}`
}

export type ModuleToolSetAvailabilityV1 =
  | Readonly<{ status: 'available' }>
  | Readonly<{ status: 'unavailable'; reason: string }>

export type RegisteredModuleToolSetV1 = Readonly<{
  moduleId: string
  set: YoloModuleToolSetV1
  serverName: string
  availability: ModuleToolSetAvailabilityV1
}>

export type ModuleToolSetContributionSinkV1 = Readonly<{
  add(moduleId: string, set: YoloModuleToolSetV1): void
  remove(moduleId: string, setId: string): void
}>

const AVAILABLE: ModuleToolSetAvailabilityV1 = Object.freeze({
  status: 'available',
})

export class ModuleToolSetRegistry implements ModuleToolSetContributionSinkV1 {
  /** Keyed by set id, not by `<moduleId>:<setId>`: the id is global by
   * construction (it becomes a server name), so two modules claiming the same
   * id is a conflict to surface, not two entries to keep. */
  private readonly entries = new Map<string, RegisteredModuleToolSetV1>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly RegisteredModuleToolSetV1[] = Object.freeze([])

  add(moduleId: string, set: YoloModuleToolSetV1): void {
    const existing = this.entries.get(set.id)
    if (existing && existing.moduleId !== moduleId) {
      throw new Error(
        `Module tool set id "${set.id}" is already registered by module "${existing.moduleId}"`,
      )
    }
    this.entries.set(
      set.id,
      Object.freeze({
        moduleId,
        set,
        serverName: buildModuleToolSetServerName(set.id),
        availability: AVAILABLE,
      }),
    )
    this.updateSnapshot()
    this.emit()
  }

  remove(moduleId: string, setId: string): void {
    const existing = this.entries.get(setId)
    // Guarded by owner: a module's teardown must not revoke a set another
    // module owns, which is reachable if an id was contested.
    if (!existing || existing.moduleId !== moduleId) return
    this.entries.delete(setId)
    this.updateSnapshot()
    this.emit()
  }

  /** Called by `McpCoordinator` to report a set's live registration outcome. */
  setAvailability(
    setId: string,
    availability: ModuleToolSetAvailabilityV1,
  ): void {
    const existing = this.entries.get(setId)
    if (!existing || sameAvailability(existing.availability, availability)) {
      return
    }
    this.entries.set(setId, Object.freeze({ ...existing, availability }))
    this.updateSnapshot()
    this.emit()
  }

  getSnapshot = (): readonly RegisteredModuleToolSetV1[] => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  clear(): void {
    if (this.entries.size === 0) return
    this.entries.clear()
    this.updateSnapshot()
    this.emit()
  }

  private updateSnapshot(): void {
    this.snapshot = Object.freeze(
      [...this.entries.values()].sort((left, right) =>
        left.set.id.localeCompare(right.set.id),
      ),
    )
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

/**
 * Reduces a tool set snapshot to what `getEnabledAssistantToolNames`
 * (`core/agent/tool-preferences.ts`) needs: the in-process server name each
 * set is served under and the short tool names it exposes. Shared by every
 * call site that threads a tool set snapshot into enablement/count
 * computations (docs/plans/09-03-whiteboard-agent-tools/master.md D1b) so
 * none of them hand-write the same `serverName`/`toolNames` projection.
 *
 * Drops `unavailable` sets: their tools are not actually registered as an
 * in-process MCP server (see `McpCoordinator`), so counting them as enabled
 * would claim usability the runtime cannot deliver.
 */
export function toModuleToolSetEnablement(
  snapshot: readonly RegisteredModuleToolSetV1[],
): readonly Readonly<{ serverName: string; toolNames: readonly string[] }>[] {
  return snapshot
    .filter((entry) => entry.availability.status === 'available')
    .map((entry) => ({
      serverName: entry.serverName,
      toolNames: entry.set.tools.map((tool) => tool.name),
    }))
}

function sameAvailability(
  left: ModuleToolSetAvailabilityV1,
  right: ModuleToolSetAvailabilityV1,
): boolean {
  if (left.status !== right.status) return false
  return (
    left.status !== 'unavailable' ||
    right.status !== 'unavailable' ||
    left.reason === right.reason
  )
}

const MODULE_TOOL_SET_CATEGORIES: ReadonlySet<YoloModuleToolSetCategoryV1> =
  new Set(['vault', 'context', 'external'])

/**
 * Validates and freezes a module's tool set declaration. Tool validation
 * reuses `snapshotModuleAgentToolBase` for the same reason
 * `snapshotModuleChatMode` does — the three tool contracts (per-run agent
 * tools, chat mode tools, tool sets) must not validate divergently.
 */
export function snapshotModuleToolSet(
  set: YoloModuleToolSetV1,
): YoloModuleToolSetV1 {
  if (!set || typeof set !== 'object') {
    throw new TypeError('Module tool set must be an object')
  }
  if (typeof set.id !== 'string' || !MODULE_TOOL_SET_ID_RE.test(set.id)) {
    throw new TypeError('Module tool set id must match ^[a-z][a-z0-9_]*$')
  }
  const label = snapshotLocalizedText(set.label, 'Module tool set label')
  const description =
    set.description === undefined
      ? undefined
      : snapshotLocalizedText(set.description, 'Module tool set description')
  if (!MODULE_TOOL_SET_CATEGORIES.has(set.category)) {
    throw new Error('Module tool set category is invalid')
  }
  return Object.freeze({
    id: set.id,
    label,
    ...(description !== undefined ? { description } : {}),
    category: set.category,
    tools: snapshotToolSetTools(set.tools),
  })
}

function snapshotToolSetTools(
  tools: readonly YoloModuleAgentToolV1[],
): readonly YoloModuleAgentToolV1[] {
  if (!Array.isArray(tools)) {
    throw new TypeError('Module tool set tools must be an array')
  }
  if (tools.length === 0) {
    throw new Error('Module tool set must declare at least one tool')
  }
  if (tools.length > MAX_MODULE_AGENT_TOOLS) {
    throw new Error(
      `Module tool set tools must not exceed ${MAX_MODULE_AGENT_TOOLS}`,
    )
  }
  const snapped = tools.map(snapshotModuleAgentToolBase)
  const names = new Set<string>()
  for (const tool of snapped) {
    if (names.has(tool.name)) {
      throw new Error(`Module tool set tool name "${tool.name}" is duplicated`)
    }
    names.add(tool.name)
  }
  return Object.freeze(snapped)
}
