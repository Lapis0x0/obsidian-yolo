import { AssistantWorkspaceScope } from '../../../types/assistant.types'

/**
 * Pure semantics for the unified scope editor.
 *
 * The one rule everything here obeys, because the backends
 * (`ragAutoUpdateService` / `VectorManager` / `workspaceScope`) obey it:
 * **a path matching any exclude rule is out; otherwise an empty include list
 * means everything, and a non-empty one means the path must match an include
 * rule.** There is deliberately no "nearest ancestor wins" logic — that would
 * let the UI promise something retrieval and the agent tools would not honor.
 */

export type ScopeRuleKind = 'include' | 'exclude'

/** A single scope rule. `path` is a normalized vault-relative path without
 * leading/trailing slashes; `''` is the vault root (only reachable from
 * legacy data — the tree never offers a root row). */
export type ScopeRule = { path: string; kind: ScopeRuleKind }

export type ScopePathKind = 'folder' | 'file'

export type ScopeVariant = 'rag' | 'agent'

export function normalizeScopePath(raw: string): string {
  return raw.replace(/^\/+/, '').replace(/\/+$/, '')
}

/** Parent path, or `null` above the root. `'a'`'s parent is the root `''`. */
function parentOf(path: string): string | null {
  if (path === '') return null
  const separator = path.lastIndexOf('/')
  return separator === -1 ? '' : path.slice(0, separator)
}

/** Backend matching semantics: a rule covers itself and its subtree; the root
 * rule covers everything. */
export function scopeRuleMatches(path: string, rulePath: string): boolean {
  if (rulePath === '') return true
  return path === rulePath || path.startsWith(`${rulePath}/`)
}

function findRule(
  rules: readonly ScopeRule[],
  path: string,
): ScopeRule | undefined {
  return rules.find((rule) => normalizeScopePath(rule.path) === path)
}

export function hasIncludeRule(rules: readonly ScopeRule[]): boolean {
  return rules.some((rule) => rule.kind === 'include')
}

export function findRuleKind(
  rules: readonly ScopeRule[],
  path: string,
): ScopeRuleKind | null {
  return findRule(rules, normalizeScopePath(path))?.kind ?? null
}

export type EffectiveScopeState = {
  state: 'include' | 'exclude'
  /** The rule path this state comes from, or `null` when it falls out of the
   * global default (no rule on the ancestor chain). */
  source: string | null
}

/**
 * What actually happens to `path` under `rules`, plus which rule decides it.
 * Mirrors the backend: any exclude on the ancestor chain (including the path
 * itself) wins; otherwise an include on the chain wins; otherwise the default
 * flips with whether any include rule exists at all.
 */
export function effectiveState(
  path: string,
  rules: readonly ScopeRule[],
): EffectiveScopeState {
  let cursor: string | null = normalizeScopePath(path)
  let nearestInclude: string | null = null
  while (cursor !== null) {
    const rule = findRule(rules, cursor)
    if (rule?.kind === 'exclude') return { state: 'exclude', source: cursor }
    if (rule?.kind === 'include' && nearestInclude === null) {
      nearestInclude = cursor
    }
    cursor = parentOf(cursor)
  }
  if (nearestInclude !== null) {
    return { state: 'include', source: nearestInclude }
  }
  return {
    state: hasIncludeRule(rules) ? 'exclude' : 'include',
    source: null,
  }
}

export type ScopeRuleDisabledReason = {
  kind: 'excludedAncestor' | 'includedAncestor'
  ancestor: string
}

/**
 * Why `kind` cannot be marked on `path`, or `null` when it can.
 * - An excluded ancestor makes both marks meaningless (exclude wins anyway).
 * - An included ancestor makes a further `include` redundant, while `exclude`
 *   stays available (that is how "include A but not A/B" is expressed).
 */
export function ruleDisabledReason(
  path: string,
  kind: ScopeRuleKind,
  rules: readonly ScopeRule[],
): ScopeRuleDisabledReason | null {
  let cursor = parentOf(normalizeScopePath(path))
  let nearestIncludeAncestor: string | null = null
  while (cursor !== null) {
    const rule = findRule(rules, cursor)
    if (rule?.kind === 'exclude') {
      return { kind: 'excludedAncestor', ancestor: cursor }
    }
    if (rule?.kind === 'include' && nearestIncludeAncestor === null) {
      nearestIncludeAncestor = cursor
    }
    cursor = parentOf(cursor)
  }
  if (kind === 'include' && nearestIncludeAncestor !== null) {
    return { kind: 'includedAncestor', ancestor: nearestIncludeAncestor }
  }
  return null
}

/**
 * Set (`kind`) or clear (`null`) the mark on `path`, keeping the rule list
 * minimal: an exclude absorbs every descendant rule, an include absorbs
 * descendant includes only. A mark `ruleDisabledReason` rejects is a no-op.
 */
export function applyRule(
  rules: readonly ScopeRule[],
  path: string,
  kind: ScopeRuleKind | null,
): ScopeRule[] {
  const target = normalizeScopePath(path)
  if (kind === null) {
    return rules.filter((rule) => normalizeScopePath(rule.path) !== target)
  }
  if (ruleDisabledReason(target, kind, rules)) return [...rules]

  const isDescendant = (candidate: string): boolean =>
    target === '' ? candidate !== '' : candidate.startsWith(`${target}/`)

  const kept = rules.filter((rule) => {
    const rulePath = normalizeScopePath(rule.path)
    if (rulePath === target) return false
    if (isDescendant(rulePath)) {
      return kind === 'exclude' ? false : rule.kind !== 'include'
    }
    return true
  })
  return [...kept, { path: target, kind }]
}

