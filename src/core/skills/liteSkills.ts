import { App, TFile } from 'obsidian'

import {
  YOLO_SKILLS_INDEX_FILE_NAME,
  getYoloSkillsDir,
  getYoloSkillsDirPrefix,
  getYoloSnippetsPath,
} from '../paths/yoloPaths'

import {
  getBuiltinLiteSkillByName,
  listBuiltinLiteSkills,
} from './builtinSkills'

export type LiteSkillMode = 'lazy' | 'always'

export type LiteSkillEntry = {
  /**
   * Canonical identifier of the skill, taken verbatim from the frontmatter
   * `name` field (trim only, case-sensitive, never lowercased/slugified). This
   * doubles as the human-facing label.
   */
  name: string
  description: string
  mode: LiteSkillMode
  path: string
}

export type LiteSkillDocument = {
  entry: LiteSkillEntry
  content: string
}

const CLAUDE_SKILL_FILE_NAME = 'SKILL.md'

const normalizeSkillMode = (value: unknown): LiteSkillMode => {
  if (typeof value !== 'string') {
    return 'lazy'
  }
  return value.trim().toLowerCase() === 'always' ? 'always' : 'lazy'
}

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const stripWrappingQuotes = (value: string): string => {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const parseFrontmatterFromContent = (
  content: string,
): Record<string, string> | null => {
  if (!content.startsWith('---\n')) {
    return null
  }

  const closingIndex = content.indexOf('\n---\n', 4)
  if (closingIndex === -1) {
    return null
  }

  const frontmatterText = content.slice(4, closingIndex)
  const lines = frontmatterText.split('\n')
  const frontmatter: Record<string, string> = {}

  for (const line of lines) {
    const matched = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/)
    if (!matched) {
      continue
    }
    const key = matched[1]
    const value = stripWrappingQuotes(matched[2])
    frontmatter[key] = value
  }

  return frontmatter
}

const toLiteSkillEntry = ({
  file,
  frontmatter,
}: {
  file: TFile
  frontmatter?: Record<string, unknown> | null
}): LiteSkillEntry | null => {
  const name = asTrimmedString(frontmatter?.name)
  if (!name) {
    return null
  }

  const description =
    asTrimmedString(frontmatter?.description) ?? 'No description provided.'
  const mode = normalizeSkillMode(frontmatter?.mode)

  return {
    name,
    description,
    mode,
    path: file.path,
  }
}

const isLiteSkillFile = ({
  file,
  skillsDirPrefix,
}: {
  file: TFile
  skillsDirPrefix: string
}): boolean => {
  if (!file.path.startsWith(skillsDirPrefix) || file.extension !== 'md') {
    return false
  }

  if (file.name === YOLO_SKILLS_INDEX_FILE_NAME) {
    return false
  }

  const relativePath = file.path.slice(skillsDirPrefix.length)
  if (!relativePath.includes('/')) {
    return true
  }

  return file.name === CLAUDE_SKILL_FILE_NAME
}

type SkillSettings = {
  yolo?: {
    baseDir?: string
  }
}

type SkillRegistryRecord = {
  entry: LiteSkillEntry
  /** Backing vault file, or `null` for a builtin skill. */
  file: TFile | null
}

/**
 * Build the single name -> skill registry that BOTH `list` and `get` consume,
 * so the skill shown in the UI is always the exact same one `open_skill`
 * resolves. Resolution order:
 *   1. builtins seeded first (file = null);
 *   2. vault files, path-sorted: the FIRST vault file claiming a given `name`
 *      wins and overrides any builtin; later vault files with the same `name`
 *      are ignored.
 * `name` is the canonical key: trim-only, case-sensitive (different casing =>
 * different skill).
 */
