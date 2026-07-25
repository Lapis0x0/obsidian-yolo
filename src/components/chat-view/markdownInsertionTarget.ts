import { MarkdownView } from 'obsidian'
import type { TFile, Workspace } from 'obsidian'

type InsertionWorkspace = Pick<
  Workspace,
  'getActiveViewOfType' | 'getLeavesOfType'
> & {
  lastActiveFile?: TFile | null
}

export function getMarkdownInsertionTarget(
  workspace: InsertionWorkspace,
  ownerDocument: Document | null | undefined,
): MarkdownView | null {
  const lastActiveFile = workspace.lastActiveFile
  const matchingViews = lastActiveFile
    ? workspace
        .getLeavesOfType('markdown')
        .map((leaf) => leaf.view)
        .filter(
          (view): view is MarkdownView =>
            view instanceof MarkdownView &&
            view.file?.path === lastActiveFile.path &&
            isMarkdownViewVisible(view),
        )
    : []

  const sameWindowView = matchingViews.find(
    (view) => view.containerEl.ownerDocument === ownerDocument,
  )
  if (sameWindowView) {
    return sameWindowView
  }

  if (matchingViews.length > 0) {
    return matchingViews[0]
  }

  const activeMarkdownView = workspace.getActiveViewOfType(MarkdownView)
  return activeMarkdownView && isMarkdownViewVisible(activeMarkdownView)
    ? activeMarkdownView
    : null
}

function isMarkdownViewVisible(view: MarkdownView): boolean {
  const { containerEl } = view
  const maybeIsShown = (containerEl as HTMLElement & { isShown?: unknown })
    .isShown
  if (typeof maybeIsShown === 'function') {
    return maybeIsShown.call(containerEl) as boolean
  }
  return (
    containerEl.offsetParent !== null || containerEl.getClientRects().length > 0
  )
}
