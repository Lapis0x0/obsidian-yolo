import { Compartment, EditorState, Prec, StateEffect } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { Editor, MarkdownView } from 'obsidian'

import { ApplyReviewOverlay } from '../../../components/apply-view/ApplyReviewOverlay'
import { InlineDiffReviewOverlay } from '../../../components/apply-view/InlineDiffReviewOverlay'
import type { ApplyViewActions } from '../../../components/apply-view/types'
import type SmartComposerPlugin from '../../../main'
import type { ApplyViewState } from '../../../types/apply-view.types'
import { createDiffBlocks } from '../../../utils/chat/diff'

const INLINE_DIFF_REVIEW_THRESHOLD = 3

type DiffReviewControllerDeps = {
  plugin: SmartComposerPlugin
  getActiveMarkdownView: () => MarkdownView | null
  getEditorView: (editor: Editor) => EditorView | null
}

export class DiffReviewController {
  private readonly deps: DiffReviewControllerDeps
  private readonly diffReviewCompartment = new Compartment()
  private readonly extensionViews = new Set<EditorView>()
  private readonly diffReviewExtension = [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.theme({
      '.cm-content': {
        caretColor: 'transparent',
      },
      '.cm-cursorLayer': {
        display: 'none !important',
      },
      '.cm-cursor': {
        display: 'none !important',
      },
      '.cm-fat-cursor': {
        display: 'none !important',
      },
      '.cm-fat-cursor-mark': {
        display: 'none !important',
      },
      '.cm-dropCursor': {
        display: 'none !important',
      },
      '.cm-selectionLayer': {
        display: 'none !important',
      },
      '.cm-selectionBackground': {
        background: 'transparent !important',
      },
    }),
    Prec.high(
      keymap.of([
        {
          key: 'Ctrl-ArrowUp',
          run: () => this.runAction((actions) => actions.goToPreviousDiff()),
        },
        {
          key: 'Ctrl-ArrowDown',
          run: () => this.runAction((actions) => actions.goToNextDiff()),
        },
        {
          key: 'Mod-ArrowUp',
          run: () => this.runAction((actions) => actions.goToPreviousDiff()),
        },
        {
          key: 'Mod-ArrowDown',
          run: () => this.runAction((actions) => actions.goToNextDiff()),
        },
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
          key: 'Ctrl-Backspace',
          run: () => this.runAction((actions) => actions.acceptCurrentActive()),
        },
        {
          key: 'Mod-Backspace',
          run: () => this.runAction((actions) => actions.acceptCurrentActive()),
        },
        {
          key: 'Escape',
          run: () => this.runAction((actions) => actions.close()),
        },
      ]),
    ),
  ]

  private activeView: EditorView | null = null
  private activeOverlay: { mount: () => void; destroy: () => void } | null =
    null
  private activeActions: ApplyViewActions | null = null

  constructor(deps: DiffReviewControllerDeps) {
    this.deps = deps
  }

  openReview(state: ApplyViewState): boolean {
    const markdownView = this.deps.getActiveMarkdownView()
    if (!markdownView?.file) return false
    return this.openReviewInView(markdownView, state)
  }

  openReviewInView(markdownView: MarkdownView, state: ApplyViewState): boolean {
    if (!markdownView.file) return false
    if (markdownView.file.path !== state.file.path) return false
    const editorView = this.deps.getEditorView(markdownView.editor)
    if (!editorView) return false

    this.startReview(editorView, state)
    return true
  }

  closeReview(): void {
    if (!this.activeView) return

    this.activeOverlay?.destroy()
    this.activeOverlay = null
    this.activeActions = null

    if (this.extensionViews.has(this.activeView)) {
      this.activeView.dispatch({
        effects: this.diffReviewCompartment.reconfigure([]),
      })
    }
    this.activeView = null
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

  private startReview(view: EditorView, state: ApplyViewState): void {
    if (this.activeView) {
      this.closeReview()
    }

    this.ensureExtension(view)
    view.dispatch({
      effects: this.diffReviewCompartment.reconfigure(this.diffReviewExtension),
    })

    this.activeView = view

    const reviewState =
      state.reviewMode === 'selection-focus' &&
      !this.hasValidSelectionRange(view, state)
        ? {
            ...state,
            reviewMode: 'full' as const,
          }
        : state

    const modifiedBlockCount = createDiffBlocks(
      reviewState.originalContent,
      reviewState.newContent,
    ).reduce(
      (count, block) => (block.type === 'modified' ? count + 1 : count),
      0,
    )

    const shouldUseInlineSelectionReview =
      reviewState.reviewMode === 'selection-focus' &&
      modifiedBlockCount <= INLINE_DIFF_REVIEW_THRESHOLD

    this.activeOverlay = shouldUseInlineSelectionReview
      ? new InlineDiffReviewOverlay({
          plugin: this.deps.plugin,
          view,
          state: reviewState,
          onClose: () => this.closeReview(),
          onActionsReady: (actions) => {
            this.activeActions = actions
          },
        })
      : new ApplyReviewOverlay({
          plugin: this.deps.plugin,
          view,
          state: {
            ...reviewState,
            reviewMode: 'full',
          },
          onClose: () => this.closeReview(),
          onActionsReady: (actions) => {
            this.activeActions = actions
          },
        })
    this.activeOverlay.mount()
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
    if (this.extensionViews.has(view)) return
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