const buildSkillRegistry = ({
  app,
  settings,
}: {
  app: App
  settings?: SkillSettings
}): Map<string, SkillRegistryRecord> => {
  const registry = new Map<string, SkillRegistryRecord>()

  listBuiltinLiteSkills({
    skillsDir: getYoloSkillsDir(settings),
    snippetsPath: getYoloSnippetsPath(settings),
  }).forEach((skill) => {
    registry.set(skill.name, {
      entry: {
        name: skill.name,
        description: skill.description,
        mode: skill.mode,
        path: skill.path,
      },
      file: null,
    })
  })

  const skillsDirPrefix = getYoloSkillsDirPrefix(settings)
  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => isLiteSkillFile({ file, skillsDirPrefix }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const vaultClaimed = new Set<string>()
  for (const file of files) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter
    const entry = toLiteSkillEntry({ file, frontmatter: frontmatter ?? null })
    if (!entry) {
      continue
    }
    // Among vault files the path-sorted first wins; it also overrides builtins.
    if (vaultClaimed.has(entry.name)) {
      continue
    }
    registry.set(entry.name, { entry, file })
    vaultClaimed.add(entry.name)
  }

  return registry
}

export function listLiteSkillEntries(
  app: App,
  options?: {
    settings?: SkillSettings
  },
): LiteSkillEntry[] {
  return [...buildSkillRegistry({ app, settings: options?.settings }).values()]
    .map((record) => record.entry)
    .sort((a, b) => a.path.localeCompare(b.path))
}

export async function getLiteSkillDocument({
  app,
  name,
  settings,
}: {
  app: App
  name?: string
  settings?: SkillSettings
}): Promise<LiteSkillDocument | null> {
  const target = name?.trim()
  if (!target) {
    return null
  }

  // Resolve through the SAME registry as `list`, so a name displayed in the UI
  // opens exactly the file/builtin that was displayed.
  const record = buildSkillRegistry({ app, settings }).get(target)
  if (!record) {
    return null
  }

  if (record.file) {
    const content = await app.vault.cachedRead(record.file)
    const metadataFrontmatter = app.metadataCache.getFileCache(
      record.file,
    )?.frontmatter
    const parsedFrontmatter = parseFrontmatterFromContent(content)
    const mergedFrontmatter = {
      ...(metadataFrontmatter ?? {}),
      ...(parsedFrontmatter ?? {}),
    }
    const entry = toLiteSkillEntry({
      file: record.file,
      frontmatter: mergedFrontmatter,
    })
    if (!entry) {
      return null
    }

    return {
      entry,
      content,
    }
  }

  // Builtin skill (file === null): re-render its content.
  const builtin = getBuiltinLiteSkillByName({
    name: target,
    skillsDir: getYoloSkillsDir(settings),
    snippetsPath: getYoloSnippetsPath(settings),
  })
  if (!builtin) {
    return null
  }

  return {
    entry: {
      name: builtin.name,
      description: builtin.description,
      mode: builtin.mode,
      path: builtin.path,
    },
    content: builtin.content,
  }
}

/**
 * Convert a canonical skill `name` (typically kebab-case, e.g.
 * `english-polisher`) into a human-friendly Title Case label
 * (`English Polisher`) for UI display only. The data model always stores the
 * raw `name`; this is pure presentation and must never feed back into
 * identity/lookup.
 */
export function humanizeSkillName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    return trimmed
  }
  return trimmed
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Serialize a string as a YAML scalar safe for a `name:` frontmatter line.
 * Plain identifiers (letter-led, only `[A-Za-z0-9_-]`, which covers kebab-case
 * skill names) are emitted bare; anything else is double-quoted and escaped, so
 * values such as `123`, `foo: bar`, or `a # b` never produce invalid YAML.
 */
const toYamlScalar = (value: string): string => {
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    return value
  }
  // Double-quoted YAML scalar: escape backslash and quote first, then encode
  // real newlines as `\n` / `\r` so the value never breaks the single `name:`
  // line or gets folded by YAML.
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  return `"${escaped}"`
}

