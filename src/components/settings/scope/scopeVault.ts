import { TFile, TFolder, Vault } from 'obsidian'

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
 * and, when enabled, `pdf`; the agent can reach anything).
 */
export function collectScopeCandidateFiles(
  vault: Vault,
  extensions?: readonly string[],
): string[] {
  const files = vault.getFiles()
  const filtered = extensions
    ? files.filter((file) => extensions.includes(file.extension))
    : files
  return filtered.map((file) => file.path)
}
