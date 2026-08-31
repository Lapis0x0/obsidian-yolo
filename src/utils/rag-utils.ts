import { TFile, TFolder, Vault } from 'obsidian'

/**
 * List all folder paths in the vault (relative paths like "", "Folder", "Folder/Sub").
 * Fallback-friendly: if folders are not directly iterable, it derives them from files.
 */
function normalizeFolderPath(p: string | undefined | null): string {
  if (!p || p === '/') return ''
  // remove any leading slashes and trailing slashes
  const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '')
  return trimmed
}

export function listAllFolderPaths(vault: Vault): string[] {
  const folderSet = new Set<string>()

  try {
    // Prefer using Obsidian API to get all loaded files (includes folders)
    const all = vault.getAllLoadedFiles?.()
    if (all && Array.isArray(all)) {
      for (const f of all) {
        if (f instanceof TFolder) {
          folderSet.add(normalizeFolderPath(f.path))
        } else if (f instanceof TFile) {
          const parts = f.path.split('/')
          parts.pop() // remove filename
          for (let i = 1; i <= parts.length; i++) {
            folderSet.add(normalizeFolderPath(parts.slice(0, i).join('/')))
          }
        }
      }
    }
  } catch {
    // ignore and fallback below
  }

  // Fallback: derive from markdown files if needed
  if (folderSet.size === 0) {
    try {
      const files = vault.getMarkdownFiles()
      for (const f of files) {
        const parts = f.path.split('/')
        parts.pop()
        for (let i = 1; i <= parts.length; i++) {
          folderSet.add(normalizeFolderPath(parts.slice(0, i).join('/')))
        }
      }
    } catch {
      // ignore
    }
  }

  // Always include root (empty string) to represent vault root
  folderSet.add('')

  return Array.from(folderSet).sort((a, b) => a.localeCompare(b))
}
