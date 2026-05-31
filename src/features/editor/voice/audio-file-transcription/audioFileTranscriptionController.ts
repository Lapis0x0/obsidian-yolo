import type { ChangeDesc } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { Editor, MarkdownView, Notice } from 'obsidian'

import type { YoloSettings } from '../../../../settings/schema/setting.types'
import type { VoiceInputState } from '../voiceStatus'

import {
  type AudioFileSource,
  createBlobAudioFileSource,
} from './audioFileSource'
import {
  type AudioFileTranscriptionMessages,
  type AudioFileTranscriptionPlan,
  type AudioFileTranscriptionProgress,
  type OrderedAudioFileText,
  executeAudioFileTranscriptionPlan,
  inspectAndPlanAudioFileTranscription,
  trimDuplicateChunkBoundary,
} from './audioFileTranscriptionService'

export type AudioFilePlanSummary = {
  fileName: string
  mode: AudioFileTranscriptionPlan['mode']
  providerName: string
  chunkCount: number | null
  chunkDurationSec: number | null
  maxConcurrentChunks: number
  overlapMs: number
}

type AudioFileControllerState = Extract<
  VoiceInputState,
  | 'idle'
  | 'checking'
  | 'confirm-plan'
  | 'preparing'
  | 'uploading'
  | 'transcribing'
  | 'inserting'
>

type AudioFileStatusExtra = {
  message?: string
  progressLabel?: string
  audioFilePlan?: AudioFilePlanSummary
}

type AudioFileSession = {
  source: AudioFileSource
  editor: Editor | null
  view: EditorView | null
  filePath: string
  anchorOffset: number | null
  appendOffset: number | null
  abortController: AbortController
  plan: AudioFileTranscriptionPlan | null
  startedAt: number
  previousInsertedText: string
  hasInsertedText: boolean
  streamingRevisionStartOffset: number | null
  streamingRevisionEndOffset: number | null
  streamingRevisionPrefix: string
  streamingProgressMessage: string | null
  streamingProgressLabel: string
  streamingProgressHoldUntil: number
  fallbackPath: string | null
  fallbackNoticeShown: boolean
  applyingInsertion: boolean
}

type AudioFileTranscriptionControllerDeps = {
  getSettings: () => YoloSettings
  getStatusState: () => string
  updateStatus: (
    state: AudioFileControllerState,
    extra?: AudioFileStatusExtra,
  ) => void
  getEditorView: (editor: Editor) => EditorView | null
  getActiveMarkdownView: () => MarkdownView | null
  clearInlineSuggestion: () => void
  addAbortController: (controller: AbortController) => void
  removeAbortController: (controller: AbortController) => void
  cancelPendingTabCompletion: () => void
  setVoiceInputInProgress: (inProgress: boolean) => void
  createFallbackMarkdownFile: (
    desiredPath: string,
    content: string,
  ) => Promise<string>
  appendToMarkdownFile: (path: string, content: string) => Promise<void>
  localizeAsrRuntimeError: (message: string) => string
  t: (key: string, fallback: string) => string
}

const WAV_PCM_UPLOAD_NOTICE_MIN_DURATION_MS = 5 * 60 * 1000
const LARGE_AUDIO_UPLOAD_NOTICE_MIN_BYTES = 100 * 1024 * 1024
const STREAMING_PROGRESS_MESSAGE_MIN_VISIBLE_MS = 3000

export class AudioFileTranscriptionController {
  private session: AudioFileSession | null = null

  constructor(private readonly deps: AudioFileTranscriptionControllerDeps) {}

