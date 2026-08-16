import type { InProcessToolServer } from '../mcp/inProcessToolServer'
import { RESERVED_MODULE_MODE_SERVER_PREFIX } from '../mcp/tool-name-utils'
import { SKILL_PACKAGE_ENTRY_FILE_NAME } from '../skills/liteSkills'

import {
  MAX_MODULE_AGENT_TOOLS,
  createModuleToolInProcessServer,
  snapshotModuleAgentToolBase,
} from './moduleAgent'
import { snapshotLocalizedText } from './moduleI18n'
import { resolveModuleSkillPackageName } from './moduleSkillMaterializer'
import {
  canonicalArtifactPath,
  normalizeModuleArtifactFilePath,
} from './moduleStore'
import type {
  YoloModuleAgentCapabilityV1,
  YoloModuleChatModeToolV1,
  YoloModuleChatModeV1,
} from './types'

/** Mode-local id format — see `YoloModuleChatModeV1.id`. */
export const MODULE_CHAT_MODE_LOCAL_ID_RE = /^[a-z][a-z0-9-]*$/
export const MAX_MODULE_CHAT_MODES_PER_MODULE = 4
/** Matches `MAX_MODULE_ARTIFACT_FILES` headroom — a mode's skills are a
 * small curated set, not a bulk asset manifest. */
export const MAX_MODULE_CHAT_MODE_SKILLS = 16

const MODULE_CHAT_MODE_CAPABILITIES: ReadonlySet<YoloModuleAgentCapabilityV1> =
  new Set(['none', 'vault-read', 'vault-write'])

export function buildModuleChatModeFullId(
  moduleId: string,
  modeId: string,
): string {
  return `module:${moduleId}:${modeId}`
}

/** `module-mode-<moduleId>-<modeId>` — see `RESERVED_MODULE_MODE_SERVER_PREFIX`. */
export function buildModuleChatModeServerName(
  moduleId: string,
  modeId: string,
): string {
  return `${RESERVED_MODULE_MODE_SERVER_PREFIX}${moduleId}-${modeId}`
}

export type ModuleChatModeAvailabilityV1 =
  | Readonly<{ status: 'available' }>
  | Readonly<{ status: 'unavailable'; reason: string }>

export type RegisteredModuleChatModeV1 = Readonly<{
  fullModeId: string
  moduleId: string
  mode: YoloModuleChatModeV1
  serverName: string
  availability: ModuleChatModeAvailabilityV1
}>

export type ModuleChatModeContributionSinkV1 = Readonly<{
  add(moduleId: string, mode: YoloModuleChatModeV1): void
  remove(moduleId: string, modeId: string): void
}>

const AVAILABLE: ModuleChatModeAvailabilityV1 = Object.freeze({
  status: 'available',
})

/**
 * Host-wide directory of published module chat modes: `Map` keyed by full
 * mode id (`module:<moduleId>:<modeId>`) + frozen snapshot + `subscribe`,
 * mirroring `ModuleSettingsContributionRegistry`. `McpCoordinator` consumes
 * `getSnapshot`/`subscribe` to replay each entry as an in-process MCP tool
 * server and reports registration outcomes back through `setAvailability`.
 */
export class ModuleChatModeRegistry
  implements ModuleChatModeContributionSinkV1
{
  private readonly entries = new Map<string, RegisteredModuleChatModeV1>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly RegisteredModuleChatModeV1[] = Object.freeze([])

  add(moduleId: string, mode: YoloModuleChatModeV1): void {
    const fullModeId = buildModuleChatModeFullId(moduleId, mode.id)
    this.entries.set(
      fullModeId,
      Object.freeze({
        fullModeId,
        moduleId,
        mode,
        serverName: buildModuleChatModeServerName(moduleId, mode.id),
        availability: AVAILABLE,
      }),
    )
    this.updateSnapshot()
    this.emit()
  }

  remove(moduleId: string, modeId: string): void {
    if (!this.entries.delete(buildModuleChatModeFullId(moduleId, modeId))) {
      return
    }
    this.updateSnapshot()
    this.emit()
  }

  /** Called by `McpCoordinator` to report a mode's live registration outcome. */
  setAvailability(
    fullModeId: string,
    availability: ModuleChatModeAvailabilityV1,
  ): void {
    const existing = this.entries.get(fullModeId)
    if (!existing || sameAvailability(existing.availability, availability)) {
      return
    }
    this.entries.set(fullModeId, Object.freeze({ ...existing, availability }))
    this.updateSnapshot()
    this.emit()
  }

  getSnapshot = (): readonly RegisteredModuleChatModeV1[] => this.snapshot

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
        left.fullModeId.localeCompare(right.fullModeId),
      ),
    )
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function sameAvailability(
  left: ModuleChatModeAvailabilityV1,
  right: ModuleChatModeAvailabilityV1,
): boolean {
  if (left.status !== right.status) return false
  return (
    left.status !== 'unavailable' ||
    right.status !== 'unavailable' ||
    left.reason === right.reason
  )
}

/**
 * Validates and freezes a module's chat mode declaration. Tool validation
 * reuses `snapshotModuleAgentToolBase` from `moduleAgent.ts` (name format,
 * description, inputSchema, handler) so the two tool contracts cannot
 * validate divergently, then layers on `requiresApproval`.
 *
 * `skills` validation here is format-only: each entry must be a safe
 * artifact-relative package path ending in `SKILL.md` (reusing
 * `normalizeModuleArtifactFilePath`'s rules), deduped and capped.
 * Cross-checking an entry against the module's actual verified manifest
 * (does a `role: 'data'` file exist at this path?) cannot happen here — this
 * function runs synchronously inside `chat.registerMode(...)`, called from
 * the module's own `activate()`, before the module's `VerifiedModuleArtifact`
 * is published. That check happens once the artifact is published, when the
 * package is projected into the Vault (`moduleSkillMaterializer.ts`).
 */