/** Order-insensitive equality; used to decide whether "reset" has anything
 * to do and whether a rule set is already the default. */
export function isSameRules(
  a: readonly ScopeRule[],
  b: readonly ScopeRule[],
): boolean {
  if (a.length !== b.length) return false
  const key = (rule: ScopeRule) => `${rule.kind}:${rule.path}`
  const set = new Set(a.map(key))
  return b.every((rule) => set.has(key(rule)))
}

export type ScopeRuleCounts = { folders: number; files: number; total: number }

export type ScopeDescription = {
  hasInclude: boolean
  include: ScopeRuleCounts
  /** Excludes the status sentence should mention. With no include rules that
   * is all of them; with include rules only those nested inside an include
   * rule actually narrow anything, so the rest stay in the rule list but out
   * of the sentence. */
  exclude: ScopeRuleCounts
}

function countRules(
  rules: readonly ScopeRule[],
  kindOf: (path: string) => ScopePathKind,
): ScopeRuleCounts {
  let folders = 0
  let files = 0
  for (const rule of rules) {
    if (kindOf(normalizeScopePath(rule.path)) === 'file') files += 1
    else folders += 1
  }
  return { folders, files, total: folders + files }
}

export function describeScope(
  rules: readonly ScopeRule[],
  kindOf: (path: string) => ScopePathKind,
): ScopeDescription {
  const includes = rules.filter((rule) => rule.kind === 'include')
  const excludes = rules.filter((rule) => rule.kind === 'exclude')
  const relevantExcludes =
    includes.length === 0
      ? excludes
      : excludes.filter((rule) => {
          const path = normalizeScopePath(rule.path)
          return includes.some((include) => {
            const includePath = normalizeScopePath(include.path)
            return path.startsWith(`${includePath}/`)
          })
        })
  return {
    hasInclude: includes.length > 0,
    include: countRules(includes, kindOf),
    exclude: countRules(relevantExcludes, kindOf),
  }
}

/** Folder/file names for a knowledge-base card's compact scope line
 * ("仅 工作/、项目/"), last path segment, folders keep a trailing slash. */
export function includeScopeLabels(
  rules: readonly ScopeRule[],
  kindOf: (path: string) => ScopePathKind,
): string[] {
  const labels: string[] = []
  for (const rule of rules) {
    if (rule.kind !== 'include') continue
    const path = normalizeScopePath(rule.path)
    const base =
      path === '' ? '' : path.slice(Math.max(0, path.lastIndexOf('/') + 1))
    if (base === '') continue
    labels.push(kindOf(path) === 'file' ? base : `${base}/`)
  }
  return labels
}

/** Whether a concrete file path survives `rules` — the same judgment the
 * backends make. */
export function matchesScope(
  path: string,
  rules: readonly ScopeRule[],
): boolean {
  const normalized = normalizeScopePath(path)
  for (const rule of rules) {
    if (
      rule.kind === 'exclude' &&
      scopeRuleMatches(normalized, normalizeScopePath(rule.path))
    ) {
      return false
    }
  }
  const includes = rules.filter((rule) => rule.kind === 'include')
  if (includes.length === 0) return true
  return includes.some((rule) =>
    scopeRuleMatches(normalized, normalizeScopePath(rule.path)),
  )
}

export function estimateFiles(
  candidates: readonly string[],
  rules: readonly ScopeRule[],
): { matched: number; total: number } {
  let matched = 0
  for (const path of candidates) {
    if (matchesScope(path, rules)) matched += 1
  }
  return { matched, total: candidates.length }
}

/** Candidate-file count per folder path (a folder counts every file in its
 * subtree). The root `''` holds the grand total. */
export function buildFolderFileCounts(
  candidates: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    const path = normalizeScopePath(candidate)
    let cursor: string | null = parentOf(path)
    while (cursor !== null) {
      counts.set(cursor, (counts.get(cursor) ?? 0) + 1)
      cursor = parentOf(cursor)
    }
  }
  return counts
}

/* ------------------------------------------------------------------ */
/* include/exclude-array persistence                                    */
/* ------------------------------------------------------------------ */

/**
 * Shared by every consumer whose scope is stored as plain `include`/
 * `exclude` path arrays — the agent workspace (`AssistantWorkspaceScope`)
 * and knowledge bases (`KnowledgeBase`) alike. RAG's index scope used to be
 * glob patterns plus a separate `excludeYoloBaseDir` flag; that conversion
 * is gone now that the YOLO base dir is excluded unconditionally by the
 * engine (`getYoloBaseDir`), outside any UI rule, and each knowledge base
 * stores `include`/`exclude` directly in this same shape.
 */
export function rulesFromWorkspaceScope(
  scope: Pick<AssistantWorkspaceScope, 'include' | 'exclude'>,
): ScopeRule[] {
  return [
    ...scope.include.map((path) => ({
      path: normalizeScopePath(path),
      kind: 'include' as const,
    })),
    ...scope.exclude.map((path) => ({
      path: normalizeScopePath(path),
      kind: 'exclude' as const,
    })),
  ]
}

export function workspaceScopeFromRules(rules: readonly ScopeRule[]): {
  include: string[]
  exclude: string[]
} {
  return {
    include: rules
      .filter((rule) => rule.kind === 'include')
      .map((rule) => normalizeScopePath(rule.path)),
    exclude: rules
      .filter((rule) => rule.kind === 'exclude')
      .map((rule) => normalizeScopePath(rule.path)),
  }
}
