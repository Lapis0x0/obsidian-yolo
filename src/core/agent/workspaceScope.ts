import { normalizePath } from 'obsidian'

import { AssistantWorkspaceScope } from '../../types/assistant.types'
import {
  type YoloSettingsLike,
  getYoloUserDataRootDir,
  isWithinYoloUserDataRoot,
} from '../paths/yoloPaths'

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

/**
 * True when `path` is a strict or equal ancestor of some `scope.include`
 * rule. An include-list scope only names the deepest allowed folder (e.g.
 * `include: ["Projects/Client"]`), but a traversal operation (`ls`,
 * `$vault.list`) needs to descend through `Projects` to reach it — so
 * ancestors of an include rule must stay listable even though they fail the
 * direct `isPathAllowedByScope` check (their own content isn't in scope,
 * only the path to reach an in-scope descendant is). Shared by
 * `vaultBashFileSystem.ts` (bash `ls`/`find`) and `jsSandboxTool.ts`
 * (`$vault.list`) — both traversal-style tools need the same carve-out.
 */
export function isAncestorOfIncludeRule(
  path: string,
  scope: AssistantWorkspaceScope,
): boolean {
  if (scope.include.length === 0) return false
  const normalizedPath = normalize(path)
  return scope.include.some((rule) => {
    const normalizedRule = normalize(rule)
    return (
      normalizedRule === normalizedPath ||
      normalizedRule.startsWith(
        normalizedPath === '' ? '' : `${normalizedPath}/`,
      )
    )
  })
}

/**
 * Scope-only visibility for traversal operations: more permissive than
 * `resolvePathVisibility`'s direct "can the agent read this content" check,
 * because listing must be able to descend through an include rule's
 * ancestor directories to reach it (`isAncestorOfIncludeRule`). Deliberately
 * does not consider `hidden` — traversal callers apply that separately
 * (typically per-entry, alongside their own listing logic), since hidden
 * paths don't get the ancestor carve-out: the YOLO user-data root must stay
 * invisible even as a bare directory entry on the way to something else.
 */
export function isVisibleForTraversal(
  path: string,
  scope: AssistantWorkspaceScope | undefined,
): boolean {
  if (!scope?.enabled) return true
  return (
    isPathAllowedByScope(path, scope) || isAncestorOfIncludeRule(path, scope)
  )
}

/**
 * `visible`: the agent may read/write this path outright.
 * `hidden`: the path lives inside the YOLO user-data root
 * (`isWithinYoloUserDataRoot`) and must be reported as though it doesn't
 * exist — see `describePathDenial`'s doc comment for why.
 * `out-of-scope`: the path is real and not secret, but falls outside the
 * agent's configured workspace scope — an autonomy boundary, not a
 * confidentiality one (see the module doc below `isPathAllowedByScope`).
 */
export type PathVisibility = 'visible' | 'hidden' | 'out-of-scope'

/**
 * The single judgment every call site that decides "can the agent touch
 * this vault path" should defer to, for an already-resolved, literal vault
 * path (not a raw tool argument that might still be a wikilink — see
 * `describePathDenial`'s doc comment). Before this existed, `fs_read`,
 * `security-boundary.ts`, `vaultBashFileSystem.ts`, `vaultBashSearch.ts`,
 * and `jsSandboxTool.ts` each re-paired `isWithinYoloUserDataRoot` +
 * `isPathAllowedByScope` by hand, and the priority between them (hidden
 * always wins, unconditionally) was implicit in call order rather than
 * enforced — issue #577.
 *
 * Priority is fixed: `hidden` is checked first and wins regardless of
 * whether workspace scope is even enabled, because the YOLO user-data root
 * must stay invisible unconditionally (see `isWithinYoloUserDataRoot`).
 * Only once a path clears that does workspace scope apply, with the same
 * skill-package exemption `findPathOutsideScope` already carries.
 */
export function resolvePathVisibility(
  path: string,
  options: {
    scope?: AssistantWorkspaceScope
    settings?: YoloSettingsLike | null
    exemptPaths?: ReadonlySet<string>
  },
): PathVisibility {
  if (isWithinYoloUserDataRoot(path, options.settings)) {
    return 'hidden'
  }
  if (
    options.scope?.enabled &&
    !isPathAllowedByScope(path, options.scope) &&
    !(
      options.exemptPaths &&
      isCoveredBySkillPathExemption(path, options.exemptPaths)
    )
  ) {
    return 'out-of-scope'
  }
  return 'visible'
}

