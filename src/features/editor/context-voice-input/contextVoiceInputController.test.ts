import type { EditorView } from '@codemirror/view'
import type { Editor } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'

import { ContextVoiceInputController } from './contextVoiceInputController'

const makeController = (currentView: EditorView | null) => {
  const editor = {} as Editor
  const setInlineSuggestionGhost = jest.fn()
  const setActiveVoiceSuggestion = jest.fn()
  const setVoiceInputInProgress = jest.fn()
  const removeAbortController = jest.fn()

  const controller = new ContextVoiceInputController({
    getSettings: () =>
      ({
        contextVoiceInputOptions: {},
      }) as YoloSettings,
    setSettings: jest.fn(),
    getEditorView: (incomingEditor) =>
      incomingEditor === editor ? currentView : null,
    getActiveMarkdownView: () => null,
    setInlineSuggestionGhost,
    setActiveVoiceSuggestion,
    clearInlineSuggestion: jest.fn(),
    addAbortController: jest.fn(),
    removeAbortController,
    cancelPendingTabCompletion: jest.fn(),
    setVoiceInputInProgress,
    t: (_key, fallback) => fallback,
  })

  return {
    controller,
    editor,
    setInlineSuggestionGhost,
    setActiveVoiceSuggestion,
    setVoiceInputInProgress,
    removeAbortController,
  }
}

const seedReadySession = (
  controller: ContextVoiceInputController,
  input: { editor: Editor; cachedView: EditorView },
) => {
  ;(
    controller as unknown as {
      session: unknown
    }
  ).session = {
    editor: input.editor,
    view: input.cachedView,
    startCursorOffset: 0,
    selectionFromOffset: 0,
    selectionToOffset: 0,
    hasSelection: false,
    selectionText: '',
    filePath: 'note.md',
    fileTitle: 'note',
    abortController: new AbortController(),
    decision: { action: 'insert_at_cursor', text: 'preview' },
    ghostFromOffset: 0,
    recordingStartedAt: 1,
    asrTranscript: null,
    previousModelOutput: 'preview',
    pendingSegments: [],
    polishWorkerRunning: false,
    inFlightPolish: null,
    streamingAsr: null,
    streamingAsrStartedAt: null,
  }
}

describe('ContextVoiceInputController.tryRejectFromView', () => {
  it('rejects the preview through the editor current view even if cached view drifted', () => {
    const staleView = { id: 'old' } as unknown as EditorView
    const currentView = { id: 'current' } as unknown as EditorView
    const {
      controller,
      editor,
      setInlineSuggestionGhost,
      setActiveVoiceSuggestion,
      setVoiceInputInProgress,
      removeAbortController,
    } = makeController(currentView)
    seedReadySession(controller, { editor, cachedView: staleView })

    expect(controller.tryRejectFromView(currentView)).toBe(true)
    expect(setInlineSuggestionGhost).toHaveBeenCalledWith(currentView, null)
    expect(setActiveVoiceSuggestion).toHaveBeenCalledWith(null)
    expect(setVoiceInputInProgress).toHaveBeenCalledWith(false)
    expect(removeAbortController).toHaveBeenCalledTimes(1)
    expect(controller.getStatus().state).toBe('idle')
  })

  it('does not reject from an unrelated view', () => {
    const currentView = { id: 'current' } as unknown as EditorView
    const otherView = { id: 'other' } as unknown as EditorView
    const { controller, editor, setInlineSuggestionGhost } =
      makeController(currentView)
    seedReadySession(controller, { editor, cachedView: currentView })

    expect(controller.tryRejectFromView(otherView)).toBe(false)
    expect(setInlineSuggestionGhost).not.toHaveBeenCalled()
  })
})
