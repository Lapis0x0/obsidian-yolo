import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { getYoloSnippetsPath } from '../paths/yoloPaths'
import { DEFAULT_SNIPPETS_TEMPLATE } from './templates'

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

/**
 * Ensure that `YOLO/snippets.md` exists. If it already exists as a file, just
 * return it. If a non-file path exists at the same location, or if any parent
 * path exists but is not a folder, throws.
 *
 * Parent folders are created recursively as needed.
 */
export async function ensureSnippetsFile(
  app: App,
  settings: YoloSettingsLike,
): Promise<TFile> {
  const snippetsPath = getYoloSnippetsPath(settings)
  const existing = app.vault.getAbstractFileByPath(snippetsPath)
  if (existing instanceof TFile) {
    return existing
  }
  if (existing) {
    throw new Error(`Path exists and is not a file: ${snippetsPath}`)
  }

  const lastSlash = snippetsPath.lastIndexOf('/')
  if (lastSlash > 0) {
    const dirPath = normalizePath(snippetsPath.slice(0, lastSlash))
    const segments = dirPath.split('/').filter((s) => s.length > 0)
    let currentPath = ''
    for (const segment of segments) {
      currentPath =
        currentPath.length > 0 ? `${currentPath}/${segment}` : segment
      const node = app.vault.getAbstractFileByPath(currentPath)
      if (!node) {
        await app.vault.createFolder(currentPath)
      } else if (!(node instanceof TFolder)) {
        throw new Error(`Path exists and is not a folder: ${currentPath}`)
      }
    }
  }
  return app.vault.create(snippetsPath, DEFAULT_SNIPPETS_TEMPLATE)
}

/**
 * Ensure the snippets file exists, then open it. When `heading` is provided,
 * Obsidian jumps the cursor to that heading.
 */
export async function openSnippetsFileInVault(
  app: App,
  settings: YoloSettingsLike,
  options?: { heading?: string },
): Promise<void> {
  const file = await ensureSnippetsFile(app, settings)
  const heading = options?.heading
  if (heading) {
    await app.workspace.openLinkText(`${file.path}#${heading}`, '')
  } else {
    const leaf = app.workspace.getLeaf(false)
    await leaf.openFile(file)
  }
}
