import { Compartment, Prec, StateEffect } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { Editor } from 'obsidian'

import { escapeMarkdownSpecialChars } from '../../../utils/markdown-escape'
import type { TabCompletionController } from '../tab-completion/tabCompletionController'

import {
  InlineSuggestionGhostPayload,
  inlineSuggestionGhostEffect,
  inlineSuggestionGhostField,
  thinkingIndicatorEffect,
  thinkingIndicatorField,
} from './inlineSuggestion'

type ActiveInlineSuggestion = {
  source: 'tab' | 'continuation'
  editor: Editor
  view: EditorView
  fromOffset: number
  text: string
}

type ContinuationInlineSuggestion = {
  editor: Editor
  view: EditorView
  text: string
  fromOffset: number
  startPos: ReturnType<Editor['getCursor']>
}

type InlineSuggestionControllerDeps = {
  getEditorView: (editor: Editor) => EditorView | null
  getTabCompletionController: () => TabCompletionController
}

export class InlineSuggestionController {
  private readonly getEditorView: (editor: Editor) => EditorView | null
  private readonly getTabCompletionController: () => TabCompletionController

  private readonly inlineSuggestionExtensionViews = new Set<EditorView>()
  private readonly inlineSuggestionCompartment = new Compartment()
  private readonly inlineSuggestionExtension = [
    inlineSuggestionGhostField,
    thinkingIndicatorField,
    Prec.high(
      keymap.of([
        {
          key: 'Tab',
          run: (v) => this.tryAcceptInlineSuggestionFromView(v),
        },
        {
          key: 'Shift-Tab',
          run: (v) => this.tryRejectInlineSuggestionFromView(v),
        },
        {
          key: 'Escape',
          run: (v) => this.tryRejectInlineSuggestionFromView(v),
        },
      ]),
    ),
  ]

  private activeInlineSuggestion: ActiveInlineSuggestion | null = null
  private continuationInlineSuggestion: ContinuationInlineSuggestion | null =
    null

  constructor(deps: InlineSuggestionControllerDeps) {
    this.getEditorView = deps.getEditorView
    this.getTabCompletionController = deps.getTabCompletionController
  }

  ensureInlineSuggestionExtension(view: EditorView) {
    if (this.inlineSuggestionExtensionViews.has(view)) return
    view.dispatch({
      effects: StateEffect.appendConfig.of([
        this.inlineSuggestionCompartment.of(this.inlineSuggestionExtension),
      ]),
    })
    this.inlineSuggestionExtensionViews.add(view)
  }

  removeInlineSuggestionExtension(view: EditorView) {
    if (!this.inlineSuggestionExtensionViews.has(view)) return
    view.dispatch({
      effects: this.inlineSuggestionCompartment.reconfigure([]),
    })
    this.inlineSuggestionExtensionViews.delete(view)
  }

  destroy() {
    for (const view of this.inlineSuggestionExtensionViews) {
      this.removeInlineSuggestionExtension(view)
    }
    this.inlineSuggestionExtensionViews.clear()
    this.activeInlineSuggestion = null
    this.continuationInlineSuggestion = null
  }

  setInlineSuggestionGhost(
    view: EditorView,
    payload: InlineSuggestionGhostPayload,
  ) {
    this.ensureInlineSuggestionExtension(view)
    view.dispatch({ effects: inlineSuggestionGhostEffect.of(payload) })
  }

  showThinkingIndicator(
    view: EditorView,
    from: number,
    label: string,
    snippet?: string,
  ) {
    this.ensureInlineSuggestionExtension(view)
    view.dispatch({
      effects: thinkingIndicatorEffect.of({
        from,
        label,
        snippet,
      }),
    })
  }

  hideThinkingIndicator(view: EditorView) {
    view.dispatch({ effects: thinkingIndicatorEffect.of(null) })
  }

  setActiveInlineSuggestion(suggestion: ActiveInlineSuggestion | null) {
    this.activeInlineSuggestion = suggestion
  }

  setContinuationSuggestion(params: {
    editor: Editor
    view: EditorView
    text: string
    fromOffset: number
    startPos: ReturnType<Editor['getCursor']>
  }) {
    this.activeInlineSuggestion = {
      source: 'continuation',
      editor: params.editor,
      view: params.view,
      fromOffset: params.fromOffset,
      text: params.text,
    }
    this.continuationInlineSuggestion = {
      editor: params.editor,
      view: params.view,
      text: params.text,
      fromOffset: params.fromOffset,
      startPos: params.startPos,
    }
  }

  clearInlineSuggestion() {
    this.getTabCompletionController().clearSuggestion()
    if (this.continuationInlineSuggestion) {
      const { view } = this.continuationInlineSuggestion
      if (view) {
        this.setInlineSuggestionGhost(view, null)
      }
      this.continuationInlineSuggestion = null
    }
    this.activeInlineSuggestion = null
  }

  tryAcceptInlineSuggestionFromView(view: EditorView): boolean {
    const suggestion = this.activeInlineSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) return false

    if (suggestion.source === 'tab') {
      return this.getTabCompletionController().tryAcceptFromView(view)
    }

    if (suggestion.source === 'continuation') {
      return this.tryAcceptContinuationFromView(view)
    }

    return false
  }

  tryRejectInlineSuggestionFromView(view: EditorView): boolean {
    const suggestion = this.activeInlineSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) return false
    this.clearInlineSuggestion()
    return true
  }

  private tryAcceptContinuationFromView(view: EditorView): boolean {
    const suggestion = this.continuationInlineSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) {
      this.clearInlineSuggestion()
      return false
    }

    const active = this.activeInlineSuggestion
    if (!active || active.source !== 'continuation') return false

    const { editor, text, startPos } = suggestion
    if (!text || text.length === 0) {
      this.clearInlineSuggestion()
      return false
    }

    if (this.getEditorView(editor) !== view) {
      this.clearInlineSuggestion()
      return false
    }

    if (editor.getSelection()?.length) {
      this.clearInlineSuggestion()
      return false
    }

    const insertionText = escapeMarkdownSpecialChars(text, {
      escapeAngleBrackets: true,
      preserveCodeBlocks: true,
    })
    this.clearInlineSuggestion()
    editor.replaceRange(insertionText, startPos, startPos)

    const parts = insertionText.split('\n')
    const endCursor =
      parts.length === 1
        ? { line: startPos.line, ch: startPos.ch + parts[0].length }
        : {
            line: startPos.line + parts.length - 1,
            ch: parts[parts.length - 1].length,
          }
    editor.setCursor(endCursor)
    return true
  }
}
