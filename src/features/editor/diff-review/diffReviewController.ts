import { Compartment, Prec, StateEffect } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { type Editor, MarkdownView, type WorkspaceLeaf } from 'obsidian'

import { InlineDiffReviewOverlay } from '../../../components/apply-view/InlineDiffReviewOverlay'
import type { ApplyViewActions } from '../../../components/apply-view/types'
import type YoloPlugin from '../../../main'
import type {
  ApplyViewCallbacks,
  ApplyViewState,
} from '../../../types/apply-view.types'

/** The review in progress, as far as anything outside the editor needs to
 * know: which file, and which conversation's tool call is waiting on it. */
export type ActiveDiffReview = {
  filePath: string
  conversationId?: string
}

type DiffReviewControllerDeps = {
  plugin: YoloPlugin
  getActiveMarkdownView: () => MarkdownView | null
  getEditorView: (editor: Editor) => EditorView | null
}

export class DiffReviewController {
  private readonly deps: DiffReviewControllerDeps
  private readonly diffReviewCompartment = new Compartment()
  private readonly extensionViews = new Set<EditorView>()
  private readonly diffReviewExtension = [
    Prec.high(
      keymap.of([
        {
          key: 'Ctrl-Enter',
          run: () =>
            this.runAction((actions) => actions.acceptIncomingActive()),
        },
        {
          key: 'Mod-Enter',
          run: () =>
            this.runAction((actions) => actions.acceptIncomingActive()),
        },
        {
          key: 'Escape',
          run: () => this.runAction((actions) => actions.close()),
        },
      ]),
    ),
  ]

  private activeView: EditorView | null = null
  private activeMarkdownView: MarkdownView | null = null
  private activeReview: ActiveDiffReview | null = null
  private readonly activeReviewListeners = new Set<() => void>()
  private activeOverlay: { mount: () => void; destroy: () => void } | null =
    null
  private activeActions: ApplyViewActions | null = null
  private activeReviewCallbacks: ApplyViewCallbacks | null = null
  private activeReviewSettled = false

  constructor(deps: DiffReviewControllerDeps) {
    this.deps = deps
  }

  /**
   * Open the review in an editor showing `state.file`: the active tab if it
   * shows the file, else any tab that does, else the file opened in the
   * current tab. The review lives in CodeMirror, which a tab in reading view
   * does not have, so that tab is switched to editing first — asking to apply
   * an edit is asking to edit.
   */
  async openReviewForFile(state: ApplyViewState): Promise<boolean> {
    const { workspace } = this.deps.plugin.app
    const showsFile = (leaf: WorkspaceLeaf | null | undefined) =>
      leaf?.view instanceof MarkdownView &&
      leaf.view.file?.path === state.file.path

    let leaf = this.deps.getActiveMarkdownView()?.leaf
    if (!showsFile(leaf)) {
      leaf = workspace.getLeavesOfType('markdown').find(showsFile)
    }
    if (!leaf) {
      leaf = workspace.getLeaf(false)
      await leaf.openFile(state.file, { active: true })
    }

    const viewState = leaf.getViewState()
    if (viewState.state?.mode !== 'source') {
      await leaf.setViewState({
        ...viewState,
        state: { ...viewState.state, mode: 'source' },
      })
    }
    workspace.setActiveLeaf(leaf, { focus: true })

    return (
      leaf.view instanceof MarkdownView &&
      this.openReviewInView(leaf.view, state)
    )
  }

  openReviewInView(markdownView: MarkdownView, state: ApplyViewState): boolean {
    if (!markdownView.file) return false
    if (markdownView.file.path !== state.file.path) return false
    const editorView = this.deps.getEditorView(markdownView.editor)
    if (!editorView) return false

    this.startReview(markdownView, editorView, state)
    return true
  }

  getActiveReview = (): ActiveDiffReview | null => this.activeReview

  subscribeActiveReview = (listener: () => void): (() => void) => {
    this.activeReviewListeners.add(listener)
    return () => {
      this.activeReviewListeners.delete(listener)
    }
  }

  /** Bring the review's editor to the front, on its current change. */
  async revealActiveReview(): Promise<void> {
    const markdownView = this.activeMarkdownView
    if (!markdownView) return
    const { workspace } = this.deps.plugin.app
    await workspace.revealLeaf(markdownView.leaf)
    workspace.setActiveLeaf(markdownView.leaf, { focus: true })
    this.activeActions?.revealActive()
  }

