jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  Platform: { isDesktop: true, isMobile: false },
}))

jest.mock('./audioFileTranscriptionService', () => {
  const actual = jest.requireActual('./audioFileTranscriptionService')
  return {
    ...actual,
    executeAudioFileTranscriptionPlan: jest.fn(),
  }
})

import { Notice } from 'obsidian'

import { AudioFileTranscriptionController } from './audioFileTranscriptionController'
import { executeAudioFileTranscriptionPlan } from './audioFileTranscriptionService'

const createController = () => {
  const updateStatus = jest.fn()
  const createFallbackMarkdownFile = jest.fn(async (path: string) => path)
  const appendToMarkdownFile = jest.fn()
  const controller = new AudioFileTranscriptionController({
    getSettings: jest.fn(
      () =>
        ({
          contextVoiceInputOptions: {
            audioFileOutputMetadataMode: 'none',
            audioFileChunkHeaderMode: 'none',
            audioFileFallbackNotePathTemplate:
              'Transcriptions/{{date}} {{time}} {{basename}}.md',
          },
        }) as any,
    ),
    getStatusState: jest.fn(() => 'idle'),
    updateStatus,
    getEditorView: jest.fn(),
    getActiveMarkdownView: jest.fn(),
    clearInlineSuggestion: jest.fn(),
    addAbortController: jest.fn(),
    removeAbortController: jest.fn(),
    cancelPendingTabCompletion: jest.fn(),
    setVoiceInputInProgress: jest.fn(),
    createFallbackMarkdownFile,
    appendToMarkdownFile,
    localizeAsrRuntimeError: jest.fn((message: string) => message),
    t: jest.fn((_key: string, fallback: string) => fallback),
  })
  const session = {
    plan: {
      fileName: 'meeting.wav',
      mode: 'websocket-stream',
      providerConfig: {
        name: 'Local WebSocket',
        model: 'streaming-asr',
        format: 'deepgram-compatible-websocket',
      },
      schedule: null,
      maxConcurrentChunks: 1,
      chunkOverlapMs: 0,
    },
    streamingProgressMessage: null,
    streamingProgressLabel: '',
    streamingProgressHoldUntil: 0,
  }
  ;(controller as any).session = session
  return {
    controller: controller as any,
    session,
    updateStatus,
    createFallbackMarkdownFile,
    appendToMarkdownFile,
  }
}

describe('AudioFileTranscriptionController progress display', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('keeps streaming transfer progress visible while transcribing partials arrive', () => {
    const now = jest.spyOn(Date, 'now')
    const { controller, session, updateStatus } = createController()

    now.mockReturnValue(1_000)
    controller.handleProgress(session, {
      phase: 'uploading',
      sentBytes: 25,
      totalBytes: 100,
    })
    expect(updateStatus).toHaveBeenLastCalledWith(
      'uploading',
      expect.objectContaining({
        message: 'Streaming 25%…',
        progressLabel: '25%',
      }),
    )

    now.mockReturnValue(3_999)
    controller.handleProgress(session, {
      phase: 'transcribing',
      finalTextChars: 12,
    })
    expect(updateStatus).toHaveBeenLastCalledWith(
      'transcribing',
      expect.objectContaining({
        message: 'Streaming 25%…',
        progressLabel: '25%',
      }),
    )

    now.mockReturnValue(4_001)
    controller.handleProgress(session, {
      phase: 'transcribing',
      finalTextChars: 24,
    })
    expect(updateStatus).toHaveBeenLastCalledWith(
      'transcribing',
      expect.objectContaining({
        message: 'Transcribing…',
        progressLabel: '',
      }),
    )
  })

  it('does not let the streaming transfer hold mask inserting progress', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const { controller, session, updateStatus } = createController()

    controller.handleProgress(session, {
      phase: 'uploading',
      sentBytes: 100,
      totalBytes: 200,
    })
    controller.handleProgress(session, {
      phase: 'inserting',
      completedChunks: 1,
      totalChunks: 1,
    })

    expect(updateStatus).toHaveBeenLastCalledWith(
      'inserting',
      expect.objectContaining({
        message: 'Inserting 1/1…',
        progressLabel: '1/1',
      }),
    )
  })

  it('shows native long-audio upload progress without synthetic chunk labels', () => {
    const { controller, session, updateStatus } = createController()
    session.plan.mode = 'long-audio-upload'

    controller.handleProgress(session, {
      phase: 'uploading',
      sentBytes: 35,
      totalBytes: 100,
    })
    expect(updateStatus).toHaveBeenLastCalledWith(
      'uploading',
      expect.objectContaining({
        message: 'Uploading 35%…',
        progressLabel: '35%',
      }),
    )

    controller.handleProgress(session, { phase: 'uploading' })
    expect(updateStatus).toHaveBeenLastCalledWith(
      'uploading',
      expect.objectContaining({
        message: 'Uploading…',
        progressLabel: '',
      }),
    )

    controller.handleProgress(session, { phase: 'transcribing' })
    expect(updateStatus).toHaveBeenLastCalledWith(
      'transcribing',
      expect.objectContaining({
        message: 'Transcribing…',
        progressLabel: '',
      }),
    )

    controller.handleProgress(session, { phase: 'inserting' })
    expect(updateStatus).toHaveBeenLastCalledWith(
      'inserting',
      expect.objectContaining({
        message: 'Inserting…',
        progressLabel: '',
      }),
    )
  })
})