/**
 * Builds the model-facing denial message for a non-`visible` path.
 *
 * `requestedInput` MUST be the exact string the agent supplied in its tool
 * call — e.g. a still-unresolved wikilink target like `"[[Secret]]"` — and
 * NEVER a path resolved from it (e.g. the real vault path a wikilink
 * resolves to, or a `TFile.path` read off a resolved file). This is
 * issue #577's root cause: `fs_read`'s out-of-scope error used to echo the
 * *resolved* path, so an agent that had no way to know `[[Secret]]` pointed
 * outside its workspace scope learned the real path anyway, purely from
 * being told "no". Accepting only `requestedInput` here (never a resolved
 * `TFile`/path value) makes that leak impossible to reintroduce by
 * accident — there is no parameter to smuggle a resolved path through.
 */
export function describePathDenial(
  visibility: 'hidden' | 'out-of-scope',
  requestedInput: string,
  kind: 'file' | 'folder' = 'file',
): string {
  if (visibility === 'hidden') {
    // Same wording a genuine miss gets — deliberately indistinguishable
    // from "doesn't exist" so nothing about "this path is specially
    // hidden" leaks to the model (see `isWithinYoloUserDataRoot`'s callers
    // for the full rationale).
    return kind === 'folder'
      ? `Folder not found: ${requestedInput}`
      : `File not found: ${requestedInput}`
  }
  // Unlike `hidden`, workspace scope is not a confidentiality boundary
  // (user-driven access — @-references, the active file — bypasses it
  // entirely; see the module doc above). Disguising this as a missing file
  // would make the model falsely tell the user the file doesn't exist, so
  // it gets an explicit denial instead.
  return `Path "${requestedInput}" is outside this agent's workspace scope.`
}

// Top-level arg keys that may carry a vault path for a given fs_* tool.
// Value can be a string (single path) or an array of strings.
//
// fs_read is intentionally absent: its `paths` entries may be Obsidian
// wikilink targets (e.g. "[[Note#Heading]]") rather than literal vault
// paths, which this raw-string check cannot resolve. Scope is instead
// enforced inside fs_read's own read loop, per resolved TFile, before any
// content is read — see the wikilink resolution + scope check in
// localFileTools.ts's `case 'fs_read'`.
const TOOL_TOP_LEVEL_PATH_KEYS: Record<string, readonly string[]> = {
  fs_list: ['path'],
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

export function isCoveredBySkillPathExemption(
  path: string,
  exemptPaths: ReadonlySet<string>,
): boolean {
  const normalizedPath = normalizeSkillPathForExemption(path)
  if (exemptPaths.has(normalizedPath)) return true

  for (const skillPath of exemptPaths) {
    if (!skillPath.endsWith('/SKILL.md')) continue
    const packageDir = skillPath.slice(0, -'/SKILL.md'.length)
    if (normalizedPath.startsWith(`${packageDir}/`)) return true
  }
  return false
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
    if (
      options?.exemptPaths &&
      isCoveredBySkillPathExemption(path, options.exemptPaths)
    ) {
      continue
    }
    if (!isPathAllowedByScope(path, scope)) return path
  }
  return null
}

/**
 * Generic version of `findPathOutsideScope` for any other reason a local
 * fs_* tool's literal path args might need to be rejected wholesale —
 * currently used to keep the YOLO user-data root (`<baseDir>/data`) invisible
 * to agent tools (see `isWithinYoloUserDataRoot` in `core/paths/yoloPaths.ts`
 * and its caller in `security-boundary.ts`). Takes a generic `isExcluded`
 * predicate rather than calling `isWithinYoloUserDataRoot` itself so callers
 * that already have their own exclusion reason can reuse the same
 * multi-arg-path iteration (this file depends on `core/paths` anyway now,
 * via `resolvePathVisibility` above).
 *
 * Like `findPathOutsideScope`, `fs_read` is out of scope here: its `paths`
 * entries may be wikilink targets rather than literal vault paths, so it
 * enforces this same exclusion itself, post-resolution (see `case 'fs_read'`
 * in `localFileTools.ts`).
 */
export function findPathWithinExcludedRoot(
  toolName: string,
  args: Record<string, unknown> | undefined,
  isExcluded: (path: string) => boolean,
): string | null {
  const paths = collectToolCallPaths(toolName, args)
  for (const path of paths) {
    const trimmed = path.trim()
    if (
      trimmed.startsWith(BUILTIN_SKILL_PATH_PREFIX) ||
      trimmed.startsWith(BROWSER_READ_PATH_PREFIX)
    ) {
      continue
    }
    if (isExcluded(path)) return path
  }
  return null
}

/** A caller-supplied path restriction to narrow RAG retrieval, e.g. a single
 * file or folder subtree resolved from `vault_search`'s `path` argument
 * (see `pathToRagScope` in `vaultSearchService.ts`). Same shape as
 * `VectorStore.performSimilaritySearch`'s `scope.files`/`scope.folders`. */
