import { AssistantWorkspaceScope } from '../../types/assistant.types'

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
// For batch-capable tools (fs_create_file/delete_file/create_dir/delete_dir/move),
// items[] is inspected via ITEM_PATH_KEYS below.
const TOOL_TOP_LEVEL_PATH_KEYS: Record<string, readonly string[]> = {
  fs_list: ['path'],
  fs_read: ['paths'],
  fs_search: ['path'],
  fs_edit: ['path'],
  fs_create_file: ['path'],
  fs_delete_file: ['path'],
  fs_create_dir: ['path'],
  fs_delete_dir: ['path'],
  fs_move: ['oldPath', 'newPath'],
}

const TOOL_ITEM_PATH_KEYS: Record<string, readonly string[]> = {
  fs_create_file: ['path'],
  fs_delete_file: ['path'],
  fs_create_dir: ['path'],
  fs_delete_dir: ['path'],
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
 * Collect every vault path referenced by a local fs_* tool call's args —
 * including nested `items[]` entries for batch write operations. Returns an
 * empty array for non-local or unrecognized tools; callers may treat that as
 * "no path constraints apply".
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
  const itemKeys = TOOL_ITEM_PATH_KEYS[toolName]
  if (itemKeys && Array.isArray(args.items)) {
    for (const item of args.items) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      for (const key of itemKeys) {
        for (const p of extractStringsFrom(record[key])) {
          const trimmed = p.trim()
          if (trimmed !== '') paths.push(trimmed)
        }
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
export function findPathOutsideScope(
  toolName: string,
  args: Record<string, unknown> | undefined,
  scope: AssistantWorkspaceScope | undefined,
): string | null {
  if (!scope?.enabled) return null
  const paths = collectToolCallPaths(toolName, args)
  for (const path of paths) {
    if (!isPathAllowedByScope(path, scope)) return path
  }
  return null
}
