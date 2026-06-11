import { App, TFile, TFolder } from 'obsidian'

import { AssistantWorkspaceScope } from '../types/assistant.types'

const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

// Total cap for the concatenated project-instructions section. Guards against a
// single oversized note from blowing up the system prompt. 32 KiB matches the
// order-of-magnitude budget we expect for hand-written project guides.
const MAX_TOTAL_BYTES = 32 * 1024
const TRUNCATION_NOTE =
  '\n\n[Project instructions truncated: 32 KiB cap reached. Trim AGENTS.md / CLAUDE.md to recover the rest.]'

const PROLOGUE =
  "The user maintains project instructions in the vault. Treat them as project conventions to follow alongside the system prompt; they do not override system safety policies or the user's current explicit request."

const utf8 = new TextEncoder()
const byteLength = (s: string): number => utf8.encode(s).length

/**
 * Trim path-like input the same way for both `isPathAllowedByScope` lookups and
 * vault lookups: first strip whitespace, then strip leading/trailing slashes.
 * Doing it in this order means an entry like `'  /projects/web/  '` collapses
 * to `'projects/web'` consistently.
 */
function normalizePathInput(raw: string): string {
  return raw.trim().replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Truncate a string so its UTF-8 byte length does not exceed `budget`. Returns
 * the longest prefix of `text` (by code point) that still fits. Uses a binary
 * search over the code-point sequence so multi-byte chars (中文、emoji) are
 * never split mid-character.
 */
function truncateUtf8ToBytes(text: string, budget: number): string {
  if (budget <= 0) return ''
  if (byteLength(text) <= budget) return text
  const codePoints = Array.from(text)
  let lo = 0
  let hi = codePoints.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    const candidate = codePoints.slice(0, mid).join('')
    if (byteLength(candidate) <= budget) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return codePoints.slice(0, lo).join('')
}

/**
 * Whether a vault-relative path is shadowed by any exclude rule in the scope.
 * We deliberately do not reuse `isPathAllowedByScope`: that helper also
 * requires the path to match an include entry, but here we already trust the
 * caller — the path *is* an include entry — and only want to know whether an
 * exclude rule overlaps it. Rules are normalized the same way as `path` so a
 * sloppy entry like `'  /secrets/  '` still matches `'secrets'`.
 */
function isShadowedByExclude(
  path: string,
  scope: AssistantWorkspaceScope,
): boolean {
  for (const raw of scope.exclude) {
    const rule = normalizePathInput(raw)
    // Mirror `workspaceScope.matchesRule`: an empty rule denotes the vault
    // root and therefore matches every path. A user setting exclude=['/'] is
    // effectively "block everything"; no project instructions should load.
    if (rule === '') return true
    if (path === rule || path.startsWith(`${rule}/`)) return true
  }
  return false
}

/**
 * Resolve a vault-relative path to the directory we should treat as a
 * workspace root: a TFolder uses itself; a TFile uses its parent; anything
 * else (missing path, no parent) returns null.
 */
function resolveRootFolder(app: App, path: string): TFolder | null {
  const trimmed = normalizePathInput(path)
  if (trimmed === '') return app.vault.getRoot()
  const node = app.vault.getAbstractFileByPath(trimmed)
  if (node instanceof TFolder) return node
  if (node instanceof TFile) return node.parent ?? app.vault.getRoot()
  return null
}

/**
 * Build the chain of directory paths from the vault root down to `folder`,
 * inclusive. Vault root is represented as '' to match TFolder.path semantics.
 *
 * Example: folder 'a/b/c' -> ['', 'a', 'a/b', 'a/b/c'].
 */
function buildFolderChain(folder: TFolder): TFolder[] {
  const chain: TFolder[] = []
  let cur: TFolder | null = folder
  while (cur) {
    chain.push(cur)
    cur = cur.parent
  }
  return chain.reverse()
}

/**
 * Derive the ordered list of folder chains to scan. The first chain is always
 * just the vault root (so root-level AGENTS.md / CLAUDE.md remain the global
 * baseline). When the workspace scope is active with include entries, each
 * include contributes a chain from vault root down to its resolved workspace
 * root, in configuration order. Includes that are excluded by the scope's
 * exclude list (or that don't exist) are skipped.
 */
function deriveFolderChains(
  app: App,
  scope: AssistantWorkspaceScope | undefined,
): TFolder[][] {
  const chains: TFolder[][] = [[app.vault.getRoot()]]

  if (!scope?.enabled || scope.include.length === 0) return chains

  for (const entry of scope.include) {
    const trimmed = normalizePathInput(entry)
    if (trimmed === '') continue
    // Skip include entries whose effective root is shadowed by an exclude rule:
    // loading instructions from a path the agent cannot touch is incoherent.
    if (isShadowedByExclude(trimmed, scope)) continue
    const folder = resolveRootFolder(app, trimmed)
    if (!folder) continue
    chains.push(buildFolderChain(folder))
  }
  return chains
}

/**
 * Read and trim a single instruction file. Returns null when the file is
 * missing, unreadable, or empty after trimming.
 */
async function readInstructionFile(
  app: App,
  filePath: string,
): Promise<string | null> {
  try {
    const file = app.vault.getAbstractFileByPath(filePath)
    if (!(file instanceof TFile)) return null
    const content = (await app.vault.cachedRead(file)).trim()
    return content.length === 0 ? null : content
  } catch {
    // Vault read errors are non-fatal — skip silently.
    return null
  }
}

type CollectedSection = {
  filePath: string
  body: string
}

/**
 * Collect instruction sections following these rules:
 *  - Process each folder chain in config order (vault root chain first).
 *  - Within a chain, walk from vault root down (shallow first, deep last).
 *  - At each folder, try AGENTS.md then CLAUDE.md.
 *  - Dedupe globally by full file path so shared ancestors are not duplicated.
 */
async function collectSections(
  app: App,
  chains: TFolder[][],
): Promise<CollectedSection[]> {
  const seen = new Set<string>()
  const sections: CollectedSection[] = []

  for (const chain of chains) {
    for (const folder of chain) {
      for (const name of PROJECT_INSTRUCTION_FILES) {
        const filePath =
          folder.path === '' || folder.path === '/'
            ? name
            : `${folder.path}/${name}`
        if (seen.has(filePath)) continue
        seen.add(filePath)
        const body = await readInstructionFile(app, filePath)
        if (body === null) continue
        sections.push({ filePath, body })
      }
    }
  }
  return sections
}

function renderSections(sections: CollectedSection[]): string {
  if (sections.length === 0) return ''

  // Reserve room for the truncation note up front so that the final assembled
  // string — including the note when we hit the cap — never exceeds the cap.
  const noteBytes = byteLength(TRUNCATION_NOTE)
  const reservedBudget = MAX_TOTAL_BYTES - noteBytes

  const blocks: string[] = []
  // Each section contributes `\n\n` + block when joined into the final body;
  // the prologue itself also consumes one `\n\n` separator before the first
  // block. Seeding `total` with prologue + that separator keeps the accounting
  // exact instead of approximate.
  let total = byteLength(PROLOGUE) + 2
  let truncated = false

  for (const section of sections) {
    const block = `## Project instructions: ${section.filePath}\n\n${section.body}`
    const blockBytes = byteLength(block) + 2 // account for the joining '\n\n'
    if (total + blockBytes > reservedBudget) {
      truncated = true
      break
    }
    blocks.push(block)
    total += blockBytes
  }

  if (blocks.length === 0) {
    // The very first section already exceeds the reserved budget. Keep its
    // head — truncated by real UTF-8 bytes — so the model still gets the most
    // global guidance, then mark truncation.
    const first = sections[0]
    const header = `## Project instructions: ${first.filePath}\n\n`
    const headBudget = reservedBudget - total - byteLength(header)
    if (headBudget > 0) {
      const head = truncateUtf8ToBytes(first.body, headBudget)
      if (head.length > 0) {
        blocks.push(`${header}${head}`)
      }
    }
    truncated = true
  }

  const body = [PROLOGUE, blocks.join('\n\n')].join('\n\n')
  return truncated ? body + TRUNCATION_NOTE : body
}

/**
 * Build the project-instructions section that gets appended to the system
 * message. Always reads AGENTS.md / CLAUDE.md from the vault root; when the
 * given assistant has an active workspace scope with include entries, also
 * cascades from the vault root down to each include's workspace root, picking
 * up AGENTS.md / CLAUDE.md at every layer.
 */
export async function getProjectInstructionsSection(
  app: App,
  enabled: boolean,
  workspaceScope?: AssistantWorkspaceScope,
): Promise<string> {
  if (!enabled) return ''
  const chains = deriveFolderChains(app, workspaceScope)
  const sections = await collectSections(app, chains)
  return renderSections(sections)
}

/**
 * Candidate AGENTS.md / CLAUDE.md paths for the same folder chains used when
 * building the project-instructions section. Used to watch for external edits
 * without scanning the entire vault.
 */
export function resolveProjectInstructionFilePaths(
  app: App,
  enabled: boolean,
  workspaceScope?: AssistantWorkspaceScope,
): Set<string> {
  if (!enabled) return new Set()
  const chains = deriveFolderChains(app, workspaceScope)
  const paths = new Set<string>()
  for (const chain of chains) {
    for (const folder of chain) {
      for (const name of PROJECT_INSTRUCTION_FILES) {
        const filePath =
          folder.path === '' || folder.path === '/'
            ? name
            : `${folder.path}/${name}`
        paths.add(filePath)
      }
    }
  }
  return paths
}
