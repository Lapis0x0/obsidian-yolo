import { App, EventRef, TAbstractFile, TFile, normalizePath } from 'obsidian'

import {
  YOLO_SKILLS_INDEX_FILE_NAME,
  getYoloSkillsDir,
  getYoloSnippetsPath,
} from '../paths/yoloPaths'

import {
  getBuiltinLiteSkillByName,
  listBuiltinLiteSkills,
} from './builtinSkills'
import { parseFrontmatter } from './skillValidation'

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

/**
 * Scope for skill resolution beyond the always-included user/global bucket
 * (builtins + vault skill directories, unchanged by this type's existence —
 * every call site that omits `scope` behaves exactly as before). When
 * `moduleChatModeId` (the full running mode id, `module:<moduleId>:<id>`) is
 * set, the mode's own declared skills join the candidate set: user/global
 * skills are selected first, then the mode's skills fill in any names the
 * user/global bucket didn't already claim (§4.8 — scope is chosen before the
 * same-name pass, never a global by-name flatten across modes).
 */
export type LiteSkillScope = Readonly<{
  moduleChatModeId?: string
}>

/** One module chat mode's current skill declaration, as read from the
 * module chat mode registry. */
export type ModuleChatModeSkillModeSourceV1 = Readonly<{
  moduleId: string
  /** Artifact-relative `SKILL.md` paths — see `YoloModuleChatModeV1.skills`. */
  skillPaths: readonly string[]
}>

/**
 * Host-wide bridge from the module chat mode registry into the skills
 * subsystem. Configured once (see `configureModuleChatModeSkillSource`) by
 * host wiring code that owns both the mode registry and the trusted skill
 * path resolver; every lookup reads the registry fresh (no separate cache to
 * invalidate), so a module being disabled/upgraded/reactivated is reflected
 * on the very next skill list/get call.
 */
export type ModuleChatModeSkillSourceV1 = Readonly<{
  /** The current declaration for a registered, available mode — `undefined`
   * when the mode is unknown or unavailable (module disabled, uninstalled,
   * name-collision fallback, etc). */
  getMode(fullModeId: string): ModuleChatModeSkillModeSourceV1 | undefined
  /** Every full mode id currently registered — used only by the by-path
   * exemption lookup (`getLiteSkillDocumentByPath` without an explicit
   * scope) to search across modes, since a path alone already identifies
   * its file unambiguously. */
  listModeIds(): readonly string[]
  /** Vault path the module's declared skill package was projected to (see
   * `moduleSkillMaterializer.ts`). `null` when the declaration is not a valid
   * package path. Pure path derivation from host-owned settings — the file
   * itself only exists while the module is active and materialized. */
  resolveSkillPath(moduleId: string, declaredSkillPath: string): string | null
}>

let moduleChatModeSkillSource: ModuleChatModeSkillSourceV1 | null = null

/** Host wiring calls this once (and with `null` on teardown) to connect the
 * module chat mode registry to skill resolution. Tests that never call it
 * get the exact prior behavior: every `scope` is a no-op. */