describe('AudioFileTranscriptionController fallback insertion', () => {
  it('creates a fallback note with the transcript when inline insertion is unavailable', async () => {
    const { controller, createFallbackMarkdownFile, appendToMarkdownFile } =
      createController()
    const session = {
      source: { name: 'cloud meeting.wav' },
      editor: null,
      appendOffset: null,
      plan: {
        fileName: 'cloud meeting.wav',
        mode: 'long-audio-upload',
        providerConfig: {
          name: 'FunASR local',
          model: 'paraformer',
          format: 'funasr-local',
        },
        schedule: null,
      },
      previousInsertedText: '',
      hasInsertedText: false,
      fallbackPath: null,
      fallbackNoticeShown: false,
    }
    controller.session = session

    await controller.insertText(session, {
      text: 'Speaker 1: 云端结果已经返回。',
      chunkIndex: null,
      chunkStartMs: null,
    })

    expect(createFallbackMarkdownFile).toHaveBeenCalledWith(
      expect.stringContaining('cloud meeting.md'),
      expect.stringContaining('Speaker 1: 云端结果已经返回。'),
    )
    expect(appendToMarkdownFile).not.toHaveBeenCalled()
  })

  it('falls back to a note when the editor throws during inline insertion', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { controller, createFallbackMarkdownFile } = createController()
    const editor = {
      offsetToPos: jest.fn(() => ({ line: 0, ch: 0 })),
      replaceRange: jest.fn(() => {
        throw new Error('closed editor')
      }),
      setCursor: jest.fn(),
      posToOffset: jest.fn(() => 0),
    }
    const session = {
      source: { name: 'meeting.wav' },
      editor,
      appendOffset: 0,
      plan: {
        fileName: 'meeting.wav',
        mode: 'long-audio-upload',
        providerConfig: {
          name: 'FunASR local',
          model: 'paraformer',
          format: 'funasr-local',
        },
        schedule: null,
      },
      previousInsertedText: '',
      hasInsertedText: false,
      fallbackPath: null,
      fallbackNoticeShown: false,
      applyingInsertion: false,
    }
    controller.session = session
    controller.deps.getEditorView.mockReturnValue({})

    await controller.insertText(session, {
      text: '转写结果',
      chunkIndex: null,
      chunkStartMs: null,
    })

    expect(createFallbackMarkdownFile).toHaveBeenCalledWith(
      expect.stringContaining('meeting.md'),
      expect.stringContaining('转写结果'),
    )
  })
})

describe('AudioFileTranscriptionController long-audio empty result', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('shows a notice when long-audio finishes without inserted text', async () => {
    const { controller } = createController()
    const session = {
      source: { name: 'meeting.wav' },
      editor: null,
      view: null,
      filePath: '',
      anchorOffset: null,
      appendOffset: null,
      abortController: new AbortController(),
      plan: {
        fileName: 'meeting.wav',
        mode: 'long-audio-upload',
        providerConfig: {
          name: 'Deepgram',
          model: 'nova-3',
          format: 'deepgram-prerecorded',
        },
        schedule: null,
        maxConcurrentChunks: 1,
        chunkOverlapMs: 0,
        fileSizeBytes: 1024,
        wavPcmUploadEstimateBytes: null,
      },
      startedAt: 0,
      previousInsertedText: '',
      hasInsertedText: false,
      streamingRevisionStartOffset: null,
      streamingRevisionEndOffset: null,
      streamingRevisionPrefix: '',
      streamingProgressMessage: null,
      streamingProgressLabel: '',
      streamingProgressHoldUntil: 0,
      fallbackPath: null,
      fallbackNoticeShown: false,
      applyingInsertion: false,
    }
    controller.session = session
    controller.deps.getStatusState.mockReturnValue('confirm-plan')
    jest.mocked(executeAudioFileTranscriptionPlan).mockImplementation(
      async ({ onText }) => {
        await onText({
          text: '   ',
          chunkIndex: null,
          chunkStartMs: null,
        })
      },
    )

    await controller.confirm()

    expect(Notice).toHaveBeenCalledWith(
      'Long-audio transcription finished, but the provider returned no text to insert.',
    )
    expect(Notice).not.toHaveBeenCalledWith(
      'Audio file transcription finished.',
    )
  })
})
