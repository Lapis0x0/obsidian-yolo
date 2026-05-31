import type { EditorView } from '@codemirror/view'
import type { Editor } from 'obsidian'

import type { AsrStreamingSession } from '../../../../core/asr/types'
import type { YoloSettings } from '../../../../settings/schema/setting.types'

import { ContextVoiceInputWorkflow } from './contextVoiceInputWorkflow'
import type { RecordedAudio } from './voiceInputRecorder'

const makeController = (currentView: EditorView | null) => {
  const editor = {} as Editor
  const setInlineSuggestionGhost = jest.fn()
  const setActiveVoiceSuggestion = jest.fn()
  const setVoiceInputInProgress = jest.fn()
  const removeAbortController = jest.fn()

  const controller = new ContextVoiceInputWorkflow({
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
    onStatusChange: jest.fn(),
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
  controller: ContextVoiceInputWorkflow,
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
    mergeAbortTimers: [],
    streamingAsr: null,
    streamingAsrStartedAt: null,
  }
  ;(
    controller as unknown as {
      status: unknown
    }
  ).status = {
    state: 'ready',
    recordingStartedAt: 1,
    mediaStream: null,
    canCancel: true,
  }
}

const seedStreamingRecordingSession = (
  controller: ContextVoiceInputWorkflow,
  input: {
    editor: Editor
    view: EditorView
    streamingAsr: AsrStreamingSession
    recorder: { stop: () => Promise<RecordedAudio>; cancel: jest.Mock }
  },
) => {
  ;(
    controller as unknown as {
      session: unknown
      recorder: unknown
      status: unknown
    }
  ).session = {
    editor: input.editor,
    view: input.view,
    startCursorOffset: 0,
    selectionFromOffset: 0,
    selectionToOffset: 0,
    hasSelection: false,
    selectionText: '',
    filePath: 'note.md',
    fileTitle: 'note',
    abortController: new AbortController(),
    decision: null,
    ghostFromOffset: 0,
    recordingStartedAt: 1,
    asrTranscript: null,
    previousModelOutput: '',
    pendingSegments: [],
    polishWorkerRunning: false,
    inFlightPolish: null,
    mergeAbortTimers: [],
    streamingAsr: input.streamingAsr,
    streamingAsrStartedAt: 1,
  }
  ;(
    controller as unknown as {
      recorder: unknown
      status: unknown
    }
  ).recorder = input.recorder
  ;(
    controller as unknown as {
      status: unknown
    }
  ).status = {
    state: 'recording',
    recordingStartedAt: 1,
    mediaStream: null,
    canCancel: true,
  }
}

describe('ContextVoiceInputWorkflow.tryRejectFromView', () => {
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

describe('ContextVoiceInputWorkflow.handleEditorDocumentChange', () => {
  it('cancels a pending preview when the bound editor document changes', () => {
    const currentView = { id: 'current' } as unknown as EditorView
    const {
      controller,
      editor,
      setInlineSuggestionGhost,
      setActiveVoiceSuggestion,
      setVoiceInputInProgress,
      removeAbortController,
    } = makeController(currentView)
    seedReadySession(controller, { editor, cachedView: currentView })

    controller.handleEditorDocumentChange(currentView)

    expect(setInlineSuggestionGhost).toHaveBeenCalledWith(currentView, null)
    expect(setActiveVoiceSuggestion).toHaveBeenCalledWith(null)
    expect(setVoiceInputInProgress).toHaveBeenCalledWith(false)
    expect(removeAbortController).toHaveBeenCalledTimes(1)
    expect(controller.getStatus().state).toBe('idle')
  })

  it('ignores document changes from unrelated editor views', () => {
    const currentView = { id: 'current' } as unknown as EditorView
    const otherView = { id: 'other' } as unknown as EditorView
    const { controller, editor, setInlineSuggestionGhost } =
      makeController(currentView)
    seedReadySession(controller, { editor, cachedView: currentView })

    controller.handleEditorDocumentChange(otherView)

    expect(setInlineSuggestionGhost).not.toHaveBeenCalled()
    expect(controller.getStatus().state).toBe('ready')
  })
})

describe('ContextVoiceInputWorkflow streaming ASR stop', () => {
  it('flushes the recorder before finalizing a streaming ASR segment', async () => {
    const currentView = { id: 'current' } as unknown as EditorView
    const { controller, editor } = makeController(currentView)
    const order: string[] = []
    const streamingAsr: AsrStreamingSession = {
      sendAudioChunk: jest.fn(() => order.push('send-tail')),
      finish: jest.fn(() => {
        order.push('finish')
        return new Promise(() => {
          // Keep the polish worker parked; stopAndProcess does not await it.
        })
      }),
      cancel: jest.fn(),
    }
    const recorder = {
      stop: jest.fn(async () => {
        order.push('stop-start')
        streamingAsr.sendAudioChunk(new Blob(['tail']))
        order.push('stop-end')
        return {
          blob: new Blob(['unused']),
          mimeType: 'audio/webm',
          durationMs: 100,
        }
      }),
      cancel: jest.fn(),
    }
    seedStreamingRecordingSession(controller, {
      editor,
      view: currentView,
      streamingAsr,
      recorder,
    })
    ;(
      controller as unknown as {
        enqueueTranscriptSegment: jest.Mock
      }
    ).enqueueTranscriptSegment = jest.fn()

    await controller.stopAndProcess()

    expect(recorder.stop).toHaveBeenCalledTimes(1)
    expect(recorder.cancel).not.toHaveBeenCalled()
    expect(order).toEqual(['stop-start', 'send-tail', 'stop-end', 'finish'])
  })
})

describe('ContextVoiceInputWorkflow polish worker', () => {
  it('clears the previous preview when the model returns empty text', async () => {
    const currentView = { id: 'current' } as unknown as EditorView
    const {
      controller,
      editor,
      setInlineSuggestionGhost,
      setActiveVoiceSuggestion,
    } = makeController(currentView)
    seedReadySession(controller, { editor, cachedView: currentView })

    const session = (
      controller as unknown as {
        session: {
          pendingSegments: Array<{ transcribePromise: Promise<string> }>
        }
      }
    ).session
    session.pendingSegments.push({
      transcribePromise: Promise.resolve('这段会被模型判为空'),
    })
    ;(
      controller as unknown as {
        polishTranscript: jest.Mock
      }
    ).polishTranscript = jest.fn(async () => ({
      action: 'insert_at_cursor',
      text: '',
    }))

    await (
      controller as unknown as {
        runPolishWorker: (
          activeSession: unknown,
          settings: YoloSettings,
        ) => Promise<void>
      }
    ).runPolishWorker(session, {
      contextVoiceInputOptions: {},
    } as YoloSettings)

    expect(setInlineSuggestionGhost).toHaveBeenLastCalledWith(currentView, null)
    expect(setActiveVoiceSuggestion).toHaveBeenLastCalledWith(null)
    expect(controller.getStatus().state).toBe('idle')
  })

  it('clears an empty polish result without leaving continuous recording stuck in ASR state', async () => {
    const currentView = { id: 'current' } as unknown as EditorView
    const {
      controller,
      editor,
      setInlineSuggestionGhost,
      setActiveVoiceSuggestion,
    } = makeController(currentView)
    seedReadySession(controller, { editor, cachedView: currentView })

    const internals = controller as unknown as {
      session: {
        pendingSegments: Array<{ transcribePromise: Promise<string> }>
      }
      recorder: { getMediaStream: () => null }
      status: unknown
      polishTranscript: jest.Mock
      runPolishWorker: (
        activeSession: unknown,
        settings: YoloSettings,
      ) => Promise<void>
    }
    const session = internals.session
    internals.recorder = { getMediaStream: () => null }
    internals.status = {
      state: 'recording',
      overlayState: 'polishing',
      recordingStartedAt: 1,
      mediaStream: null,
      canCancel: true,
    }
    session.pendingSegments.push({
      transcribePromise: Promise.resolve('清空'),
    })
    internals.polishTranscript = jest.fn(async () => ({
      action: 'insert_at_cursor',
      text: '',
    }))

    await internals.runPolishWorker(session, {
      contextVoiceInputOptions: {},
    } as YoloSettings)

    expect(setInlineSuggestionGhost).toHaveBeenLastCalledWith(currentView, null)
    expect(setActiveVoiceSuggestion).toHaveBeenLastCalledWith(null)
    expect(controller.getStatus()).toMatchObject({
      state: 'recording',
      overlayState: 'ready',
    })
  })

  it('restarts if a segment is queued during worker shutdown', async () => {
    const currentView = { id: 'current' } as unknown as EditorView
    const { controller, editor } = makeController(currentView)
    seedReadySession(controller, { editor, cachedView: currentView })

    const session = (
      controller as unknown as {
        session: {
          pendingSegments: Array<{ transcribePromise: Promise<string> }>
          polishWorkerRunning: boolean
        }
      }
    ).session
    session.pendingSegments = []
    session.polishWorkerRunning = false

    const runPolishWorker = jest
      .fn()
      .mockImplementationOnce(async (activeSession: typeof session) => {
        activeSession.pendingSegments.push({
          transcribePromise: Promise.resolve('第二段'),
        })
      })
      .mockImplementationOnce(async (activeSession: typeof session) => {
        activeSession.pendingSegments.shift()
      })
    ;(
      controller as unknown as {
        runPolishWorker: typeof runPolishWorker
      }
    ).runPolishWorker = runPolishWorker
    ;(
      controller as unknown as {
        ensurePolishWorker: (
          activeSession: unknown,
          settings: YoloSettings,
        ) => void
      }
    ).ensurePolishWorker(session, {
      contextVoiceInputOptions: {},
    } as YoloSettings)

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(runPolishWorker).toHaveBeenCalledTimes(2)
    expect(session.pendingSegments).toHaveLength(0)
    expect(session.polishWorkerRunning).toBe(false)
  })
})
