import { App, Editor, MarkdownView, TFile, TFolder, Vault } from 'obsidian'

import { MentionableBlockData } from '../types/mentionable'

export async function readTFileContent(
  file: TFile,
  vault: Vault,
): Promise<string> {
  return await vault.cachedRead(file)
}

export async function readMultipleTFiles(
  files: TFile[],
  vault: Vault,
): Promise<string[]> {
  // Read files in parallel
  const readPromises = files.map((file) => readTFileContent(file, vault))
  return await Promise.all(readPromises)
}

export function getNestedFiles(folder: TFolder, vault: Vault): TFile[] {
  const files: TFile[] = []
  for (const child of folder.children) {
    if (child instanceof TFile) {
      files.push(child)
    } else if (child instanceof TFolder) {
      files.push(...getNestedFiles(child, vault))
    }
  }
  return files
}

export function getMentionableBlockData(
  editor: Editor,
  view: MarkdownView,
): MentionableBlockData | null {
  const file = view.file
  if (!file) {
    return null
  }

  const selection = editor.getSelection()
  if (!selection) {
    return null
  }

  const startLine = editor.getCursor('from').line
  const endLine = editor.getCursor('to').line
  const selectionContent = editor
    .getValue()
    .split('\n')
    .slice(startLine, endLine + 1)
    .join('\n')

  return {
    content: selectionContent,
    file,
    startLine: startLine + 1, // +1 because startLine is 0-indexed
    endLine: endLine + 1, // +1 because startLine is 0-indexed
  }
}

export function getOpenFiles(app: App): TFile[] {
  try {
    const leaves = app.workspace.getLeavesOfType('markdown')
    return leaves
      .map((leaf) =>
        leaf.view instanceof MarkdownView ? leaf.view.file : null,
      )
      .filter((file): file is TFile => Boolean(file))
  } catch {
    return []
  }
}

export function calculateFileDistance(
  file1: TFile | TFolder | { path: string },
  file2: TFile | TFolder | { path: string },
): number | null {
  // Prefer runtime type checks against Obsidian types when available
  const hasStringPath = (obj: unknown): obj is { path: string } =>
    typeof obj === 'object' &&
    obj !== null &&
    'path' in obj &&
    typeof (obj as Record<string, unknown>).path === 'string'

  const getPath = (f: TFile | TFolder | { path: string }): string => {
    if (f instanceof TFile || f instanceof TFolder) return f.path
    if (hasStringPath(f)) return f.path
    throw new Error(
      'Invalid argument: expected TFile/TFolder or object with path',
    )
  }

  const path1 = getPath(file1).split('/')
  const path2 = getPath(file2).split('/')

  // Check if files are in different top-level folders
  if (path1[0] !== path2[0]) {
    return null
  }

  let distance = 0
  let i = 0

  // Find the common ancestor
  while (i < path1.length && i < path2.length && path1[i] === path2[i]) {
    i++
  }

  // Calculate distance from common ancestor to each file
  distance += path1.length - i
  distance += path2.length - i

  return distance
}

export function openMarkdownFile(
  app: App,
  filePath: string,
  startLine?: number,
) {
  const file = app.vault.getFileByPath(filePath)
  if (!file) return

  const existingLeaf = app.workspace
    .getLeavesOfType('markdown')
    .find(
      (leaf) =>
        leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path,
    )

  if (existingLeaf) {
    app.workspace.setActiveLeaf(existingLeaf, { focus: true })

    if (startLine && existingLeaf.view instanceof MarkdownView) {
      existingLeaf.view.setEphemeralState({ line: startLine - 1 }) // -1 because line is 0-indexed
    }
  } else {
    const leaf = app.workspace.getLeaf('tab')
    void leaf.openFile(file, {
      eState: startLine ? { line: startLine - 1 } : undefined, // -1 because line is 0-indexed
    })
  }
}
