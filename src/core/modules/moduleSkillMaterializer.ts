import { type App, TFile, TFolder, normalizePath } from 'obsidian'

import { SKILL_PACKAGE_ENTRY_FILE_NAME } from '../skills/liteSkills'

import type { VerifiedModuleArtifact } from './moduleArtifactVerifier'
import { verifyModuleBytes } from './moduleIntegrity'
import {
  type ModuleArtifactFile,
  type ModuleStore,
  assertModuleId,
  canonicalArtifactPath,
  normalizeModuleArtifactFilePath,
} from './moduleStore'

/**
 * Skill packages a module ships inside its verified artifact are projected
 * into real Vault files so they obey exactly the same rules as an imported or
 * hand-written skill package: `fs_read`, `bash`, and every other agent read
 * path address them with an ordinary Vault path, and arbitrary package
 * resources (references, assets, scripts) come along unchanged. Module
 * artifacts live under the plugin directory, which Obsidian does not index,
 * so nothing inside them is reachable by those tools.
 *
 * The projection is derived state, never a source of truth:
 *   - only files the module's verified manifest declares as `role: 'data'`
 *     and that live inside the declared package directory are written, with
 *     their manifest SHA-256 re-checked on the way out (skill text becomes
 *     model instructions, so it must never be anything but verified bytes);
 *   - a file is rewritten only when its bytes differ, so re-activating an
 *     unchanged module touches nothing and does not churn Vault sync;
 *   - anything else under the module's projection root is removed, which is
 *     what makes a version upgrade, a dropped declaration, and local edits
 *     all converge on the artifact without a separate version stamp — and
 *     when there is too much of it to enumerate, the root is reset wholesale
 *     rather than left as it is.
 */

/**
 * Both limits bound the *trusted* side — the set of files the verified
 * manifest asks to project. They are deliberately not a limit on what is
 * found under the projection root: that directory is user-visible and
 * agent-writable, so sync conflict copies, a stray `bash mkdir`, or a manual
 * paste can put arbitrarily much there, and refusing to proceed would make
 * exactly the mess the reconciliation exists to clear permanent. Enumeration
 * that runs past these bounds instead reports an overflow, and the projection
 * answers by dropping the root wholesale and rebuilding it from the artifact.
 */
export const MAX_MODULE_SKILL_PROJECTION_DEPTH = 16
export const MAX_MODULE_SKILL_PROJECTION_ENTRIES = 512

export type ModuleSkillPackageFilePlan = Readonly<{
  file: ModuleArtifactFile
  vaultPath: string
}>

export type ModuleSkillPackagePlan = Readonly<{
  /** Directory name the package takes inside the module's skills root. */
  packageName: string
  /** Vault path of the package's `SKILL.md`. */
  entryVaultPath: string
  files: readonly ModuleSkillPackageFilePlan[]
}>

/** Minimal Vault surface the projection needs; `list` returns null when absent. */
export type ModuleSkillProjectionVaultV1 = Readonly<{
  list(dir: string): Promise<Readonly<{
    files: readonly string[]
    folders: readonly string[]
  }> | null>
  read(path: string): Promise<Uint8Array>
  write(path: string, bytes: Uint8Array): Promise<void>
  removeFile(path: string): Promise<void>
  removeDir(path: string): Promise<void>
}>

