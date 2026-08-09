import { App, TFile, TFolder } from 'obsidian'

import type { AssistantWorkspaceScope } from '../../../types/assistant.types'
import {
  createVaultFolder,
  ensureFolderPathExists,
  getParentFolderPath,
  moveVaultPath,
  trashVaultPath,
} from '../../mcp/vaultFileOps'
import { isWithinYoloUserDataRoot } from '../../paths/yoloPaths'
import type {
  BashFsCallbacks,
  BashFsDirentEntry,
  BashFsRmResult,
  BashFsStat,
} from '../../runtime-components/contracts'
import { isPathAllowedByScope } from '../workspaceScope'

const SCOPE_ERROR_PREFIX = 'EACCES: path is outside the allowed workspace scope'

type BashFsSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

const stripSlashes = (raw: string): string =>
  raw.replace(/^\/+/, '').replace(/\/+$/, '')

/**
 * `fs_list`/`fs_search`/`fs_read`/etc. enforced workspace scope by rejecting
 * out-of-scope path *arguments* before dispatch. The bash tool has no
 * discrete path arguments — `command` is an opaque shell string — so scope
 * has to be enforced at the filesystem boundary instead, exactly where
 * `rm`/`mv`/content writes already are (see CLAUDE.md's "fs 层 = 硬边界"
 * principle carried over from the plan). An include-list scope still needs
 * its ancestor directories visible so `ls`/`find` can descend into them;
 * `isAncestorOfIncludeRule` grants that without allowing the ancestor's
 * *content* to be read.
 */
function isAncestorOfIncludeRule(
  vaultPath: string,
  scope: AssistantWorkspaceScope,
): boolean {
  if (scope.include.length === 0) return false
  const normalizedPath = stripSlashes(vaultPath)
  return scope.include.some((rule) => {
    const normalizedRule = stripSlashes(rule)
    return (
      normalizedRule === normalizedPath ||
      normalizedRule.startsWith(
        normalizedPath === '' ? '' : `${normalizedPath}/`,
      )
    )
  })
}

function assertPathInScope(
  vaultPath: string,
  scope: AssistantWorkspaceScope | undefined,
): void {
  if (!scope?.enabled) return
  if (isPathAllowedByScope(vaultPath, scope)) return
  throw new Error(`${SCOPE_ERROR_PREFIX}: '${vaultPath}'`)
}

function isVisibleForTraversal(
  vaultPath: string,
  scope: AssistantWorkspaceScope | undefined,
): boolean {
  if (!scope?.enabled) return true
  return (
    isPathAllowedByScope(vaultPath, scope) ||
    isAncestorOfIncludeRule(vaultPath, scope)
  )
}

/**
 * Bridges the bash-engine runtime component's minimal filesystem contract
 * (`BashFsCallbacks`) to the Obsidian Vault. Every method here receives a
 * vault-relative path with no leading slash (`''` means the vault root) —
 * the `/vault` mount point and root-directory synthesis live entirely in the
 * runtime component (see `runtime-components/bash-engine/src/entry.ts`), so
 * this adapter never has to think about path namespacing.
 *
 * Reads go through `cachedRead`/`readBinary` (no upfront full-vault load).
 * The three writes this exposes (`mkdir`/`rm`/`mv`) delegate to the same
 * service functions the retired `fs_create_dir`/`fs_delete`/`fs_move` tools
 * used (`src/core/mcp/vaultFileOps.ts`), so trash/backlink-rewrite behavior
 * is identical. Content mutation has no callback here at all — the bash tool
 * never writes file content; that stays on `fs_edit`/`fs_write`.
 *
 * `scope` mirrors the workspace-scope confinement other local tools already
 * respect (used to sandbox subagents to a folder subtree); when set, every
 * operation here is denied for paths outside it.
 *
 * `settings` (when supplied) hides the visible `<baseDir>/data` user-data
 * root from every operation below, treating it exactly like a path that
 * doesn't exist. That root holds chat history, module settings, and other
 * internal storage that must live outside a hidden dot-directory so vault
 * sync tools replicate it (see `ensureUserDataRootDir`) — but it was never
 * meant to be agent-readable content. Before that migration the equivalent
 * `.yolo_json_db` root got this same invisibility for free, because Obsidian
 * never indexes dot-prefixed paths into the `TFile` tree this adapter reads
 * from; this is that protection's explicit replacement for the now-visible
 * root.
 */
