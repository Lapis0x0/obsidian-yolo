import { MarkdownView } from 'obsidian'
import type { Workspace, WorkspaceLeaf } from 'obsidian'

type InsertionWorkspace = Pick<
  Workspace,
  'getActiveViewOfType' | 'getLeavesOfType'
>

export class MarkdownInsertionTargetTracker {
  private lastActiveMarkdownLeaf: WorkspaceLeaf | null = null

  constructor(private readonly workspace: InsertionWorkspace) {}

  captureCurrentLeaf(): void {
    const activeView = this.workspace.getActiveViewOfType(MarkdownView)
    if (!activeView) {
      return
    }

    const activeLeaf = this.workspace
      .getLeavesOfType('markdown')
      .find((leaf) => leaf.view === activeView)
    this.trackActiveLeaf(activeLeaf ?? null)
  }

  trackActiveLeaf(leaf: WorkspaceLeaf | null): void {
    if (leaf?.view instanceof MarkdownView) {
      this.lastActiveMarkdownLeaf = leaf
    }
  }

  getTarget(): MarkdownView | null {
    const trackedLeaf = this.lastActiveMarkdownLeaf
    if (!trackedLeaf) {
      return null
    }

    const openLeaf = this.workspace
      .getLeavesOfType('markdown')
      .find((leaf) => leaf === trackedLeaf)
    if (!(openLeaf?.view instanceof MarkdownView)) {
      return null
    }

    return openLeaf.view.containerEl.isShown() ? openLeaf.view : null
  }
}