export type RagPathScope = { files: string[]; folders: string[] }

export type RagWorkspaceScopeResult =
  | { scope: { files: string[]; folders: string[]; exclude: string[] } }
  | { empty: true }

/** One path-restriction rule, tagged with how it matches a candidate path.
 * `exact` matches only the identical path (mirrors `scope.files`); `subtree`
 * matches strict descendants via a `value/` prefix, never the value itself
 * (mirrors `scope.folders`). A workspace include rule (`matchesRule`'s
 * equal-or-prefix semantics) decomposes into one of each. */
type ScopeRule = { value: string; matchKind: 'exact' | 'subtree' }

/**
 * Intersects two path-restriction rules, keeping the narrower (deeper) one
 * when they nest and dropping the pair when neither is a prefix of the
 * other. Used to compute `pathScope ∩ workspace.include` in
 * `buildRagScopeForWorkspace`: each side is a union of such rules, so the
 * full intersection is the union of every pairwise `intersectRule` result.
 */
function intersectRule(a: ScopeRule, b: ScopeRule): ScopeRule | null {
  if (a.matchKind === 'exact' && b.matchKind === 'exact') {
    return a.value === b.value ? { value: a.value, matchKind: 'exact' } : null
  }
  if (a.matchKind === 'exact' && b.matchKind === 'subtree') {
    return a.value.startsWith(`${b.value}/`)
      ? { value: a.value, matchKind: 'exact' }
      : null
  }
  if (a.matchKind === 'subtree' && b.matchKind === 'exact') {
    return b.value.startsWith(`${a.value}/`)
      ? { value: b.value, matchKind: 'exact' }
      : null
  }
  // Both subtree: whichever root is deeper (a descendant of the other, or
  // equal) is the narrower, correct intersection; unrelated roots share no
  // paths.
  if (a.value === b.value) return { value: a.value, matchKind: 'subtree' }
  if (b.value.startsWith(`${a.value}/`))
    return { value: b.value, matchKind: 'subtree' }
  if (a.value.startsWith(`${b.value}/`))
    return { value: a.value, matchKind: 'subtree' }
  return null
}

/**
 * Builds the `{ files, folders, exclude }` scope that RAG retrieval — the
 * vector-store scan predicate and `vaultSearchService`'s keyword sweeps —
 * should apply for one query, combining an assistant's workspace scope with
 * an optional caller-supplied `pathScope` (a single file or folder the
 * caller already narrowed the search to).
 *
 * - `include` (the returned `files`/`folders`) is `pathScope ∩
 *   workspace.include`: a prefix-set intersection where, for every rule pair
 *   drawn from each side, the deeper of two nesting roots is kept and
 *   unrelated (non-nesting) pairs contribute nothing (`intersectRule`). If
 *   only one side has rules, that side's rules pass through unchanged; if
 *   neither does, there is no include restriction (empty `files`/`folders`,
 *   meaning "everything"). If both sides have rules but every pairwise
 *   intersection is empty — the two restrictions share no path — the
 *   query can return no results at all, so callers get `{ empty: true }`
 *   and should short-circuit rather than run a query that can only come
 *   back empty (skipping, in particular, the cost of computing a query
 *   embedding).
 * - `exemptPaths` (the skill-package exemption `resolvePathVisibility`
 *   already carries) are merged into `files` whenever `workspace.include`
 *   is non-empty — matching `isPathAllowedByScope`'s carve-out — including
 *   when that merge is what turns an otherwise-empty intersection into a
 *   real (exempt-paths-only) scope, so an exempted skill file stays
 *   retrievable even when the workspace and path scopes would otherwise
 *   share nothing. When an explicit `pathScope` is also given, only exempt
 *   paths that themselves fall inside `pathScope` (an exact `files` match or
 *   under a `folders` subtree) are merged in — an exemption never lets a
 *   query escape a caller-supplied path restriction (e.g.
 *   `vault_search({path: "Private"})`), it only lets it escape
 *   `workspace.include`.
 * - `exclude` is `workspace.exclude` (only when `workspace.enabled`; a
 *   disabled workspace contributes no rules at all) unioned with the YOLO
 *   user-data root, which is always excluded — even when `workspace` is
 *   undefined or disabled — mirroring `resolvePathVisibility`'s
 *   unconditional hidden-root check. A normalized `workspace.exclude` rule
 *   of `''` (the user entered `/`) means "exclude everything", so that case
 *   short-circuits to `{ empty: true }` before any of the above is computed.
 *   Symmetrically, a normalized `workspace.include` rule of `''` matches
 *   every path (same as `matchesRule`), so it is treated as "no include
 *   restriction at all" rather than literally intersected — an `include`
 *   array that merely *contains* `''` alongside other rules is still fully
 *   unrestricted, since `''` alone already matches everything those other
 *   rules would.
 */
