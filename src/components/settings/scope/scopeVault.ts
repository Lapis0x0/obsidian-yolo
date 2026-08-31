import { TFile, TFolder, Vault } from 'obsidian'

import {
  type YoloSettingsLike,
  isWithinYoloBaseDir,
} from '../../../core/paths/yoloPaths'

import { ScopePathKind, normalizeScopePath } from './scopeRules'

/** Folder unless the vault says otherwise — a rule may name a path that no
 * longer exists, and folder is the safer guess for a scope rule. */
export function resolveScopePathKind(
  vault: Vault,
  path: string,
): ScopePathKind {
  const normalized = normalizeScopePath(path)
  if (normalized === '') return 'folder'
  const abstract = vault.getAbstractFileByPath(normalized)
  if (abstract instanceof TFile) return 'file'
  if (abstract instanceof TFolder) return 'folder'
  return 'folder'
}

/**
 * The files a scope is measured against: every vault file, optionally
 * narrowed to the extensions a consumer can actually use (RAG indexes `md`
 * and, when enabled, `pdf`; the agent can reach anything). `settings`, when
 * given, excludes the YOLO base directory — the same always-on exclusion the
 * real indexer applies (`VectorManager.listIndexableFiles`) — so a RAG scope
 * estimate never counts files the index will never actually contain.
 */
export function collectScopeCandidateFiles(
  vault: Vault,
  extensions?: readonly string[],
  settings?: YoloSettingsLike | null,
): string[] {
  const files = vault.getFiles()
  const filtered = extensions
    ? files.filter((file) => extensions.includes(file.extension))
    : files
  return filtered
    .filter((file) => !isWithinYoloBaseDir(file.path, settings))
    .map((file) => file.path)
}