export function configureModuleChatModeSkillSource(
  source: ModuleChatModeSkillSourceV1 | null,
): void {
  moduleChatModeSkillSource = source
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
  // Directory packages take precedence over single-file skills with
  // the same frontmatter name. This preserves package resources when both
  // formats are present without moving or renaming either user file.
  return [
    ...paths.sort((a, b) => a.localeCompare(b)),
    ...listing.files
      .map((path) => normalizePath(path))
      .filter((path) => {
        const fileName = path.slice(path.lastIndexOf('/') + 1)
        return (
          fileName !== YOLO_SKILLS_INDEX_FILE_NAME &&
          (fileName.endsWith('.md') || fileName.endsWith('.markdown'))
        )
      })
      .sort((a, b) => a.localeCompare(b)),
  ]
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

/**
 * Builds the read-only skill records a module chat mode currently
 * contributes. A module's packages are projected into the vault on
 * activation (`moduleSkillMaterializer.ts`), so each record is an ordinary
 * vault skill file here — same frontmatter parsing, same `TFile` lookup, and
 * therefore the same reachability from `fs_read`/`bash` as a user-authored
 * package. Only `isReadOnly` differs: the projection is derived from the
 * verified artifact and is rewritten on the next activation.
 *
 * A declaration that does not resolve (module inactive, projection missing)
 * or fails to parse is skipped and logged — one bad declaration must not
 * blank out the mode's other skills.
 */
const buildModuleSkillRecords = async (
  app: App,
  fullModeId: string,
): Promise<SkillRegistryRecord[]> => {
  const source = moduleChatModeSkillSource
  if (!source) {
    return []
  }
  const mode = source.getMode(fullModeId)
  if (!mode) {
    return []
  }
  const records: SkillRegistryRecord[] = []
  for (const declaredSkillPath of mode.skillPaths) {
    try {
      const path = source.resolveSkillPath(mode.moduleId, declaredSkillPath)
      if (!path) {
        continue
      }
      const file = app.vault.getFileByPath(path)
      const frontmatter = await resolveSkillFrontmatter(app, path, file)
      const entry = toLiteSkillEntry({ path, frontmatter, isReadOnly: true })
      if (!entry) {
        continue
      }
      records.push({ entry, file })
    } catch (error) {
      console.warn(
        `[YOLO] Failed to load module chat mode skill "${declaredSkillPath}" for "${fullModeId}"`,
        error,
      )
    }
  }
  return records
}

/**
 * Merges module-mode skill records into a user/global candidate set. The
 * user/global bucket is selected first and always wins ties — a module skill
 * only fills in names the vault/builtin bucket left unclaimed (§4.8: scope
 * is chosen before the same-name pass; the user can always override a
 * same-named module skill).
 */
const mergeModuleSkillRecords = (
  base: readonly SkillRegistryRecord[],
  moduleRecords: readonly SkillRegistryRecord[],
): SkillRegistryRecord[] => {
  if (moduleRecords.length === 0) {
    return [...base]
  }
  const claimed = new Set(base.map((record) => record.entry.name))
  const additions = moduleRecords.filter(
    (record) => !claimed.has(record.entry.name),
  )
  return [...base, ...additions]
}

class LiteSkillRegistryService {
  private static readonly EVENT_REBUILD_DEBOUNCE_MS = 75

  private registry: Map<string, SkillRegistryRecord> | null = null
  private inflight: Promise<Map<string, SkillRegistryRecord>> | null = null
  private settings: SkillSettings | undefined
  private settingsFingerprint = ''
  private revision = 0
  private eventRefs: EventRef[] = []
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly app: App) {}

  private fingerprint(settings?: SkillSettings): string {
    return getSkillScanDirs({
      settings,
      configDir: this.app.vault.configDir,
    }).join('\n')
  }

  private applySettings(settings?: SkillSettings): void {
    const fingerprint = this.fingerprint(settings)
    this.settings = settings
    if (fingerprint === this.settingsFingerprint) return
    this.settingsFingerprint = fingerprint
    this.invalidate()
  }

  private isRelevantPath(path: string): boolean {
    const normalized = normalizePath(path)
    return getSkillScanDirs({
      settings: this.settings,
      configDir: this.app.vault.configDir,
    }).some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))
  }

  private invalidate(): void {
    this.revision += 1
    this.registry = null
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      this.prewarm()
    }, LiteSkillRegistryService.EVENT_REBUILD_DEBOUNCE_MS)
  }

  public start(settings?: SkillSettings): void {
    this.applySettings(settings)
    if (this.eventRefs.length > 0) return
    const invalidateFile = (file: TAbstractFile) => {
      if (this.isRelevantPath(file.path)) {
        this.invalidate()
        this.scheduleRebuild()
      }
    }
    this.eventRefs = [
      this.app.vault.on('create', invalidateFile),
      this.app.vault.on('modify', invalidateFile),
      this.app.vault.on('delete', invalidateFile),
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.isRelevantPath(file.path) || this.isRelevantPath(oldPath)) {
          this.invalidate()
          this.scheduleRebuild()
        }
      }),
    ]
  }

  public updateSettings(settings?: SkillSettings): void {
    const changed = this.fingerprint(settings) !== this.settingsFingerprint
    this.applySettings(settings)
    if (changed) this.prewarm()
  }

  public prewarm(): void {
    void this.getRegistry(this.settings).catch((error) => {
      console.warn('[YOLO] Failed to prewarm Lite Skill registry', error)
    })
  }

  public async getRegistry(
    settings?: SkillSettings,
  ): Promise<Map<string, SkillRegistryRecord>> {
    this.applySettings(settings)
    while (true) {
      if (this.registry) return this.registry
      if (!this.inflight) {
        const buildRevision = this.revision
        const buildSettings = this.settings
        this.inflight = buildSkillRegistry({
          app: this.app,
          settings: buildSettings,
        }).then((registry) => {
          if (buildRevision === this.revision) this.registry = registry
          return registry
        })
      }

      const pending = this.inflight
      try {
        const registry = await pending
        if (this.registry === registry) return registry
      } finally {
        if (this.inflight === pending) this.inflight = null
      }
      // A vault/settings event invalidated the catalog while it was building.
      // Loop once more; all concurrent callers converge on the same new build.
    }
  }

  public dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
    this.rebuildTimer = null
    for (const ref of this.eventRefs) this.app.vault.offref(ref)
    this.eventRefs = []
    this.registry = null
    this.inflight = null
  }
}

