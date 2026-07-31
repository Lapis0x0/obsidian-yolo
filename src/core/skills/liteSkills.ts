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
import { parseFrontmatter, validateSkillName } from './skillValidation'

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
  /** Builtin and externally owned project skills must never be mutated by YOLO. */
  isReadOnly: boolean
}

export type LiteSkillDocument = {
  entry: LiteSkillEntry
  content: string
}

export type LiteSkillPackageResource =
  | {
      kind: 'vault'
      relativePath: string
      path: string
    }
  | {
      kind: 'builtin'
      relativePath: typeof SKILL_PACKAGE_ENTRY_FILE_NAME
      content: string
    }

export type LiteSkillPackageSource = {
  entry: LiteSkillEntry
  resources: LiteSkillPackageResource[]
}

export const SKILL_PACKAGE_ENTRY_FILE_NAME = 'SKILL.md'

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

/** Project-local Agent Skills owned by other compatible harnesses. */
export const EXTERNAL_PROJECT_SKILL_DIRS = [
  '.claude/skills',
  '.agents/skills',
  '.codex/skills',
] as const

/** Skill roots owned by YOLO and therefore eligible for migrations. */
export const getManagedSkillScanDirs = ({
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
  return [
    ...new Set([
      ...getManagedSkillScanDirs({ settings, configDir }),
      ...EXTERNAL_PROJECT_SKILL_DIRS.map((dir) => normalizePath(dir)),
    ]),
  ]
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

const parseFrontmatterFromContent = (
  content: string,
): Record<string, unknown> | null => parseFrontmatter(content)

const toLiteSkillEntry = ({
  path,
  frontmatter,
  isReadOnly,
}: {
  path: string
  frontmatter?: Record<string, unknown> | null
  isReadOnly: boolean
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
    isReadOnly,
  }
}

const listSkillPathsInDir = async (
  adapter: App['vault']['adapter'],
  skillsDir: string,
): Promise<string[]> => {
  const normalizedDir = normalizePath(skillsDir)
  if (!(await adapter.exists(normalizedDir))) {
    return []
  }

  const listing = await adapter.list(normalizedDir)
  const paths: string[] = []
  for (const rawFolderPath of listing.folders) {
    const folderPath = normalizePath(rawFolderPath)
    const relativePath = folderPath.slice(normalizedDir.length + 1)
    if (!relativePath || relativePath.includes('/')) {
      continue
    }
    const skillPath = normalizePath(
      `${folderPath}/${SKILL_PACKAGE_ENTRY_FILE_NAME}`,
    )
    if (await adapter.exists(skillPath)) {
      paths.push(skillPath)
    }
  }
  return paths.sort((a, b) => a.localeCompare(b))
}

const listLegacyRootSkillPaths = async (
  adapter: App['vault']['adapter'],
  skillsDir: string,
): Promise<string[]> => {
  const normalizedDir = normalizePath(skillsDir)
  if (!(await adapter.exists(normalizedDir))) {
    return []
  }

  const listing = await adapter.list(normalizedDir)
  return listing.files
    .map((path) => normalizePath(path))
    .filter((path) => {
      const fileName = path.slice(path.lastIndexOf('/') + 1)
      return (
        fileName !== YOLO_SKILLS_INDEX_FILE_NAME && fileName.endsWith('.md')
      )
    })
    .sort((a, b) => a.localeCompare(b))
}

const getSkillPackageDirName = (skillPath: string): string | null => {
  const suffix = `/${SKILL_PACKAGE_ENTRY_FILE_NAME}`
  if (!skillPath.endsWith(suffix)) {
    return null
  }
  const packageDir = skillPath.slice(0, -suffix.length)
  const slashIndex = packageDir.lastIndexOf('/')
  return packageDir.slice(slashIndex + 1) || null
}

export const getSkillPackageDirPath = (skillPath: string): string | null => {
  const normalizedPath = normalizePath(skillPath)
  const suffix = `/${SKILL_PACKAGE_ENTRY_FILE_NAME}`
  return normalizedPath.endsWith(suffix)
    ? normalizedPath.slice(0, -suffix.length)
    : null
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
        isReadOnly: true,
      },
      file: null,
    })
  })

  const vaultClaimed = new Set<string>()
  const managedSkillDirs = new Set(
    getManagedSkillScanDirs({
      settings,
      configDir: app.vault.configDir,
    }),
  )
  for (const skillsDir of getSkillScanDirs({
    settings,
    configDir: app.vault.configDir,
  })) {
    const paths = await listSkillPathsInDir(app.vault.adapter, skillsDir)
    for (const path of paths) {
      const file = app.vault.getFileByPath(path)
      const frontmatter = await resolveSkillFrontmatter(app, path, file)
      const entry = toLiteSkillEntry({
        path,
        frontmatter,
        isReadOnly: !managedSkillDirs.has(skillsDir),
      })
      if (
        !entry ||
        validateSkillName(entry.name).length > 0 ||
        getSkillPackageDirName(path) !== entry.name
      ) {
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
      isReadOnly: record.entry.isReadOnly,
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
      isReadOnly: true,
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

const listPackageResourcePaths = async (
  adapter: App['vault']['adapter'],
  packageDir: string,
): Promise<string[]> => {
  const paths: string[] = []
  const collect = async (dir: string): Promise<void> => {
    const listing = await adapter.list(dir)
    paths.push(...listing.files.map((path) => normalizePath(path)))
    for (const folder of listing.folders) {
      await collect(normalizePath(folder))
    }
  }
  await collect(packageDir)
  return paths.sort((a, b) => a.localeCompare(b))
}

/**
 * Resolve the complete package behind a canonical frontmatter name. Vault
 * resources are returned as paths so downstream materializers can preserve
 * text and binary files with the adapter operation appropriate to each file.
 */
export async function getLiteSkillPackageSource({
  app,
  name,
  settings,
}: {
  app: App
  name?: string
  settings?: SkillSettings
}): Promise<LiteSkillPackageSource | null> {
  const document = await getLiteSkillDocument({ app, name, settings })
  if (!document) {
    return null
  }

  if (document.entry.path.startsWith('builtin://')) {
    return {
      entry: document.entry,
      resources: [
        {
          kind: 'builtin',
          relativePath: SKILL_PACKAGE_ENTRY_FILE_NAME,
          content: document.content,
        },
      ],
    }
  }

  const packageDir = getSkillPackageDirPath(document.entry.path)
  if (!packageDir) {
    return null
  }
  const prefix = `${packageDir}/`
  const resources = (
    await listPackageResourcePaths(app.vault.adapter, packageDir)
  ).map(
    (path): LiteSkillPackageResource => ({
      kind: 'vault',
      path,
      relativePath: path.slice(prefix.length),
    }),
  )

  return { entry: document.entry, resources }
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
 * `id + name` frontmatter to the converged `name`-only form. Scans standard
 * directory packages plus root-level legacy Markdown sources and, when a file
 * carries a valid `id`, promotes `id` -> `name` and removes the `id` line.
 * Files without a valid `id` are skipped. Per-file failures are logged and
 * skipped without aborting the batch.
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
  for (const skillsDir of getManagedSkillScanDirs({
    settings,
    configDir: app.vault.configDir,
  })) {
    const paths = [
      ...new Set([
        ...(await listLegacyRootSkillPaths(app.vault.adapter, skillsDir)),
        ...(await listSkillPathsInDir(app.vault.adapter, skillsDir)),
      ]),
    ].sort((a, b) => a.localeCompare(b))
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

export type LegacySkillPackageMigrationIssueReason =
  | 'invalid_frontmatter'
  | 'invalid_name'
  | 'target_exists'
  | 'migration_failed'

export type LegacySkillPackageMigrationIssue = {
  sourcePath: string
  targetPath?: string
  reason: LegacySkillPackageMigrationIssueReason
  error?: string
}

export type LegacySkillPackageMigrationReport = {
  migrated: Array<{
    name: string
    sourcePath: string
    targetPath: string
  }>
  issues: LegacySkillPackageMigrationIssue[]
}

const removeEmptyDirIfPresent = async (
  adapter: App['vault']['adapter'],
  path: string,
): Promise<void> => {
  if (!(await adapter.exists(path))) {
    return
  }
  const listing = await adapter.list(path)
  if (listing.files.length === 0 && listing.folders.length === 0) {
    await adapter.rmdir(path, false)
  }
}

/**
 * Move root-level legacy Markdown skills into standard directory packages.
 *
 * The migration is intentionally conservative and idempotent: identity comes
 * only from a standards-valid frontmatter `name`; an existing target path is
 * always treated as a conflict; and failed/invalid sources are never removed.
 */
export async function migrateLegacySkillFilesToPackages(
  app: App,
  settings?: SkillSettings,
): Promise<LegacySkillPackageMigrationReport> {
  const report: LegacySkillPackageMigrationReport = {
    migrated: [],
    issues: [],
  }

  for (const skillsDir of getManagedSkillScanDirs({
    settings,
    configDir: app.vault.configDir,
  })) {
    const sourcePaths = await listLegacyRootSkillPaths(
      app.vault.adapter,
      skillsDir,
    )
    for (const sourcePath of sourcePaths) {
      let targetDir: string | null = null
      let createdTargetDir = false
      try {
        const content = await app.vault.adapter.read(sourcePath)
        const frontmatter = parseFrontmatterFromContent(content)
        if (!frontmatter) {
          report.issues.push({
            sourcePath,
            reason: 'invalid_frontmatter',
          })
          continue
        }

        const nameErrors = validateSkillName(frontmatter.name)
        if (nameErrors.length > 0 || typeof frontmatter.name !== 'string') {
          report.issues.push({ sourcePath, reason: 'invalid_name' })
          continue
        }

        const name = frontmatter.name.trim()
        targetDir = normalizePath(`${skillsDir}/${name}`)
        const targetPath = normalizePath(
          `${targetDir}/${SKILL_PACKAGE_ENTRY_FILE_NAME}`,
        )
        if (await app.vault.adapter.exists(targetDir)) {
          report.issues.push({
            sourcePath,
            targetPath,
            reason: 'target_exists',
          })
          continue
        }

        await app.vault.adapter.mkdir(targetDir)
        createdTargetDir = true
        if (await app.vault.adapter.exists(targetPath)) {
          await removeEmptyDirIfPresent(app.vault.adapter, targetDir)
          report.issues.push({
            sourcePath,
            targetPath,
            reason: 'target_exists',
          })
          continue
        }
        await app.vault.adapter.rename(sourcePath, targetPath)
        report.migrated.push({ name, sourcePath, targetPath })
      } catch (error) {
        if (targetDir && createdTargetDir) {
          try {
            await removeEmptyDirIfPresent(app.vault.adapter, targetDir)
          } catch (cleanupError) {
            console.warn(
              `[YOLO] Failed to clean up skill migration target ${targetDir}.`,
              cleanupError,
            )
          }
        }
        report.issues.push({
          sourcePath,
          ...(targetDir
            ? {
                targetPath: normalizePath(
                  `${targetDir}/${SKILL_PACKAGE_ENTRY_FILE_NAME}`,
                ),
              }
            : {}),
          reason: 'migration_failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  return report
}

/** Run all vault-skill upgrades in dependency order at startup. */
export async function migrateVaultSkillsToDirectoryPackages(
  app: App,
  settings?: SkillSettings,
): Promise<LegacySkillPackageMigrationReport> {
  await migrateVaultSkillFrontmatter(app, settings)
  return migrateLegacySkillFilesToPackages(app, settings)
}