/**
 * Promote a legacy `id` frontmatter field to `name` and drop the `id` line.
 *
 * @param content  Raw file content.
 * @param parsedId The already-parsed `id` value from the YAML frontmatter
 *   (e.g. obsidian's `metadataCache`), so the type check is authoritative: only
 *   a non-empty string is a valid id to promote. Numbers / booleans / absent
 *   `id` — which the loader never treated as an id (identity already lives in
 *   `name`) — are left untouched, returning `null`.
 *
 * Surgical and idempotent: only the `name` value changes and the `id` line is
 * removed; description / mode / body / formatting are preserved, and the
 * original newline style (LF vs CRLF) is kept. The promoted `name` is written
 * as a safe YAML scalar (quoted when not a plain identifier).
 */
export function rewriteSkillFrontmatterIdToName(
  content: string,
  parsedId: unknown,
): string | null {
  if (typeof parsedId !== 'string') {
    return null
  }
  const newName = parsedId.trim()
  if (newName.length === 0) {
    return null
  }

  const usesCRLF = content.includes('\r\n')
  const normalized = usesCRLF ? content.replace(/\r\n/g, '\n') : content
  if (!normalized.startsWith('---\n')) {
    return null
  }
  const closingIndex = normalized.indexOf('\n---\n', 4)
  if (closingIndex === -1) {
    return null
  }

  const frontmatterText = normalized.slice(4, closingIndex)
  const rest = normalized.slice(closingIndex) // starts with "\n---\n"
  const lines = frontmatterText.split('\n')

  const idLineRegex = /^id\s*:\s*(.*)$/
  const nameLineRegex = /^name\s*:\s*(.*)$/

  if (!lines.some((line) => idLineRegex.test(line))) {
    // No root-level id line to promote (already migrated, etc.).
    return null
  }

  const nameValue = toYamlScalar(newName)
  const nextLines: string[] = []
  let nameApplied = false
  for (const line of lines) {
    if (idLineRegex.test(line)) {
      // Drop the id line entirely.
      continue
    }
    if (!nameApplied && nameLineRegex.test(line)) {
      nextLines.push(`name: ${nameValue}`)
      nameApplied = true
      continue
    }
    nextLines.push(line)
  }

  if (!nameApplied) {
    // No existing name line: prepend one so the file stays valid.
    nextLines.unshift(`name: ${nameValue}`)
  }

  const nextContentLF = `---\n${nextLines.join('\n')}${rest}`
  if (nextContentLF === normalized) {
    return null
  }
  return usesCRLF ? nextContentLF.replace(/\n/g, '\r\n') : nextContentLF
}

/**
 * One-time, idempotent migration of vault skill files from the legacy
 * `id + name` frontmatter to the converged `name`-only form. Scans every skill
 * file under `<baseDir>/skills/` and, when a file carries a valid `id`,
 * promotes `id` -> `name` and removes the `id` line. Files without a valid `id`
 * are skipped. Per-file failures are logged and skipped without aborting the
 * batch.
 *
 * Must run before any skill list/get so callers never observe a mixed state.
 */
export async function migrateVaultSkillFrontmatter(
  app: App,
  settings?: {
    yolo?: {
      baseDir?: string
    }
  },
): Promise<void> {
  const skillsDirPrefix = getYoloSkillsDirPrefix(settings)
  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => isLiteSkillFile({ file, skillsDirPrefix }))

  for (const file of files) {
    try {
      // Authoritative type from the parsed frontmatter: only a non-empty string
      // id is promoted. Skip cheaply before reading the file otherwise.
      const parsedId = app.metadataCache.getFileCache(file)?.frontmatter?.id
      if (typeof parsedId !== 'string' || parsedId.trim().length === 0) {
        continue
      }
      const content = await app.vault.read(file)
      const rewritten = rewriteSkillFrontmatterIdToName(content, parsedId)
      if (rewritten === null) {
        continue
      }
      await app.vault.modify(file, rewritten)
    } catch (error) {
      console.warn(
        `[YOLO] Failed to migrate skill frontmatter for ${file.path}; skipping.`,
        error,
      )
    }
  }
}
