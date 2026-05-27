import { EditorView } from '@codemirror/view'
import {
  App,
  Editor,
  MarkdownView,
  TFile,
  TFolder,
  Vault,
  WorkspaceLeaf,
} from 'obsidian'

import { CHAT_VIEW_TYPE } from '../constants'
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
  if (selection) {
    const startLine = editor.getCursor('from').line
    const endLine = editor.getCursor('to').line
    return {
      content: selection,
      file,
      startLine: startLine + 1,
      endLine: endLine + 1,
    }
  }

  // Fallback: editor.getSelection() returns empty when the selection lives
  // inside a CM6 replace widget (e.g. rendered callouts in Live Preview).
  // Map the DOM range back to doc positions via posAtDOM, and expand to the
  // widget's source range via posAtCoords when the two endpoints collapse.
  return resolveMentionableBlockFromDomSelection(editor, file)
}

function resolveMentionableBlockFromDomSelection(
  editor: Editor,
  file: TFile,
): MentionableBlockData | null {
  const cm = (editor as { cm?: unknown }).cm
  if (!(cm instanceof EditorView)) {
    return null
  }

  const activeDoc = cm.contentDOM.ownerDocument ?? document
  const domSelection = activeDoc.getSelection()
  if (!domSelection || domSelection.rangeCount === 0) {
    return null
  }

  const range = domSelection.getRangeAt(0)
  if (!cm.contentDOM.contains(range.commonAncestorContainer)) {
    return null
  }

  let from = cm.posAtDOM(range.startContainer, range.startOffset)
  let to = cm.posAtDOM(range.endContainer, range.endOffset)
  if (from > to) {
    ;[from, to] = [to, from]
  }

  if (from === to) {
    const rect = range.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) {
      const topPos = cm.posAtCoords({ x: rect.left, y: rect.top })
      const bottomPos = cm.posAtCoords({
        x: Math.max(rect.right - 1, rect.left),
        y: Math.max(rect.bottom - 1, rect.top),
      })
      if (typeof topPos === 'number' && typeof bottomPos === 'number') {
        const a = Math.min(topPos, bottomPos)
        const b = Math.max(topPos, bottomPos)
        if (b > a) {
          from = a
          to = b
        }
      }
    }
  }

  const content =
    from < to ? cm.state.sliceDoc(from, to) : range.toString().trim()
  if (!content) {
    return null
  }

  const startLine = cm.state.doc.lineAt(from).number
  const endLine = cm.state.doc.lineAt(to).number

  return {
    content,
    file,
    startLine,
    endLine,
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

/**
 * 在主编辑区（rootSplit）新建一个 tab 并返回。
 *
 * 直接调用 `workspace.getLeaf('tab')` 会基于当前 active leaf 的父 split 新开 tab，
 * 当聊天视图处于激活状态时，新 tab 会被塞进 chat 那一栏（无论 chat 在侧边栏还是
 * 主区的某个 split 里），覆盖聊天面板。这里需要锁定一个非 chat 的主区 leaf 作为
 * 锚点，再让 Obsidian 在它旁边新开 tab。
 */
function openTabInMainArea(app: App): WorkspaceLeaf {
  const anchor = findMainAreaAnchorLeaf(app)
  if (anchor) {
    app.workspace.setActiveLeaf(anchor, { focus: false })
    return app.workspace.getLeaf('tab')
  }

  // 主区只剩 chat：在 chat 右侧 split 一个新 leaf（贴合多数编辑器"预览/跳转打开在右侧"的直觉）。
  const chatLeaf = app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]
  if (chatLeaf) {
    return app.workspace.createLeafBySplit(chatLeaf, 'vertical', false)
  }

  return app.workspace.getLeaf(false)
}

function findMainAreaAnchorLeaf(app: App): WorkspaceLeaf | null {
  const recent = app.workspace.getMostRecentLeaf(app.workspace.rootSplit)
  if (recent && recent.view.getViewType() !== CHAT_VIEW_TYPE) {
    return recent
  }

  let anchor: WorkspaceLeaf | null = null
  app.workspace.iterateRootLeaves((leaf) => {
    if (anchor) return
    if (leaf.view.getViewType() === CHAT_VIEW_TYPE) return
    anchor = leaf
  })
  return anchor
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
    const leaf = openTabInMainArea(app)
    void leaf.openFile(file, {
      eState: startLine ? { line: startLine - 1 } : undefined, // -1 because line is 0-indexed
    })
  }
}

/** Open a vault PDF at a 1-based page (Obsidian PDF viewer subpath `#page=N`). */
export function openPdfFileAtPage(
  app: App,
  filePath: string,
  page: number,
): void {
  const file = app.vault.getFileByPath(filePath)
  if (!file) return
  const safePage = Math.max(1, Math.floor(page))
  const leaf = openTabInMainArea(app)
  void leaf.openFile(file, { eState: { subpath: `#page=${safePage}` } })
}