export type ModuleSkillMaterializerV1 = Readonly<{
  /**
   * Reconciles the module's projected skill packages with `artifact` and
   * `declaredSkillPaths`. Throws when a declaration does not match the
   * verified manifest, or when the Vault refuses the writes. The caller
   * decides what that means: `moduleActivationCoordinator` reports it as a
   * diagnostic and lets the activation stand, because a mode missing a skill
   * is a degraded module, not a module that failed to start.
   */
  materialize(
    moduleId: string,
    artifact: VerifiedModuleArtifact,
    declaredSkillPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<void>
  /** Drops the module's entire projection (uninstall). */
  remove(moduleId: string): Promise<void>
}>

export type ModuleSkillMaterializerOptions = Readonly<{
  vault: ModuleSkillProjectionVaultV1
  store: Pick<ModuleStore, 'readEntryBytes'>
  /** Current `<yolo base>/modules/<moduleId>/skills`, read fresh every call. */
  getSkillsDir(moduleId: string): string
  /** Current `<yolo base>/modules/<moduleId>`, read fresh every call. */
  getModuleDir(moduleId: string): string
  /** Current `<yolo base>/modules`, read fresh every call. */
  getModulesRootDir(): string
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
}>

/**
 * Maps one declared skill entry to the directory name its package takes in
 * the Vault. A declaration must be the artifact-relative path of the
 * package's `SKILL.md` (e.g. `skills/coach/SKILL.md`); the package name is
 * the directory that contains it. Returns null for anything else, so read and
 * write paths agree on exactly one shape.
 */
export function resolveModuleSkillPackageName(
  declaredSkillPath: string,
): string | null {
  let normalized: string
  try {
    normalized = normalizeModuleArtifactFilePath(declaredSkillPath)
  } catch {
    return null
  }
  const segments = normalized.split('/')
  if (
    segments.length < 2 ||
    segments[segments.length - 1] !== SKILL_PACKAGE_ENTRY_FILE_NAME
  ) {
    return null
  }
  return segments[segments.length - 2]
}

/**
 * The Vault path a declared module skill is projected to. This is the single
 * definition shared by the materializer and by skill resolution, so a skill
 * is always looked up at the exact path it was written to.
 */
export function resolveModuleSkillVaultPath(
  skillsDir: string,
  declaredSkillPath: string,
): string | null {
  const packageName = resolveModuleSkillPackageName(declaredSkillPath)
  if (!packageName) return null
  return normalizePath(
    `${skillsDir}/${packageName}/${SKILL_PACKAGE_ENTRY_FILE_NAME}`,
  )
}

/**
 * Resolves every declared skill against the verified manifest. A package is
 * the set of `role: 'data'` files declared inside the `SKILL.md`'s directory;
 * nothing outside that directory, and nothing the manifest does not declare,
 * can enter the projection. This is also where the projection's size and
 * depth bounds are enforced, because this is the whole of what the projection
 * is allowed to write.
 */
export function planModuleSkillPackages(
  options: Readonly<{
    moduleId: string
    skillsDir: string
    files: readonly ModuleArtifactFile[]
    declaredSkillPaths: readonly string[]
  }>,
): readonly ModuleSkillPackagePlan[] {
  const { moduleId, skillsDir, files, declaredSkillPaths } = options
  const dataFiles = files.filter((file) => file.role === 'data')
  const plans: ModuleSkillPackagePlan[] = []
  // Keyed on the canonical form: `Coach` and `coach` are two manifest paths
  // but one directory on macOS and Windows, and the loser of that race would
  // leave a mode resolving to the other package's `SKILL.md`.
  const packageNames = new Set<string>()
  let plannedFileCount = 0
  for (const declared of declaredSkillPaths) {
    const packageName = resolveModuleSkillPackageName(declared)
    if (!packageName) {
      throw new Error(
        `Module "${moduleId}" skill "${declared}" must be a package path ending in "${SKILL_PACKAGE_ENTRY_FILE_NAME}"`,
      )
    }
    const entryPath = normalizeModuleArtifactFilePath(declared)
    const entryFile = dataFiles.find((file) => file.path === entryPath)
    if (!entryFile) {
      throw new Error(
        `Module "${moduleId}" skill "${entryPath}" is not a declared role:data artifact file`,
      )
    }
    const packageKey = canonicalArtifactPath(packageName)
    if (packageNames.has(packageKey)) {
      throw new Error(
        `Module "${moduleId}" declares two skill packages named "${packageName}"`,
      )
    }
    packageNames.add(packageKey)

    const packageDir = entryPath.slice(0, entryPath.lastIndexOf('/'))
    const packagePrefix = `${packageDir}/`
    const packageRoot = normalizePath(`${skillsDir}/${packageName}`)
    const packageMembers = dataFiles.filter((file) =>
      file.path.startsWith(packagePrefix),
    )
    const planFiles = packageMembers.map((file) => {
      const relative = file.path.slice(packagePrefix.length)
      const vaultPath = normalizePath(`${packageRoot}/${relative}`)
      if (!vaultPath.startsWith(`${packageRoot}/`)) {
        throw new Error(
          `Module "${moduleId}" skill file "${file.path}" escapes its package directory`,
        )
      }
      // Directory levels below the skills root: `coach/SKILL.md` is 1,
      // `coach/references/rubric.md` is 2 — the same counting `listTree` uses.
      if (relative.split('/').length > MAX_MODULE_SKILL_PROJECTION_DEPTH) {
        throw new Error(
          `Module "${moduleId}" skill file "${file.path}" exceeds the projection depth limit`,
        )
      }
      plannedFileCount += 1
      if (plannedFileCount > MAX_MODULE_SKILL_PROJECTION_ENTRIES) {
        throw new Error(
          `Module "${moduleId}" skill packages exceed the projection entry limit`,
        )
      }
      return Object.freeze({ file, vaultPath })
    })
    plans.push(
      Object.freeze({
        packageName,
        entryVaultPath: normalizePath(
          `${packageRoot}/${SKILL_PACKAGE_ENTRY_FILE_NAME}`,
        ),
        files: Object.freeze(planFiles),
      }),
    )
  }
  return Object.freeze(plans)
}

export function createModuleSkillMaterializer(
  options: ModuleSkillMaterializerOptions,
): ModuleSkillMaterializerV1 {
  /**
   * Enumerates what is currently under `root`. Stops and reports `overflowed`
   * rather than throwing once the tree runs past the bounds a projection can
   * legitimately have: everything found here is untrusted, so "too much of
   * it" is a reason to reset the root, never a reason to give up on it.
   */
  const listTree = async (
    root: string,
  ): Promise<
    Readonly<{ files: string[]; dirs: string[]; overflowed: boolean }>
  > => {
    const files: string[] = []
    const dirs: string[] = []
    const pending: { path: string; depth: number }[] = [
      { path: root, depth: 0 },
    ]
    while (pending.length > 0) {
      const current = pending.pop()!
      const listing = await options.vault.list(current.path)
      if (!listing) continue
      if (
        listing.folders.length > 0 &&
        current.depth >= MAX_MODULE_SKILL_PROJECTION_DEPTH
      ) {
        return { files, dirs, overflowed: true }
      }
      for (const file of listing.files) files.push(normalizePath(file))
      for (const folder of listing.folders) {
        const path = normalizePath(folder)
        dirs.push(path)
        pending.push({ path, depth: current.depth + 1 })
      }
      if (files.length + dirs.length > MAX_MODULE_SKILL_PROJECTION_ENTRIES) {
        return { files, dirs, overflowed: true }
      }
    }
    return { files, dirs, overflowed: false }
  }

  /** Drops every directory that is empty once the file pass has settled,
   * deepest first so a package root disappears with its subdirectories. */
  const removeEmptyDirs = async (dirs: readonly string[]): Promise<void> => {
    const ordered = [...new Set(dirs)].sort(
      (left, right) => right.split('/').length - left.split('/').length,
    )
    for (const dir of ordered) {
      const listing = await options.vault.list(dir)
      if (!listing) continue
      if (listing.files.length === 0 && listing.folders.length === 0) {
        await options.vault.removeDir(dir)
      }
    }
  }

  const ancestorsOf = (moduleId: string): string[] => [
    options.getSkillsDir(moduleId),
    options.getModuleDir(moduleId),
    options.getModulesRootDir(),
  ]

  return Object.freeze({
    materialize: async (moduleId, artifact, declaredSkillPaths, signal) => {
      assertModuleId(moduleId, 'Module id')
      if (artifact.manifest.id !== moduleId) {
        throw new Error(`Module "${moduleId}" artifact identity mismatch`)
      }
      const skillsDir = options.getSkillsDir(moduleId)
      const plans = planModuleSkillPackages({
        moduleId,
        skillsDir,
        files: artifact.variant.files,
        declaredSkillPaths,
      })
      const expected = new Map<string, ModuleArtifactFile>()
      for (const plan of plans) {
        for (const planned of plan.files) {
          expected.set(planned.vaultPath, planned.file)
        }
      }

      const readVerifiedBytes = async (
        file: ModuleArtifactFile,
      ): Promise<Uint8Array> => {
        const subtleCrypto = options.subtleCrypto ?? globalThis.crypto?.subtle
        if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
        throwIfAborted(signal)
        const bytes = await options.store.readEntryBytes(
          moduleId,
          artifact.manifest.version,
          file.path,
        )
        await verifyModuleBytes(
          bytes,
          file,
          `Module "${moduleId}" skill file "${file.path}"`,
          subtleCrypto,
        )
        return bytes
      }

      let existing = await listTree(skillsDir)
      const prefetched = new Map<string, Uint8Array>()
      if (existing.overflowed) {
        // Nothing under the root is trusted, so there is nothing to preserve:
        // drop it and let the writes below rebuild it from the artifact. This
        // is what keeps a projection root someone (or something) filled with
        // junk from failing every future activation of the module.
        //
        // The replacement bytes are read and verified first, because this is
        // the one branch that deletes unconditionally: a missing artifact
        // file or a hash mismatch discovered after the delete would leave the
        // root emptier than it was found.
        for (const [vaultPath, file] of expected) {
          prefetched.set(vaultPath, await readVerifiedBytes(file))
        }
        throwIfAborted(signal)
        await options.vault.removeDir(skillsDir)
        existing = { files: [], dirs: [], overflowed: false }
      }
      // Keyed on the canonical form, because the expected paths come from the
      // manifest and the existing ones from the Vault: renaming a package
      // from `Coach` to `coach` addresses one physical file on macOS and
      // Windows, and an exact-string comparison would read the write below as
      // an unexpected file and delete what it just wrote.
      const existingByCanonical = new Map<string, string[]>()
      for (const path of existing.files) {
        const key = canonicalArtifactPath(path)
        const aliases = existingByCanonical.get(key)
        if (aliases) aliases.push(path)
        else existingByCanonical.set(key, [path])
      }
      for (const [vaultPath, file] of expected) {
        const bytes =
          prefetched.get(vaultPath) ?? (await readVerifiedBytes(file))
        const aliases =
          existingByCanonical.get(canonicalArtifactPath(vaultPath)) ?? []
        if (aliases.length === 1 && aliases[0] === vaultPath) {
          const current = await options.vault.read(vaultPath)
          if (sameBytes(current, bytes)) continue
        }
        for (const alias of aliases) {
          if (alias === vaultPath) continue
          // Dropped before the write, not in the removal pass after it: on a
          // case-insensitive filesystem the alias *is* the write's target, so
          // removing it afterwards would take the new file with it.
          throwIfAborted(signal)
          await options.vault.removeFile(alias)
        }
        throwIfAborted(signal)
        await options.vault.write(vaultPath, bytes)
      }

      const expectedCanonical = new Set(
        [...expected.keys()].map((path) => canonicalArtifactPath(path)),
      )
      for (const path of existing.files) {
        if (expectedCanonical.has(canonicalArtifactPath(path))) continue
        throwIfAborted(signal)
        await options.vault.removeFile(path)
      }
      await removeEmptyDirs([...existing.dirs, ...ancestorsOf(moduleId)])
    },
    remove: async (moduleId) => {
      assertModuleId(moduleId, 'Module id')
      const moduleDir = options.getModuleDir(moduleId)
      if (await options.vault.list(moduleDir)) {
        await options.vault.removeDir(moduleDir)
      }
      await removeEmptyDirs([options.getModulesRootDir()])
    },
  })
}

/**
 * Vault-first, adapter-second: the projection must end up in Obsidian's file
 * index (that is what makes it readable by the agent's Vault-backed tools),
 * but a path left on disk by a previous session may not be indexed yet, and
 * the Vault API refuses to act on those. Both states are legitimately
 * reachable, so both are handled — the same split `yoloBaseDirRelocation.ts`
 * uses for host-owned directories.
 */
export function createObsidianModuleSkillProjectionVault(
  app: App,
): ModuleSkillProjectionVaultV1 {
  const adapter = app.vault.adapter
  const ensureFolder = async (path: string): Promise<void> => {
    let current = ''
    for (const segment of path.split('/').filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment
      const stat = await adapter.stat(current)
      if (stat?.type === 'folder') continue
      if (stat) throw new Error(`Path is not a folder: ${current}`)
      await app.vault.createFolder(current)
    }
  }
  return Object.freeze({
    list: async (dir) => {
      const path = normalizePath(dir)
      const stat = await adapter.stat(path)
      if (stat?.type !== 'folder') return null
      const listing = await adapter.list(path)
      return { files: listing.files, folders: listing.folders }
    },
    read: async (path) =>
      new Uint8Array(await adapter.readBinary(normalizePath(path))),
    write: async (path, bytes) => {
      const target = normalizePath(path)
      const parent = target.slice(0, target.lastIndexOf('/'))
      if (parent) await ensureFolder(parent)
      const contents = toArrayBuffer(bytes)
      const indexed = app.vault.getFileByPath(target)
      if (indexed) {
        await app.vault.modifyBinary(indexed, contents)
        return
      }
      if (await adapter.exists(target)) {
        await adapter.writeBinary(target, contents)
        return
      }
      await app.vault.createBinary(target, contents)
    },
    removeFile: async (path) => {
      const target = normalizePath(path)
      const indexed = app.vault.getAbstractFileByPath(target)
      if (indexed instanceof TFile) {
        // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Host-owned projection of a verified module artifact; trashing would pile up a copy on every module upgrade.
        await app.vault.delete(indexed)
        return
      }
      if (await adapter.exists(target)) await adapter.remove(target)
    },
    removeDir: async (path) => {
      const target = normalizePath(path)
      const indexed = app.vault.getAbstractFileByPath(target)
      if (indexed instanceof TFolder) {
        // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Host-owned projection of a verified module artifact; trashing would pile up a copy on every module upgrade.
        await app.vault.delete(indexed, true)
        return
      }
      if (await adapter.exists(target)) await adapter.rmdir(target, true)
    },
  })
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  )
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Module skill projection was aborted')
  }
}