export function snapshotModuleChatMode(
  mode: YoloModuleChatModeV1,
): YoloModuleChatModeV1 {
  if (!mode || typeof mode !== 'object') {
    throw new TypeError('Module chat mode must be an object')
  }
  if (
    typeof mode.id !== 'string' ||
    !MODULE_CHAT_MODE_LOCAL_ID_RE.test(mode.id)
  ) {
    throw new TypeError('Module chat mode id must match ^[a-z][a-z0-9-]*$')
  }
  const label = snapshotLocalizedText(mode.label, 'Module chat mode label')
  const description =
    mode.description === undefined
      ? undefined
      : snapshotLocalizedText(mode.description, 'Module chat mode description')
  if (
    mode.icon !== undefined &&
    (typeof mode.icon !== 'string' || !mode.icon.trim())
  ) {
    throw new TypeError('Module chat mode icon must be a non-empty string')
  }
  if (typeof mode.personaPrompt !== 'string' || !mode.personaPrompt.trim()) {
    throw new TypeError(
      'Module chat mode persona prompt must be a non-empty string',
    )
  }
  if (!MODULE_CHAT_MODE_CAPABILITIES.has(mode.capability)) {
    throw new Error('Module chat mode capability is invalid')
  }
  const tools =
    mode.tools === undefined ? undefined : snapshotChatModeTools(mode.tools)
  const skills =
    mode.skills === undefined ? undefined : snapshotChatModeSkills(mode.skills)
  return Object.freeze({
    id: mode.id,
    label,
    ...(description !== undefined ? { description } : {}),
    ...(mode.icon !== undefined ? { icon: mode.icon } : {}),
    personaPrompt: mode.personaPrompt,
    capability: mode.capability,
    ...(tools !== undefined ? { tools } : {}),
    ...(skills !== undefined ? { skills } : {}),
  })
}

function snapshotChatModeSkills(skills: readonly string[]): readonly string[] {
  if (!Array.isArray(skills)) {
    throw new TypeError('Module chat mode skills must be an array')
  }
  if (skills.length > MAX_MODULE_CHAT_MODE_SKILLS) {
    throw new Error(
      `Module chat mode skills must not exceed ${MAX_MODULE_CHAT_MODE_SKILLS}`,
    )
  }
  const seen = new Set<string>()
  // Canonical keys, matching `planModuleSkillPackages`: two declarations that
  // differ only in case or Unicode form are distinct manifest paths but one
  // projected directory on macOS and Windows.
  const packageNames = new Set<string>()
  const normalized = skills.map((skill) => {
    if (typeof skill !== 'string') {
      throw new TypeError('Module chat mode skill path must be a string')
    }
    let normalizedPath: string
    try {
      normalizedPath = normalizeModuleArtifactFilePath(skill)
    } catch {
      throw new Error(
        `Module chat mode skill path "${skill}" must be a safe relative artifact path`,
      )
    }
    const packageName = resolveModuleSkillPackageName(normalizedPath)
    if (!packageName) {
      throw new Error(
        `Module chat mode skill "${skill}" must be a package path ending in "${SKILL_PACKAGE_ENTRY_FILE_NAME}"`,
      )
    }
    const canonicalPath = canonicalArtifactPath(normalizedPath)
    const packageKey = canonicalArtifactPath(packageName)
    if (seen.has(canonicalPath)) {
      throw new Error(
        `Module chat mode skill "${normalizedPath}" is duplicated`,
      )
    }
    if (packageNames.has(packageKey)) {
      throw new Error(
        `Module chat mode skill package "${packageName}" is declared twice`,
      )
    }
    seen.add(canonicalPath)
    packageNames.add(packageKey)
    return normalizedPath
  })
  return Object.freeze(normalized)
}

function snapshotChatModeTools(
  tools: readonly YoloModuleChatModeToolV1[],
): readonly YoloModuleChatModeToolV1[] {
  if (!Array.isArray(tools)) {
    throw new TypeError('Module chat mode tools must be an array')
  }
  if (tools.length > MAX_MODULE_AGENT_TOOLS) {
    throw new Error(
      `Module chat mode tools must not exceed ${MAX_MODULE_AGENT_TOOLS}`,
    )
  }
  const snapped = tools.map(snapshotChatModeTool)
  const names = new Set<string>()
  for (const tool of snapped) {
    if (names.has(tool.name)) {
      throw new Error(`Module chat mode tool name "${tool.name}" is duplicated`)
    }
    names.add(tool.name)
  }
  return Object.freeze(snapped)
}

function snapshotChatModeTool(
  tool: YoloModuleChatModeToolV1,
): YoloModuleChatModeToolV1 {
  const base = snapshotModuleAgentToolBase(tool)
  const requiresApproval = tool.requiresApproval
  if (requiresApproval !== undefined && typeof requiresApproval !== 'boolean') {
    throw new TypeError(
      'Module chat mode tool requiresApproval must be a boolean',
    )
  }
  return Object.freeze({
    ...base,
    ...(requiresApproval !== undefined ? { requiresApproval } : {}),
  })
}

/** Builds the in-process tool server for a mode's declared tools. */
export function createModuleChatModeToolServer(
  tools: readonly YoloModuleChatModeToolV1[],
): InProcessToolServer {
  return createModuleToolInProcessServer(tools)
}