  async start(
    input: File | AudioFileSource,
    editor: Editor | null,
  ): Promise<void> {
    if (this.deps.getStatusState() !== 'idle') {
      new Notice(
        this.deps.t(
          'voiceInput.finishCurrentTaskNotice',
          'Finish the current voice task before transcribing a file.',
        ),
      )
      return
    }

    const settings = this.deps.getSettings()
    const options = settings.contextVoiceInputOptions
    if (!options?.enabled || !options.audioFileTranscriptionEnabled) {
      new Notice(
        this.deps.t(
          'voiceInput.audioFileDisabledNotice',
          'Audio file transcription is disabled in voice input settings.',
        ),
      )
      return
    }

    const view = editor ? this.deps.getEditorView(editor) : null
    const markdownView = this.deps.getActiveMarkdownView()
    const cursorOffset =
      editor && view ? editor.posToOffset(editor.getCursor()) : null
    const filePath = markdownView?.file?.path ?? ''
    const abortController = new AbortController()
    const source =
      input instanceof File ? createBlobAudioFileSource(input) : input
    this.deps.addAbortController(abortController)
    this.deps.cancelPendingTabCompletion()
    this.deps.clearInlineSuggestion()
    this.deps.setVoiceInputInProgress(true)

    const session: AudioFileSession = {
      source,
      editor,
      view,
      filePath,
      anchorOffset: cursorOffset,
      appendOffset: cursorOffset,
      abortController,
      plan: null,
      startedAt: Date.now(),
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
    this.session = session
    this.deps.updateStatus('checking', {
      message: this.deps.t('voiceInput.audioFileChecking', 'Checking…'),
    })

    try {
      const plan = await inspectAndPlanAudioFileTranscription({
        source,
        options,
        messages: this.getMessages(),
      })
      if (this.session !== session) return
      session.plan = plan
      this.deps.updateStatus('confirm-plan', {
        message: this.buildPlanMessage(plan),
        audioFilePlan: this.summarisePlan(plan),
      })
    } catch (error) {
      this.handleError(error)
    }
  }

  async confirm(): Promise<void> {
    const session = this.session
    const plan = session?.plan
    if (!session || !plan || this.deps.getStatusState() !== 'confirm-plan') {
      return
    }

    this.deps.updateStatus('preparing', {
      message: this.deps.t('voiceInput.audioFilePreparing', 'Preparing…'),
      audioFilePlan: this.summarisePlan(plan),
    })
    try {
      this.showUploadNotices(plan)
      await executeAudioFileTranscriptionPlan({
        plan,
        signal: session.abortController.signal,
        onProgress: (progress) => this.handleProgress(session, progress),
        onText: (result) => this.insertText(session, result),
        messages: this.getMessages(),
      })
      if (this.session !== session) return
      new Notice(
        this.deps.t(
          'voiceInput.audioFileFinished',
          'Audio file transcription finished.',
        ),
      )
      this.finish()
    } catch (error) {
      if (isAbortError(error) || session.abortController.signal.aborted) {
        if (this.session === session) {
          new Notice(
            this.deps.t(
              'voiceInput.audioFileCancelled',
              'Audio file transcription cancelled.',
            ),
          )
          this.finish()
        }
        return
      }
      this.handleError(error)
    }
  }

  handleEditorDocumentChange(view: EditorView, changes?: ChangeDesc): void {
    const session = this.session
    if (!session || session.view !== view || session.applyingInsertion) return
    if (!changes) return
    if (session.anchorOffset !== null) {
      session.anchorOffset = changes.mapPos(session.anchorOffset, 1)
    }
    if (session.appendOffset !== null) {
      session.appendOffset = changes.mapPos(session.appendOffset, 1)
    }
    if (session.streamingRevisionStartOffset !== null) {
      session.streamingRevisionStartOffset = changes.mapPos(
        session.streamingRevisionStartOffset,
        1,
      )
    }
    if (session.streamingRevisionEndOffset !== null) {
      session.streamingRevisionEndOffset = changes.mapPos(
        session.streamingRevisionEndOffset,
        1,
      )
    }
  }

  cancelActiveSession(reason: string): boolean {
    const session = this.session
    if (!session) return false
    try {
      session.abortController.abort()
    } catch {
      // Best-effort.
    }
    this.deps.removeAbortController(session.abortController)
    this.session = null
    if (reason !== 'shutdown') {
      new Notice(
        this.deps.t(
          'voiceInput.audioFileCancelled',
          'Audio file transcription cancelled.',
        ),
      )
    }
    this.deps.setVoiceInputInProgress(false)
    this.deps.updateStatus('idle')
    return true
  }

  private tFormat(
    key: string,
    fallback: string,
    values: Record<string, string | number>,
  ): string {
    let text = this.deps.t(key, fallback)
    Object.entries(values).forEach(([name, value]) => {
      text = text.replace(new RegExp(`{{${name}}}`, 'g'), String(value))
    })
    return text
  }

  private getMessages(): AudioFileTranscriptionMessages {
    return {
      noProvider: this.deps.t(
        'voiceInput.audioFileErrorNoProvider',
        'No ASR provider is configured. Add one under Models → Voice recognition.',
      ),
      longAudioNotImplemented: this.deps.t(
        'voiceInput.audioFileErrorLongAudioNotImplemented',
        'Long-audio provider adapters are not implemented yet.',
      ),
      unsupportedLocalFile: this.deps.t(
        'voiceInput.audioFileErrorUnsupportedLocalFile',
        'The selected ASR provider cannot transcribe local files.',
      ),
      unsupportedChunking: this.deps.t(
        'voiceInput.audioFileErrorUnsupportedChunking',
        'The selected ASR provider cannot split this audio file.',
      ),
      decodeRequiredForChunking: this.deps.t(
        'voiceInput.audioFileErrorDecodeRequiredForChunking',
        'This file is too large for one request and cannot be decoded locally for chunking.',
      ),
      localDecodeTooLarge: this.deps.t(
        'voiceInput.audioFileErrorLocalDecodeTooLarge',
        'This audio file is too large for local processing. Use a long-audio provider.',
      ),
      webSocketPcmLargeUnsupported: this.deps.t(
        'voiceInput.audioFileErrorWebSocketPcmLargeUnsupported',
        'Large files cannot be streamed as WAV/PCM. Use a long-audio provider.',
      ),
      webSocketMp4TailMoovUnsupported: this.deps.t(
        'voiceInput.audioFileErrorWebSocketMp4TailMoovUnsupported',
        'This m4a/mp4 file cannot be streamed directly. Use a long-audio provider, or choose PCM 16k in the WebSocket provider.',
      ),
      wavPcmDurationLimitExceeded: (seconds) =>
        this.tFormat(
          'voiceInput.audioFileErrorWavPcmDurationLimitExceeded',
          'WAV/PCM upload is limited to {{minutes}} minutes to avoid freezes and excessive upload traffic. Use a long-audio provider for longer files.',
          { minutes: formatDurationLimitMinutes(seconds) },
        ),
      missingChunkPlan: this.deps.t(
        'voiceInput.audioFileErrorMissingChunkPlan',
        'Missing chunk plan for audio file transcription.',
      ),
      chunkFailed: this.deps.t(
        'voiceInput.audioFileErrorChunkFailed',
        'Chunk failed.',
      ),
      streamingUnsupported: this.deps.t(
        'voiceInput.audioFileErrorStreamingUnsupported',
        'The selected ASR provider does not support streaming.',
      ),
      directChunkDurationHint: (seconds) =>
        this.tFormat(
          'voiceInput.audioFileDirectChunkDurationHint',
          'If this is a provider upload-size limit, choose a shorter Audio file chunk duration (currently {{seconds}}s) so the file is split before upload.',
          { seconds },
        ),
      chunkedChunkDurationHint: (seconds) =>
        this.tFormat(
          'voiceInput.audioFileChunkedChunkDurationHint',
          'If this is a provider upload-size limit, lower Audio file chunk duration (currently {{seconds}}s).',
          { seconds },
        ),
      providerGenericDurationHint: this.deps.t(
        'voiceInput.audioFileProviderGenericDurationHint',
        'Some providers need shorter WAV chunks.',
      ),
      providerMaxDurationHint: (seconds) =>
        this.tFormat(
          'voiceInput.audioFileProviderMaxDurationHint',
          'This provider may need WAV chunks at {{seconds}}s or less.',
          { seconds },
        ),
    }
  }

  private summarisePlan(
    plan: AudioFileTranscriptionPlan,
  ): AudioFilePlanSummary {
    return {
      fileName: plan.fileName,
      mode: plan.mode,
      providerName:
        plan.providerConfig.name ||
        plan.providerConfig.model ||
        plan.providerConfig.format,
      chunkCount: plan.schedule?.chunks.length ?? null,
      chunkDurationSec: plan.schedule
        ? Math.round(plan.schedule.effectiveChunkDurationMs / 1000)
        : null,
      maxConcurrentChunks: plan.maxConcurrentChunks,
      overlapMs: plan.chunkOverlapMs,
    }
  }

  private buildPlanMessage(plan: AudioFileTranscriptionPlan): string {
    // The floating island has very little horizontal room, especially in
    // English. Keep these plan prompts short; use Notice/settings docs for
    // longer explanations.
    if (plan.mode === 'websocket-stream') {
      return this.deps.t('voiceInput.audioFilePlanStream', 'Stream audio?')
    }
    if (plan.mode === 'long-audio-upload') {
      return this.deps.t(
        'voiceInput.audioFilePlanLongAudio',
        'Submit long audio?',
      )
    }
    if (plan.mode === 'chunked-upload') {
      const chunks = plan.schedule?.chunks.length ?? 0
      return this.tFormat(
        'voiceInput.audioFilePlanChunked',
        'Upload {{count}} audio chunks?',
        { count: chunks },
      )
    }
    return this.deps.t(
      'voiceInput.audioFilePlanDirect',
      'Upload this audio file for transcription?',
    )
  }

  private showUploadNotices(plan: AudioFileTranscriptionPlan): void {
    const showedWavPcmNotice = this.showWavPcmUploadNotice(plan)
    if (showedWavPcmNotice) return
    if (
      plan.wavPcmUploadEstimateBytes !== null ||
      plan.fileSizeBytes <= LARGE_AUDIO_UPLOAD_NOTICE_MIN_BYTES
    ) {
      return
    }
    new Notice(
      this.tFormat(
        'voiceInput.audioFileLargeUploadNotice',
        'This audio file is {{size}} and will be sent as-is. This may use a lot of upload traffic.',
        { size: formatBytes(plan.fileSizeBytes) },
      ),
    )
  }

  private showWavPcmUploadNotice(plan: AudioFileTranscriptionPlan): boolean {
    if (
      plan.wavPcmUploadEstimateBytes === null ||
      ((plan.durationMs === null ||
        plan.durationMs <= WAV_PCM_UPLOAD_NOTICE_MIN_DURATION_MS) &&
        plan.wavPcmUploadEstimateBytes <= LARGE_AUDIO_UPLOAD_NOTICE_MIN_BYTES)
    ) {
      return false
    }
    new Notice(
      this.tFormat(
        'voiceInput.audioFileWavPcmUploadNotice',
        'This audio will send WAV/PCM data, about {{size}}. This can use much more traffic than compressed audio.',
        { size: formatBytes(plan.wavPcmUploadEstimateBytes) },
      ),
    )
    return true
  }

  private handleProgress(
    session: AudioFileSession,
    progress: AudioFileTranscriptionProgress,
  ): void {
    if (this.session !== session || !session.plan) return
    const statusState: AudioFileControllerState =
      progress.phase === 'inserting'
        ? 'inserting'
        : progress.phase === 'preparing'
          ? 'preparing'
          : progress.phase === 'transcribing'
            ? 'transcribing'
            : 'uploading'
    const display = this.resolveProgressDisplay(session, progress)
    this.deps.updateStatus(statusState, {
      message: display.message,
      progressLabel: display.progressLabel,
      audioFilePlan: this.summarisePlan(session.plan),
    })
  }

  private resolveProgressDisplay(
    session: AudioFileSession,
    progress: AudioFileTranscriptionProgress,
  ): Pick<AudioFileStatusExtra, 'message' | 'progressLabel'> {
    const message = this.formatProgress(session, progress)
    const progressLabel = this.formatProgressLabel(progress)
    const now = Date.now()

    if (isStreamingTransferProgress(progress)) {
      session.streamingProgressMessage = message
      session.streamingProgressLabel = progressLabel
      session.streamingProgressHoldUntil =
        now + STREAMING_PROGRESS_MESSAGE_MIN_VISIBLE_MS
      return { message, progressLabel }
    }

    // WebSocket file streaming can receive provider partials while bytes are
    // still being sent. Keep the transfer progress readable instead of letting
    // each partial immediately flip the island back to a generic transcribing
    // label.
    if (
      progress.phase === 'transcribing' &&
      session.plan?.mode === 'websocket-stream' &&
      session.streamingProgressMessage &&
      now < session.streamingProgressHoldUntil
    ) {
      return {
        message: session.streamingProgressMessage,
        progressLabel: session.streamingProgressLabel,
      }
    }

    return { message, progressLabel }
  }

  private formatProgress(
    session: AudioFileSession,
    progress: AudioFileTranscriptionProgress,
  ): string {
    if (
      typeof progress.completedChunks === 'number' &&
      typeof progress.totalChunks === 'number'
    ) {
      if (progress.phase === 'inserting') {
        return this.tFormat(
          'voiceInput.audioFileProgressInsertingChunks',
          'Inserting {{done}}/{{total}}…',
          {
            done: progress.completedChunks,
            total: progress.totalChunks,
          },
        )
      }
      return this.tFormat(
        'voiceInput.audioFileProgressTranscribingChunks',
        'Transcribing {{done}}/{{total}}…',
        {
          done: progress.completedChunks,
          total: progress.totalChunks,
        },
      )
    }
    if (isStreamingTransferProgress(progress)) {
      const pct = Math.max(
        0,
        Math.min(
          100,
          Math.round((progress.sentBytes / progress.totalBytes) * 100),
        ),
      )
      if (session.plan?.mode === 'websocket-stream') {
        return this.tFormat(
          'voiceInput.audioFileProgressStreamingPercent',
          'Streaming {{percent}}%…',
          { percent: pct },
        )
      }
      return this.tFormat(
        'voiceInput.audioFileProgressUploadingPercent',
        'Uploading {{percent}}%…',
        { percent: pct },
      )
    }
    if (progress.phase === 'transcribing') {
      return this.deps.t('voiceInput.barTranscribing', 'Transcribing…')
    }
    if (progress.phase === 'inserting') {
      return this.deps.t('voiceInput.audioFileInserting', 'Inserting…')
    }
    if (progress.phase === 'preparing') {
      return this.deps.t('voiceInput.audioFilePreparing', 'Preparing…')
    }
    return this.deps.t('voiceInput.audioFileUploading', 'Uploading…')
  }

  private formatProgressLabel(
    progress: AudioFileTranscriptionProgress,
  ): string {
    if (
      typeof progress.completedChunks === 'number' &&
      typeof progress.totalChunks === 'number'
    ) {
      return `${progress.completedChunks}/${progress.totalChunks}`
    }
    if (isStreamingTransferProgress(progress)) {
      const pct = Math.max(
        0,
        Math.min(
          100,
          Math.round((progress.sentBytes / progress.totalBytes) * 100),
        ),
      )
      return `${pct}%`
    }
    return ''
  }

  private async insertText(
    session: AudioFileSession,
    result: OrderedAudioFileText,
  ): Promise<void> {
    if (this.session !== session || !session.plan) return
    const plan = session.plan
    const preserveStreamingSeparator =
      plan.mode === 'websocket-stream' && session.hasInsertedText
    // WebSocket final deltas already carry the boundary between accumulated
    // text and the new fragment. Preserve it so speaker changes keep blank
    // lines.
    let text = preserveStreamingSeparator
      ? result.text.trimEnd()
      : result.text.trim()
    if (!text.trim()) return
    if (result.replacePrevious) {
      await this.replaceRevisionText(
        session,
        result,
        text.trim(),
        !!result.isFinal,
      )
      return
    }
    if (plan.mode !== 'websocket-stream') {
      text = trimDuplicateChunkBoundary(session.previousInsertedText, text)
    }
    if (!text.trim()) return
    session.previousInsertedText =
      plan.mode === 'websocket-stream'
        ? `${session.previousInsertedText}${text}`.trim()
        : [session.previousInsertedText, text].filter(Boolean).join(' ').trim()
    const inlineText = this.formatInsertion(session, text, result)
    if (
      inlineText.trim() &&
      !session.fallbackPath &&
      this.tryInsertTextInline(session, inlineText)
    ) {
      session.hasInsertedText = true
      return
    }

    const fallbackText = this.formatInsertion(session, text, result)
    if (!fallbackText.trim()) return
    await this.appendTextToFallback(session, fallbackText)
    session.hasInsertedText = true
  }

  private async replaceRevisionText(
    session: AudioFileSession,
    result: OrderedAudioFileText,
    text: string,
    isFinal: boolean,
  ): Promise<void> {
    if (!text.trim()) return
    const existingStart = session.streamingRevisionStartOffset
    const existingEnd = session.streamingRevisionEndOffset
    if (existingStart !== null && existingEnd !== null) {
      const replacement = `${session.streamingRevisionPrefix}${text}`
      if (
        this.replaceTextInlineRange(
          session,
          replacement,
          existingStart,
          existingEnd,
        )
      ) {
        session.previousInsertedText = text
        session.hasInsertedText = true
        return
      }
      if (!isFinal) return
    }

    if (!session.hasInsertedText) {
      const inlineText = this.formatInsertion(session, text, result)
      const range = inlineText.trim()
        ? this.insertTextInline(session, inlineText)
        : null
      if (range) {
        session.streamingRevisionStartOffset = range.startOffset
        session.streamingRevisionEndOffset = range.endOffset
        session.streamingRevisionPrefix = inlineText.endsWith(text)
          ? inlineText.slice(0, inlineText.length - text.length)
          : ''
        session.previousInsertedText = text
        session.hasInsertedText = true
        return
      }
      if (!isFinal) return
    }

    if (!isFinal) return
    const fallbackText = this.formatInsertion(session, text, result)
    if (!fallbackText.trim()) return
    await this.appendTextToFallback(session, fallbackText)
    session.previousInsertedText = text
    session.hasInsertedText = true
  }

  private tryInsertTextInline(
    session: AudioFileSession,
    text: string,
  ): boolean {
    return !!this.insertTextInline(session, text)
  }

  private insertTextInline(
    session: AudioFileSession,
    text: string,
  ): { startOffset: number; endOffset: number } | null {
    if (!session.editor || session.appendOffset === null) return null
    const view = this.deps.getEditorView(session.editor)
    if (!view) return null
    session.view = view
    try {
      const startOffset = session.appendOffset
      const from = session.editor.offsetToPos(session.appendOffset)
      session.applyingInsertion = true
      session.editor.replaceRange(text, from, from)
      const end = computeEndCursor(from, text)
      session.editor.setCursor(end)
      session.appendOffset = session.editor.posToOffset(end)
      return { startOffset, endOffset: session.appendOffset }
    } catch (error) {
      console.warn('Audio file transcription inline insert failed:', error)
      return null
    } finally {
      session.applyingInsertion = false
    }
  }

  private replaceTextInlineRange(
    session: AudioFileSession,
    text: string,
    startOffset: number,
    endOffset: number,
  ): boolean {
    if (!session.editor) return false
    const view = this.deps.getEditorView(session.editor)
    if (!view) return false
    session.view = view
    try {
      const from = session.editor.offsetToPos(startOffset)
      const to = session.editor.offsetToPos(endOffset)
      session.applyingInsertion = true
      session.editor.replaceRange(text, from, to)
      const end = computeEndCursor(from, text)
      session.editor.setCursor(end)
      const nextEndOffset = session.editor.posToOffset(end)
      session.appendOffset = nextEndOffset
      session.streamingRevisionEndOffset = nextEndOffset
      return true
    } catch (error) {
      console.warn('Audio file transcription inline replace failed:', error)
      return false
    } finally {
      session.applyingInsertion = false
    }
  }

  private async appendTextToFallback(
    session: AudioFileSession,
    text: string,
  ): Promise<void> {
    if (!session.plan) return
    if (!session.fallbackPath) {
      const desiredPath = this.renderFallbackPath(session)
      // Once provider data has returned, the first fallback write must contain
      // the transcript itself. Creating an empty note and appending afterward
      // would add a second failure point that can lose long-audio results.
      session.fallbackPath = await this.deps.createFallbackMarkdownFile(
        desiredPath,
        text,
      )
      this.showFallbackNotice(session)
      return
    }
    await this.deps.appendToMarkdownFile(session.fallbackPath, text)
    this.showFallbackNotice(session)
  }

  private showFallbackNotice(session: AudioFileSession): void {
    const path = session.fallbackPath
    if (!path) return
    if (!session.fallbackNoticeShown) {
      new Notice(
        this.tFormat(
          'voiceInput.audioFileFallbackNotice',
          'Transcription is being written to {{path}}.',
          { path },
        ),
      )
      session.fallbackNoticeShown = true
    }
  }

  private formatInsertion(
    session: AudioFileSession,
    text: string,
    result: OrderedAudioFileText,
  ): string {
    const plan = session.plan
    if (!plan) return text
    const options = this.deps.getSettings().contextVoiceInputOptions
    const parts: string[] = []
    if (!session.hasInsertedText) {
      const mode = options.audioFileOutputMetadataMode
      const metadata = this.renderMetadata(plan, mode)
      if (metadata) parts.push(metadata)
    }
    if (
      plan.mode === 'chunked-upload' &&
      options.audioFileChunkHeaderMode === 'local-start-time' &&
      result.chunkStartMs !== null
    ) {
      parts.push(formatChunkStartTime(result.chunkStartMs))
    }
    parts.push(text)
    const prefix =
      session.hasInsertedText && plan.mode === 'websocket-stream'
        ? // If the streaming delta starts with whitespace, it already encoded
          // the right separator (space for same speaker, blank line for new
          // speaker).
          /^\s/.test(text)
          ? ''
          : ' '
        : session.hasInsertedText
          ? '\n\n'
          : ''
    return `${prefix}${parts.filter(Boolean).join('\n\n')}`
  }

  private renderMetadata(
    plan: AudioFileTranscriptionPlan,
    mode: 'none' | 'metadata' | 'metadata-timestamps',
  ): string {
    if (mode === 'none') return ''
    const title = `# ${stripFileExtension(plan.fileName)}`
    const provider =
      plan.providerConfig.name ||
      plan.providerConfig.model ||
      plan.providerConfig.format
    const submitted =
      plan.mode === 'chunked-upload'
        ? this.tFormat(
            'voiceInput.audioFileSubmissionChunks',
            '{{count}} chunks',
            { count: plan.schedule?.chunks.length ?? 0 },
          )
        : plan.mode === 'websocket-stream'
          ? this.deps.t(
              'voiceInput.audioFileSubmissionWebSocket',
              'WebSocket stream',
            )
          : plan.mode === 'long-audio-upload'
            ? this.deps.t(
                'voiceInput.audioFileSubmissionLongAudio',
                'long-audio provider',
              )
            : this.deps.t(
                'voiceInput.audioFileSubmissionDirect',
                'direct upload',
              )
    return [
      title,
      '',
      `- ${this.deps.t('voiceInput.audioFileMetadataSource', 'Source')}: ${plan.fileName}`,
      `- ${this.deps.t('voiceInput.audioFileMetadataTranscribed', 'Transcribed')}: ${new Date().toLocaleString()}`,
      `- ${this.deps.t('voiceInput.audioFileMetadataProvider', 'Provider')}: ${provider}`,
      `- ${this.deps.t('voiceInput.audioFileMetadataSubmission', 'Submission')}: ${submitted}`,
      '',
      '---',
    ].join('\n')
  }

  private renderFallbackPath(session: AudioFileSession): string {
    const plan = session.plan
    const now = new Date()
    const yyyy = String(now.getFullYear())
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const hh = String(now.getHours()).padStart(2, '0')
    const min = String(now.getMinutes()).padStart(2, '0')
    const ss = String(now.getSeconds()).padStart(2, '0')
    const baseName = stripFileExtension(plan?.fileName ?? session.source.name)
    const template =
      this.deps.getSettings().contextVoiceInputOptions
        .audioFileFallbackNotePathTemplate ||
      'Transcriptions/{{date}} {{time}} {{basename}}.md'
    return template
      .replace(/\{\{date\}\}/g, `${yyyy}-${mm}-${dd}`)
      .replace(/\{\{time\}\}/g, `${hh}-${min}-${ss}`)
      .replace(/\{\{basename\}\}/g, sanitizePathPart(baseName))
      .replace(/\{\{filename\}\}/g, sanitizePathPart(session.source.name))
  }

  private handleError(error: unknown): void {
    const message =
      error instanceof Error
        ? this.deps.localizeAsrRuntimeError(error.message)
        : typeof error === 'string'
          ? error
          : this.deps.t(
              'voiceInput.audioFileFailed',
              'Audio file transcription failed.',
            )
    console.error('Audio file transcription failed:', error)
    new Notice(
      this.tFormat(
        'voiceInput.audioFileFailedWithMessage',
        'Audio file transcription failed: {{message}}',
        { message },
      ),
    )
    this.finish()
  }

  private finish(): void {
    const session = this.session
    if (session) {
      try {
        session.abortController.abort()
      } catch {
        // Best-effort.
      }
      this.deps.removeAbortController(session.abortController)
    }
    this.session = null
    this.deps.setVoiceInputInProgress(false)
    this.deps.updateStatus('idle')
  }
}

const stripFileExtension = (fileName: string): string => {
  const idx = fileName.lastIndexOf('.')
  return idx > 0 ? fileName.slice(0, idx) : fileName
}

const sanitizePathPart = (value: string): string =>
  value.replace(/[\\/:*?"<>|]/g, '-').trim() || 'audio'

const formatDurationLimitMinutes = (seconds: number): string => {
  const minutes = seconds / 60
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)
}

const formatBytes = (bytes: number): string => {
  const mib = bytes / 1024 / 1024
  if (mib < 1024) return `${mib >= 10 ? Math.round(mib) : mib.toFixed(1)} MiB`
  const gib = mib / 1024
  return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1)} GiB`
}

const formatChunkStartTime = (ms: number): string => {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

const computeEndCursor = (
  from: { line: number; ch: number },
  insertionText: string,
): { line: number; ch: number } => {
  const parts = insertionText.split('\n')
  if (parts.length === 1) {
    return { line: from.line, ch: from.ch + parts[0].length }
  }
  return {
    line: from.line + parts.length - 1,
    ch: parts[parts.length - 1].length,
  }
}

const isAbortError = (error: unknown): boolean =>
  (error as { name?: string })?.name === 'AbortError'

type StreamingTransferProgress = AudioFileTranscriptionProgress & {
  sentBytes: number
  totalBytes: number
}

const isStreamingTransferProgress = (
  progress: AudioFileTranscriptionProgress,
): progress is StreamingTransferProgress =>
  typeof progress.sentBytes === 'number' &&
  typeof progress.totalBytes === 'number'