const registryServices = new WeakMap<App, LiteSkillRegistryService>()

const getRegistryService = (app: App): LiteSkillRegistryService => {
  const existing = registryServices.get(app)
  if (existing) return existing
  const service = new LiteSkillRegistryService(app)
  registryServices.set(app, service)
  return service
}

export const initializeLiteSkillRegistryService = ({
  app,
  settings,
}: {
  app: App
  settings?: SkillSettings
}): (() => void) => {
  const service = getRegistryService(app)
  service.start(settings)
  return () => {
    service.dispose()
    registryServices.delete(app)
  }
}

export const updateLiteSkillRegistrySettings = (
  app: App,
  settings?: SkillSettings,
): void => {
  getRegistryService(app).updateSettings(settings)
}

export const prewarmLiteSkillRegistry = (
  app: App,
  settings?: SkillSettings,
): void => {
  const service = getRegistryService(app)
  service.updateSettings(settings)
  service.prewarm()
}

export async function listLiteSkillEntries(
  app: App,
  options?: {
    settings?: SkillSettings
    scope?: LiteSkillScope
  },
): Promise<LiteSkillEntry[]> {
  const base = [
    ...(await getRegistryService(app).getRegistry(options?.settings)).values(),
  ]
  const combined = options?.scope?.moduleChatModeId
    ? mergeModuleSkillRecords(
        base,
        await buildModuleSkillRecords(app, options.scope.moduleChatModeId),
      )
    : base
  return combined
    .map((record) => record.entry)
    .sort((a, b) => a.path.localeCompare(b.path))
}

export async function getLiteSkillDocument({
  app,
  name,
  settings,
  scope,
}: {
  app: App
  name?: string
  settings?: SkillSettings
  scope?: LiteSkillScope
}): Promise<LiteSkillDocument | null> {
  const target = name?.trim()
  if (!target) {
    return null
  }

  // Resolve through the SAME registry as `list`, so a name displayed in the UI
  // opens exactly the file/builtin that was displayed. Module-mode skills are
  // only consulted when the user/global bucket doesn't already claim `name`
  // — same tie-break as `mergeModuleSkillRecords`.
  const registry = await getRegistryService(app).getRegistry(settings)
  let record = registry.get(target)
  if (!record && scope?.moduleChatModeId) {
    const moduleRecords = await buildModuleSkillRecords(
      app,
      scope.moduleChatModeId,
    )
    record = moduleRecords.find((candidate) => candidate.entry.name === target)
  }
  if (!record) {
    return null
  }

  if (!record.entry.path.startsWith('builtin://')) {
    const currentFile = app.vault.getFileByPath(record.entry.path)
    const content = await readSkillFileContent(
      app,
      record.entry.path,
      currentFile,
    )
    const metadataFrontmatter = currentFile
      ? app.metadataCache.getFileCache(currentFile)?.frontmatter
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

/**
 * Looks up a skill by its exact file path, used by the `fs_read` exemption
 * path (a caller-supplied path already vetted as a member of this run's
 * `allowedSkillPaths`). `scope` is optional here — unlike name-based lookup,
 * a path already identifies exactly one file, so when the caller doesn't
 * know (or need) the owning mode, every currently registered module mode's
 * skills are searched; `allowedSkillPaths` is what actually gated whether
 * this path should be readable for the run, not this function.
 */
export async function getLiteSkillDocumentByPath({
  app,
  path,
  settings,
  scope,
}: {
  app: App
  path: string
  settings?: SkillSettings
  scope?: LiteSkillScope
}): Promise<LiteSkillDocument | null> {
  const targetPath = path.trim()
  if (!targetPath) {
    return null
  }

  const registry = await getRegistryService(app).getRegistry(settings)
  for (const record of registry.values()) {
    if (record.entry.path === targetPath) {
      return getLiteSkillDocument({
        app,
        name: record.entry.name,
        settings,
      })
    }
  }

  const source = moduleChatModeSkillSource
  if (source) {
    const modeIds = scope?.moduleChatModeId
      ? [scope.moduleChatModeId]
      : source.listModeIds()
    for (const modeId of modeIds) {
      const moduleRecords = await buildModuleSkillRecords(app, modeId)
      const match = moduleRecords.find(
        (candidate) => candidate.entry.path === targetPath,
      )
      if (match) {
        return getLiteSkillDocument({
          app,
          name: match.entry.name,
          settings,
          scope: { moduleChatModeId: modeId },
        })
      }
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
 * `id + name` frontmatter to the converged `name`-only form. Scans standard
 * directory packages plus root-level Markdown sources and, when a file
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
