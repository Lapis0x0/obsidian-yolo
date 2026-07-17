import { normalizePath } from 'obsidian'

import { AssistantWorkspaceScope } from '../../types/assistant.types'

export const BUILTIN_SKILL_PATH_PREFIX = 'builtin://'
export const BROWSER_READ_PATH_PREFIX = 'browser://'

const normalize = (raw: string): string =>
  raw.replace(/^\/+/, '').replace(/\/+$/, '')

function matchesRule(path: string, rule: string): boolean {
  const p = normalize(path)
  const r = normalize(rule)
  if (r === '') return true
  if (p === r) return true
  return p.startsWith(r + '/')
}

function matchesAny(path: string, rules: readonly string[]): boolean {
  for (const rule of rules) {
    if (matchesRule(path, rule)) return true
  }
  return false
}

export function isPathAllowedByScope(
  path: string,
  scope: AssistantWorkspaceScope | undefined,
): boolean {
  if (!scope || !scope.enabled) return true
  if (matchesAny(path, scope.exclude)) return false
  if (scope.include.length === 0) return true
  return matchesAny(path, scope.include)
}

export function isWorkspaceScopeActive(
  scope: AssistantWorkspaceScope | undefined,
): boolean {
  if (!scope || !scope.enabled) return false
  return scope.include.length > 0 || scope.exclude.length > 0
}

// Top-level arg keys that may carry a vault path for a given fs_* tool.
// Value can be a string (single path) or an array of strings (e.g. fs_read.paths).
const TOOL_TOP_LEVEL_PATH_KEYS: Record<string, readonly string[]> = {
  fs_list: ['path'],
  fs_read: ['paths'],
  fs_search: ['path'],
  fs_edit: ['path'],
  fs_write: ['path'],
  fs_delete: ['path'],
  fs_create_dir: ['path'],
  fs_move: ['oldPath', 'newPath'],
}

function extractStringsFrom(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }
  return []
}

/**
 * Collect every vault path referenced by a local fs_* tool call's args.
 * Returns an empty array for non-local or unrecognized tools; callers may
 * treat that as "no path constraints apply".
 */
export function collectToolCallPaths(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string[] {
  if (!args) return []
  const paths: string[] = []
  const topKeys = TOOL_TOP_LEVEL_PATH_KEYS[toolName]
  if (topKeys) {
    for (const key of topKeys) {
      for (const p of extractStringsFrom(args[key])) {
        const trimmed = p.trim()
        if (trimmed !== '') paths.push(trimmed)
      }
    }
  }
  return paths
}

/**
 * Validate all paths referenced by a tool call against a workspace scope.
 * Returns the first out-of-scope path (for error messaging), or null if all
 * paths are allowed / scope is disabled / tool has no path args.
 */
export function normalizeSkillPathForExemption(path: string): string {
  const trimmed = path.trim()
  if (
    trimmed.startsWith(BUILTIN_SKILL_PATH_PREFIX) ||
    trimmed.startsWith(BROWSER_READ_PATH_PREFIX)
  ) {
    return trimmed
  }
  return normalizePath(trimmed)
}

export function buildAllowedSkillPathSet(
  paths: readonly string[],
): Set<string> {
  return new Set(paths.map(normalizeSkillPathForExemption))
}

export function findPathOutsideScope(
  toolName: string,
  args: Record<string, unknown> | undefined,
  scope: AssistantWorkspaceScope | undefined,
  options?: { exemptPaths?: ReadonlySet<string> },
): string | null {
  if (!scope?.enabled) return null
  const paths = collectToolCallPaths(toolName, args)
  for (const path of paths) {
    const trimmed = path.trim()
    if (
      trimmed.startsWith(BUILTIN_SKILL_PATH_PREFIX) ||
      trimmed.startsWith(BROWSER_READ_PATH_PREFIX)
    ) {
      continue
    }
    if (options?.exemptPaths?.has(normalizeSkillPathForExemption(path))) {
      continue
    }
    if (!isPathAllowedByScope(path, scope)) return path
  }
  return null
}
