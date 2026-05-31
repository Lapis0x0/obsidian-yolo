import { AudioFileTranscriptionController } from './audioFileTranscriptionController'

const createController = () => {
  const updateStatus = jest.fn()
  const controller = new AudioFileTranscriptionController({
    getSettings: jest.fn(),
    getStatusState: jest.fn(() => 'idle'),
    updateStatus,
    getEditorView: jest.fn(),
    getActiveMarkdownView: jest.fn(),
    clearInlineSuggestion: jest.fn(),
    addAbortController: jest.fn(),
    removeAbortController: jest.fn(),
    cancelPendingTabCompletion: jest.fn(),
    setVoiceInputInProgress: jest.fn(),
    createFallbackMarkdownFile: jest.fn(),
    appendToMarkdownFile: jest.fn(),
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
  return { controller: controller as any, session, updateStatus }
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
})
