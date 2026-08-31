/**
 * Shared include/exclude scope semantics for `KnowledgeBase.include`/
 * `exclude` — normalized vault-relative path prefixes, no glob patterns.
 * Mirrors the UI model in `components/settings/scope/scopeRules.ts`
 * (`scopeRuleMatches`/`matchesScope`) and the workspace-scope model in
 * `core/agent/workspaceScope.ts` (`matchesRule`/`matchesAny`): **any exclude
 * hit wins; an empty include list means everything; otherwise the path must
 * hit an include rule.** Kept as an independent copy (not a shared import
 * across those two) to avoid a `database/` ⇄ `core/` layering cycle — see
 * this module's two call sites, `VectorManager.listIndexableFiles` (database
 * layer) and `ragAutoUpdateService.isPathSelected` (core/rag layer).
 */

function normalizeScopePath(raw: string): string {
  return raw.replace(/^\/+/, '').replace(/\/+$/, '')
}

function matchesRule(path: string, rule: string): boolean {
  const p = normalizeScopePath(path)
  const r = normalizeScopePath(rule)
  if (r === '') return true
  return p === r || p.startsWith(`${r}/`)
}

export function matchesIncludeExcludeScope(
  path: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  if (exclude.some((rule) => matchesRule(path, rule))) return false
  if (include.length === 0) return true
  return include.some((rule) => matchesRule(path, rule))
}
