import { Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { Editor } from 'obsidian'

import { escapeMarkdownSpecialChars } from '../../../utils/markdown-escape'
import type { TabCompletionController } from '../tab-completion/tabCompletionController'
import type { VoiceController } from '../voice/voiceController'

import {
  InlineSuggestionGhostPayload,
  inlineSuggestionGhostEffect,
  inlineSuggestionGhostField,
  tabLoadingDotsEffect,
  tabLoadingDotsField,
  thinkingIndicatorEffect,
  thinkingIndicatorField,
} from './inlineSuggestion'

type ActiveInlineSuggestion = {
  source: 'tab' | 'continuation' | 'voice'
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

type VoiceInlineSuggestion = {
  editor: Editor
  view: EditorView
  text: string
  fromOffset: number
}

type InlineSuggestionControllerDeps = {
  getEditorView: (editor: Editor) => EditorView | null
  getTabCompletionController: () => TabCompletionController
  getVoiceController: () => VoiceController | null
}

export class InlineSuggestionController {
  private readonly getEditorView: (editor: Editor) => EditorView | null
  private readonly getTabCompletionController: () => TabCompletionController
  private readonly getVoiceController: () => VoiceController | null

  private activeInlineSuggestion: ActiveInlineSuggestion | null = null
  private continuationInlineSuggestion: ContinuationInlineSuggestion | null =
    null
  private voiceInlineSuggestion: VoiceInlineSuggestion | null = null

  constructor(deps: InlineSuggestionControllerDeps) {
    this.getEditorView = deps.getEditorView
    this.getTabCompletionController = deps.getTabCompletionController
    this.getVoiceController = deps.getVoiceController
  }

  createExtension(): Extension {
    return [
      inlineSuggestionGhostField,
      thinkingIndicatorField,
      tabLoadingDotsField,
      EditorView.updateListener.of((update) => {
        if (update.focusChanged && !update.view.hasFocus) {
          // Voice input owns the ghost while a session is active — do
          // NOT clear it on focus loss. Clicking the mic / interacting
          // with the floating island legitimately steals focus from the
          // editor, but the ASR / polish preview must persist until the
          // user accepts (Tab) or rejects (Esc). This was the root cause
          // of the hold-to-talk "polish lands but no editor preview" bug:
          // focus changed → clearInlineSuggestion → voice ghost wiped.
          const voice = this.getVoiceController()
          if (voice?.isBusy()) {
            return
          }
          const tab = this.getTabCompletionController()
          tab.clearTimer()
          tab.cancelRequest()
          this.clearInlineSuggestion()
          return
        }
        if (update.selectionSet) {
          this.invalidateIfStale(update.view)
        }
      }),
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
          {
            key: 'Backspace',
            run: (v) => this.tryRejectInlineSuggestionFromView(v),
          },
        ]),
      ),
    ]
  }

  private invalidateIfStale(view: EditorView) {
    const active = this.activeInlineSuggestion
    if (!active || active.view !== view) return
    if (view.state.selection.main.head !== active.fromOffset) {
      this.clearInlineSuggestion()
    }
  }

  destroy() {
    this.activeInlineSuggestion = null
    this.continuationInlineSuggestion = null
    this.voiceInlineSuggestion = null
  }

  setInlineSuggestionGhost(
    view: EditorView,
    payload: InlineSuggestionGhostPayload,
  ) {
    view.dispatch({ effects: inlineSuggestionGhostEffect.of(payload) })
  }

  showThinkingIndicator(
    view: EditorView,
    from: number,
    label: string,
    snippet?: string,
  ) {
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

  showTabLoadingDots(view: EditorView, from: number) {
    view.dispatch({ effects: tabLoadingDotsEffect.of({ from }) })
  }

  hideTabLoadingDots(view: EditorView) {
    view.dispatch({ effects: tabLoadingDotsEffect.of(null) })
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

  setVoiceSuggestion(
    params: {
      editor: Editor
      view: EditorView
      fromOffset: number
      text: string
    } | null,
  ) {
    if (!params) {
      if (this.voiceInlineSuggestion?.view) {
        this.setInlineSuggestionGhost(this.voiceInlineSuggestion.view, null)
      }
      this.voiceInlineSuggestion = null
      if (this.activeInlineSuggestion?.source === 'voice') {
        this.activeInlineSuggestion = null
      }
      return
    }
    this.voiceInlineSuggestion = params
    this.activeInlineSuggestion = {
      source: 'voice',
      editor: params.editor,
      view: params.view,
      fromOffset: params.fromOffset,
      text: params.text,
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
    if (this.voiceInlineSuggestion) {
      const { view } = this.voiceInlineSuggestion
      if (view) {
        this.setInlineSuggestionGhost(view, null)
      }
      this.voiceInlineSuggestion = null
    }
    const voice = this.getVoiceController()
    if (voice && voice.hasPendingPreview()) {
      voice.cancelActiveSession('cleared')
    }
    this.activeInlineSuggestion = null
  }

  tryAcceptInlineSuggestionFromView(view: EditorView): boolean {
    const suggestion = this.activeInlineSuggestion
    if (!suggestion) {
      // Voice ASR can display a raw ghost before the polished suggestion is
      // promoted into activeInlineSuggestion. Give the voice workflow first
      // chance to swallow Tab so the editor does not indent and clear it.
      return this.getVoiceController()?.tryAcceptFromView(view) ?? false
    }

    if (suggestion.source === 'tab') {
      if (suggestion.view !== view) return false
      return this.getTabCompletionController().tryAcceptFromView(view)
    }

    if (suggestion.source === 'continuation') {
      if (suggestion.view !== view) return false
      return this.tryAcceptContinuationFromView(view)
    }

    if (suggestion.source === 'voice') {
      const voice = this.getVoiceController()
      if (!voice) return false
      const accepted = voice.tryAcceptFromView(view)
      if (accepted) {
        this.voiceInlineSuggestion = null
        this.activeInlineSuggestion = null
      }
      return accepted
    }

    return false
  }

  tryRejectInlineSuggestionFromView(view: EditorView): boolean {
    const suggestion = this.activeInlineSuggestion
    if (!suggestion) return false
    if (suggestion.source === 'voice') {
      const voice = this.getVoiceController()
      if (!voice) return false
      const rejected = voice.tryRejectFromView(view)
      if (rejected) {
        this.voiceInlineSuggestion = null
        this.activeInlineSuggestion = null
      }
      return rejected
    }
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
