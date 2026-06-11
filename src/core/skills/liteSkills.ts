import { App, TFile, normalizePath } from 'obsidian'

import {
  YOLO_SKILLS_INDEX_FILE_NAME,
  getYoloSkillsDir,
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

type SkillSettings = {
  yolo?: {
    baseDir?: string
  }
}

/** Hidden config-dir skill roots scanned in addition to `{yolo.baseDir}/skills`. */
export const HIDDEN_VAULT_SKILL_DIR_SUFFIXES = [
  'skills',
  'yolo/skills',
  'YOLO/skills',
] as const

/**
 * Skill directories to scan, in priority order. Duplicate normalized paths are
 * included once (first occurrence wins).
 */
export const getSkillScanDirs = ({
  settings,
  configDir,
}: {
  settings?: SkillSettings | null
  configDir: string
}): string[] => {
  const dirs: string[] = []
  const seen = new Set<string>()
  const add = (dir: string) => {
    const normalized = normalizePath(dir)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      dirs.push(normalized)
    }
  }
  add(getYoloSkillsDir(settings))
  for (const suffix of HIDDEN_VAULT_SKILL_DIR_SUFFIXES) {
    add(`${configDir}/${suffix}`)
  }
  return dirs
}

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
  path,
  frontmatter,
}: {
  path: string
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
    path,
  }
}

const isLiteSkillPath = ({
  path,
  skillsDir,
}: {
  path: string
  skillsDir: string
}): boolean => {
  const normalizedDir = normalizePath(skillsDir)
  const prefix = `${normalizedDir}/`
  if (!path.startsWith(prefix) || !path.endsWith('.md')) {
    return false
  }

  const fileName = path.slice(path.lastIndexOf('/') + 1)
  if (fileName === YOLO_SKILLS_INDEX_FILE_NAME) {
    return false
  }

  const relativePath = path.slice(prefix.length)
  if (!relativePath.includes('/')) {
    return true
  }

  return fileName === CLAUDE_SKILL_FILE_NAME
}

const listSkillPathsInDir = async (
  adapter: App['vault']['adapter'],
  skillsDir: string,
): Promise<string[]> => {
  const normalizedDir = normalizePath(skillsDir)
  if (!(await adapter.exists(normalizedDir))) {
    return []
  }

  const paths: string[] = []
  const collect = async (currentDir: string): Promise<void> => {
    const listing = await adapter.list(currentDir)
    for (const filePath of listing.files) {
      const normalizedPath = normalizePath(filePath)
      if (isLiteSkillPath({ path: normalizedPath, skillsDir: normalizedDir })) {
        paths.push(normalizedPath)
      }
    }
    for (const folderPath of listing.folders) {
      await collect(normalizePath(folderPath))
    }
  }

  await collect(normalizedDir)
  return paths.sort((a, b) => a.localeCompare(b))
}

const readSkillFileContent = async (
  app: App,
  path: string,
  file: TFile | null,
): Promise<string> => {
  if (file) {
    return app.vault.cachedRead(file)
  }
  return app.vault.adapter.read(path)
}

const resolveSkillFrontmatter = async (
  app: App,
  path: string,
  file: TFile | null,
): Promise<Record<string, unknown> | null> => {
  const metadataFrontmatter = file
    ? app.metadataCache.getFileCache(file)?.frontmatter
    : undefined
  if (asTrimmedString(metadataFrontmatter?.name)) {
    return metadataFrontmatter ?? null
  }

  const content = await readSkillFileContent(app, path, file)
  const parsedFrontmatter = parseFrontmatterFromContent(content)
  return {
    ...(metadataFrontmatter ?? {}),
    ...(parsedFrontmatter ?? {}),
  }
}

const writeSkillFileContent = async (
  app: App,
  path: string,
  file: TFile | null,
  content: string,
): Promise<void> => {
  if (file) {
    await app.vault.modify(file, content)
    return
  }
  await app.vault.adapter.write(path, content)
}

type SkillRegistryRecord = {
  entry: LiteSkillEntry
  /** Backing vault file, or `null` for a builtin skill. */
  file: TFile | null
}