export function createVaultBashFileSystem(
  app: App,
  scope?: AssistantWorkspaceScope,
  settings?: BashFsSettingsLike | null,
): BashFsCallbacks {
  const isHiddenUserDataPath = (vaultPath: string): boolean =>
    vaultPath !== '' && isWithinYoloUserDataRoot(vaultPath, settings)
  const assertNotHiddenUserDataPath = (
    vaultPath: string,
    verb: string,
  ): void => {
    if (isHiddenUserDataPath(vaultPath)) {
      throw new Error(
        `ENOENT: no such file or directory, ${verb} '${vaultPath}'`,
      )
    }
  }
  const getFileOrThrow = (vaultPath: string): TFile => {
    const abstractFile = app.vault.getAbstractFileByPath(vaultPath)
    if (!abstractFile) {
      throw new Error(`ENOENT: no such file or directory, open '${vaultPath}'`)
    }
    if (!(abstractFile instanceof TFile)) {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${vaultPath}'`,
      )
    }
    return abstractFile
  }

  return {
    async readFile(vaultPath) {
      assertNotHiddenUserDataPath(vaultPath, 'open')
      assertPathInScope(vaultPath, scope)
      return app.vault.cachedRead(getFileOrThrow(vaultPath))
    },

    async readFileBuffer(vaultPath) {
      assertNotHiddenUserDataPath(vaultPath, 'open')
      assertPathInScope(vaultPath, scope)
      const buffer = await app.vault.readBinary(getFileOrThrow(vaultPath))
      return new Uint8Array(buffer)
    },

    async exists(vaultPath) {
      if (vaultPath === '') return true
      if (isHiddenUserDataPath(vaultPath)) return false
      if (scope?.enabled && !isVisibleForTraversal(vaultPath, scope)) {
        return false
      }
      return app.vault.getAbstractFileByPath(vaultPath) !== null
    },

    async stat(vaultPath): Promise<BashFsStat> {
      if (vaultPath === '') {
        return { isFile: false, isDirectory: true, mtimeMs: 0, size: 0 }
      }
      assertNotHiddenUserDataPath(vaultPath, 'stat')
      assertPathInScope(vaultPath, scope)
      const abstractFile = app.vault.getAbstractFileByPath(vaultPath)
      if (!abstractFile) {
        throw new Error(
          `ENOENT: no such file or directory, stat '${vaultPath}'`,
        )
      }
      if (abstractFile instanceof TFile) {
        return {
          isFile: true,
          isDirectory: false,
          mtimeMs: abstractFile.stat.mtime,
          size: abstractFile.stat.size,
        }
      }
      return { isFile: false, isDirectory: true, mtimeMs: 0, size: 0 }
    },

    async mkdir(vaultPath, options) {
      assertNotHiddenUserDataPath(vaultPath, 'mkdir')
      assertPathInScope(vaultPath, scope)
      const existing =
        vaultPath === ''
          ? undefined
          : app.vault.getAbstractFileByPath(vaultPath)
      if (existing) {
        if (options?.recursive && existing instanceof TFolder) {
          // `mkdir -p` on an already-existing directory is a success, not an
          // error — mirrors POSIX and Node's `fs.mkdir(..., {recursive})`.
          return
        }
        throw new Error(`EEXIST: file already exists, mkdir '${vaultPath}'`)
      }
      if (options?.recursive) {
        await ensureFolderPathExists(app, vaultPath)
        return
      }
      const parent = getParentFolderPath(vaultPath)
      if (parent && !app.vault.getAbstractFileByPath(parent)) {
        throw new Error(
          `ENOENT: no such file or directory, mkdir '${vaultPath}'`,
        )
      }
      await createVaultFolder(app, vaultPath)
    },

    async readdir(vaultPath): Promise<BashFsDirentEntry[]> {
      assertNotHiddenUserDataPath(vaultPath, 'scandir')
      if (scope?.enabled && !isVisibleForTraversal(vaultPath, scope)) {
        throw new Error(`${SCOPE_ERROR_PREFIX}: '${vaultPath}'`)
      }
      const folder =
        vaultPath === ''
          ? app.vault.getRoot()
          : app.vault.getAbstractFileByPath(vaultPath)
      if (!folder) {
        throw new Error(
          `ENOENT: no such file or directory, scandir '${vaultPath}'`,
        )
      }
      if (!(folder instanceof TFolder)) {
        throw new Error(`ENOTDIR: not a directory, scandir '${vaultPath}'`)
      }
      const children = folder.children
        .filter((child) => !isHiddenUserDataPath(child.path))
        .filter((child) =>
          scope?.enabled ? isVisibleForTraversal(child.path, scope) : true,
        )
      return children.map((child) => ({
        name: child.name,
        isFile: child instanceof TFile,
        isDirectory: child instanceof TFolder,
      }))
    },

    async rm(vaultPath, options): Promise<BashFsRmResult> {
      assertNotHiddenUserDataPath(vaultPath, 'unlink')
      assertPathInScope(vaultPath, scope)
      return trashVaultPath(app, vaultPath, options)
    },

    async mv(oldVaultPath, newVaultPath) {
      assertNotHiddenUserDataPath(oldVaultPath, 'rename')
      assertNotHiddenUserDataPath(newVaultPath, 'rename')
      assertPathInScope(oldVaultPath, scope)
      assertPathInScope(newVaultPath, scope)
      await moveVaultPath(app, oldVaultPath, newVaultPath)
    },

    getAllPaths(): string[] {
      const paths = app.vault
        .getAllLoadedFiles()
        .map((file) => file.path)
        .filter((filePath) => filePath !== '' && filePath !== '/')
        .filter((filePath) => !isHiddenUserDataPath(filePath))
      return scope?.enabled
        ? paths.filter((filePath) => isPathAllowedByScope(filePath, scope))
        : paths
    },
  }
}