  private setActiveReview(review: ActiveDiffReview | null): void {
    this.activeReview = review
    for (const listener of this.activeReviewListeners) listener()
  }

  closeReview(): void {
    if (!this.activeView) return

    if (!this.activeReviewSettled) {
      this.activeReviewCallbacks?.onCancel?.()
    }
    this.activeReviewCallbacks = null
    this.activeReviewSettled = false

    this.activeOverlay?.destroy()
    this.activeOverlay = null
    this.activeActions = null

    if (this.extensionViews.has(this.activeView)) {
      this.activeView.dispatch({
        effects: this.diffReviewCompartment.reconfigure([]),
      })
    }
    this.activeView = null
    this.activeMarkdownView = null
    this.setActiveReview(null)
  }

  destroy(): void {
    this.closeReview()
    for (const view of this.extensionViews) {
      view.dispatch({
        effects: this.diffReviewCompartment.reconfigure([]),
      })
    }
    this.extensionViews.clear()
  }

  private startReview(
    markdownView: MarkdownView,
    view: EditorView,
    state: ApplyViewState,
  ): void {
    if (this.activeView) {
      this.closeReview()
    }

    this.ensureExtension(view)
    view.dispatch({
      effects: this.diffReviewCompartment.reconfigure(this.diffReviewExtension),
    })

    this.activeView = view
    this.activeMarkdownView = markdownView
    this.setActiveReview({
      filePath: state.file.path,
      conversationId: state.conversationId,
    })

    const reviewState =
      state.reviewMode === 'selection-focus' &&
      !this.hasValidSelectionRange(view, state)
        ? {
            ...state,
            reviewMode: 'full' as const,
          }
        : state

    const wrappedCallbacks = this.wrapReviewCallbacks(reviewState.callbacks)
    const reviewStateWithCallbacks: ApplyViewState = {
      ...reviewState,
      callbacks: wrappedCallbacks,
    }
    this.activeReviewCallbacks = wrappedCallbacks
    this.activeReviewSettled = false

    this.activeOverlay = new InlineDiffReviewOverlay({
      plugin: this.deps.plugin,
      view,
      state: reviewStateWithCallbacks,
      requestSave: () => markdownView.requestSave(),
      onClose: () => this.closeReview(),
      onActionsReady: (actions) => {
        this.activeActions = actions
      },
    })
    this.activeOverlay.mount()
  }

  private wrapReviewCallbacks(
    callbacks: ApplyViewCallbacks | undefined,
  ): ApplyViewCallbacks {
    return {
      onComplete: (result) => {
        this.activeReviewSettled = true
        callbacks?.onComplete?.(result)
      },
      onCancel: () => {
        this.activeReviewSettled = true
        callbacks?.onCancel?.()
      },
    }
  }

  private hasValidSelectionRange(
    view: EditorView,
    state: ApplyViewState,
  ): boolean {
    const range = state.selectionRange
    if (!range) return false
    if (view.state.doc.lines <= 0) return false

    const fromLine = range.from.line + 1
    const toLine = range.to.line + 1
    if (fromLine < 1 || toLine < 1) return false
    if (fromLine > view.state.doc.lines || toLine > view.state.doc.lines) {
      return false
    }

    const fromDocLine = view.state.doc.line(fromLine)
    const toDocLine = view.state.doc.line(toLine)
    if (range.from.ch < 0 || range.from.ch > fromDocLine.length) return false
    if (range.to.ch < 0 || range.to.ch > toDocLine.length) return false

    return true
  }

  private ensureExtension(view: EditorView): void {
    // Loading another note into the editor replaces its whole state, which
    // drops this compartment, so membership alone does not mean it is there.
    if (
      this.extensionViews.has(view) &&
      this.diffReviewCompartment.get(view.state) !== undefined
    ) {
      return
    }
    view.dispatch({
      effects: StateEffect.appendConfig.of([this.diffReviewCompartment.of([])]),
    })
    this.extensionViews.add(view)
  }

  private runAction(run: (actions: ApplyViewActions) => void): boolean {
    const actions = this.activeActions
    if (!actions) return false
    run(actions)
    return true
  }
}