export function buildRagScopeForWorkspace({
  pathScope,
  workspace,
  settings,
  exemptPaths,
}: {
  pathScope?: RagPathScope
  workspace?: AssistantWorkspaceScope
  settings?: YoloSettingsLike | null
  exemptPaths?: ReadonlySet<string>
}): RagWorkspaceScopeResult {
  const workspaceEnabled = workspace?.enabled ?? false
  const workspaceIncludeRaw = workspaceEnabled
    ? workspace!.include.map(normalize)
    : []
  // A root rule ('' after normalizing '/') matches every path on its own
  // (see `matchesRule`), so its presence anywhere in `include` makes the
  // whole list equivalent to "no include restriction" — not a literal rule
  // to intersect against, which would instead match nothing (see the class
  // doc above and Codex finding 1.7).
  const workspaceInclude = workspaceIncludeRaw.includes('')
    ? []
    : workspaceIncludeRaw

  const workspaceExcludeRaw = workspaceEnabled
    ? workspace!.exclude.map(normalize)
    : []
  if (workspaceExcludeRaw.includes('')) {
    // A root exclude rule excludes every path; no include/exempt carve-out
    // can rescue that, so short-circuit before computing anything else.
    return { empty: true }
  }
  const workspaceExclude = workspaceExcludeRaw

  const hiddenRoot = normalize(getYoloUserDataRootDir(settings))
  const exclude = Array.from(new Set([...workspaceExclude, hiddenRoot]))

  const pathFiles = (pathScope?.files ?? []).map(normalize)
  const pathFolders = (pathScope?.folders ?? []).map(normalize)
  const hasPathScope = pathFiles.length > 0 || pathFolders.length > 0
  const hasWorkspaceInclude = workspaceInclude.length > 0

  // Whether a raw exempt path (as given by the caller) falls inside the
  // caller-supplied `pathScope` — an exact `files` hit, or nested under a
  // `folders` subtree. Only meaningful when `hasPathScope`; callers check
  // that themselves before using this.
  const isExemptWithinPathScope = (rawExemptPath: string): boolean => {
    const normalizedExempt = normalize(rawExemptPath)
    if (pathFiles.includes(normalizedExempt)) return true
    return pathFolders.some((folder) =>
      normalizedExempt.startsWith(`${folder}/`),
    )
  }

  let files: string[]
  let folders: string[]

  if (!hasPathScope && !hasWorkspaceInclude) {
    files = []
    folders = []
  } else if (!hasWorkspaceInclude) {
    files = [...pathFiles]
    folders = [...pathFolders]
  } else if (!hasPathScope) {
    files = [...workspaceInclude]
    folders = [...workspaceInclude]
  } else {
    const setA: ScopeRule[] = [
      ...pathFiles.map((value) => ({ value, matchKind: 'exact' as const })),
      ...pathFolders.map((value) => ({
        value,
        matchKind: 'subtree' as const,
      })),
    ]
    const setB: ScopeRule[] = workspaceInclude.flatMap((value) => [
      { value, matchKind: 'exact' as const },
      { value, matchKind: 'subtree' as const },
    ])

    const resultFiles = new Set<string>()
    const resultFolders = new Set<string>()
    for (const a of setA) {
      for (const b of setB) {
        const result = intersectRule(a, b)
        if (!result) continue
        if (result.matchKind === 'exact') resultFiles.add(result.value)
        else resultFolders.add(result.value)
      }
    }
    files = [...resultFiles]
    folders = [...resultFolders]

    if (files.length === 0 && folders.length === 0) {
      // An empty pathScope ∩ workspace.include intersection is only
      // rescued by an exempt path that itself falls inside `pathScope` —
      // see the class doc's `exemptPaths` bullet.
      const hasQualifyingExempt =
        !!exemptPaths &&
        Array.from(exemptPaths).some((path) => isExemptWithinPathScope(path))
      if (!hasQualifyingExempt) {
        return { empty: true }
      }
    }
  }

  if (hasWorkspaceInclude && exemptPaths && exemptPaths.size > 0) {
    const fileSet = new Set(files)
    for (const path of exemptPaths) {
      // An explicit pathScope caps which exempt paths may bypass
      // workspace.include: only ones already inside pathScope qualify.
      if (hasPathScope && !isExemptWithinPathScope(path)) continue
      fileSet.add(path)
    }
    files = [...fileSet]
  }

  return { scope: { files, folders, exclude } }
}