/**
 * Build the single name -> skill registry that BOTH `list` and `get` consume,
 * so the skill shown in the UI is always the exact same one lazy-loaded via
 * `fs_read` on the listed path. Resolution order:
 *   1. builtins seeded first (file = null);
 *   2. vault skill dirs in `getSkillScanDirs` order; within each dir, paths are
 *      sorted and the first file claiming a given `name` wins and overrides
 *      builtins; later dirs or paths with the same `name` are ignored.
 * `name` is the canonical key: trim-only, case-sensitive (different casing =>
 * different skill).
 */
const buildSkillRegistry = async ({
  app,
  settings,
}: {
  app: App
  settings?: SkillSettings
}): Promise<Map<string, SkillRegistryRecord>> => {
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

  const vaultClaimed = new Set<string>()
  for (const skillsDir of getSkillScanDirs({
    settings,
    configDir: app.vault.configDir,
  })) {
    const paths = await listSkillPathsInDir(app.vault.adapter, skillsDir)
    for (const path of paths) {
      const file = app.vault.getFileByPath(path)
      const frontmatter = await resolveSkillFrontmatter(app, path, file)
      const entry = toLiteSkillEntry({ path, frontmatter })
      if (!entry) {
        continue
      }
      if (vaultClaimed.has(entry.name)) {
        continue
      }
      registry.set(entry.name, { entry, file })
      vaultClaimed.add(entry.name)
    }
  }

  return registry
}

export async function listLiteSkillEntries(
  app: App,
  options?: {
    settings?: SkillSettings
  },
): Promise<LiteSkillEntry[]> {
  return [
    ...(
      await buildSkillRegistry({ app, settings: options?.settings })
    ).values(),
  ]
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
  const record = (await buildSkillRegistry({ app, settings })).get(target)
  if (!record) {
    return null
  }

  if (!record.entry.path.startsWith('builtin://')) {
    const content = await readSkillFileContent(
      app,
      record.entry.path,
      record.file,
    )
    const metadataFrontmatter = record.file
      ? app.metadataCache.getFileCache(record.file)?.frontmatter
      : undefined
    const parsedFrontmatter = parseFrontmatterFromContent(content)
    const mergedFrontmatter = {
      ...(metadataFrontmatter ?? {}),
      ...(parsedFrontmatter ?? {}),
    }
    const entry = toLiteSkillEntry({
      path: record.entry.path,
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

export async function getLiteSkillDocumentByPath({
  app,
  path,
  settings,
}: {
  app: App
  path: string
  settings?: SkillSettings
}): Promise<LiteSkillDocument | null> {
  const targetPath = path.trim()
  if (!targetPath) {
    return null
  }

  const registry = await buildSkillRegistry({ app, settings })
  for (const record of registry.values()) {
    if (record.entry.path === targetPath) {
      return getLiteSkillDocument({
        app,
        name: record.entry.name,
        settings,
      })
    }
  }
  return null
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
 * file under any configured skill scan directory and, when a file carries a valid `id`,
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
  for (const skillsDir of getSkillScanDirs({
    settings,
    configDir: app.vault.configDir,
  })) {
    const paths = await listSkillPathsInDir(app.vault.adapter, skillsDir)
    for (const path of paths) {
      try {
        const file = app.vault.getFileByPath(path)
        const metadataFrontmatter = file
          ? app.metadataCache.getFileCache(file)?.frontmatter
          : undefined
        const hasMetadataFrontmatter = metadataFrontmatter !== undefined
        let parsedId = metadataFrontmatter?.id
        let content: string | null = null

        if (
          !hasMetadataFrontmatter &&
          (typeof parsedId !== 'string' || parsedId.trim().length === 0)
        ) {
          content = await readSkillFileContent(app, path, file)
          const parsedFrontmatter = parseFrontmatterFromContent(content)
          parsedId = parsedFrontmatter?.id
        }

        if (typeof parsedId !== 'string' || parsedId.trim().length === 0) {
          continue
        }

        if (content === null) {
          content = await readSkillFileContent(app, path, file)
        }
        const rewritten = rewriteSkillFrontmatterIdToName(content, parsedId)
        if (rewritten === null) {
          continue
        }
        await writeSkillFileContent(app, path, file, rewritten)
      } catch (error) {
        console.warn(
          `[YOLO] Failed to migrate skill frontmatter for ${path}; skipping.`,
          error,
        )
      }
    }
  }
}
