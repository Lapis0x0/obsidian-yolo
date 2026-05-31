import { Editor, MarkdownView, Notice } from 'obsidian'

import { applyAudioOutputDevice } from '../../../../core/tts/audioOutput'
import {
  getTtsProvider,
  resolveActiveTtsConfig,
} from '../../../../core/tts/manager'
import type {
  TtsProvider,
  TtsSynthesisFileResult,
} from '../../../../core/tts/types'
import {
  DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR,
  type YoloSettings,
} from '../../../../settings/schema/setting.types'
import type { VoiceInputStatus, VoiceReadAloudStatus } from '../voiceStatus'

import {
  type GeneratedAudioDragSegment,
  applyGeneratedAudioDragData,
} from './generatedAudioDragSource'
import {
  type GeneratedAudioSaveSession,
  GeneratedAudioStore,
} from './generatedAudioStore'
import {
  normalizeReadAloudSelectionText,
  prepareReadAloudText,
  splitReadAloudText,
} from './readAloudText'

type ReadAloudStatusState = Extract<
  VoiceInputStatus['state'],
  | 'read-aloud-preparing'
  | 'read-aloud-confirm'
  | 'read-aloud-synthesizing'
  | 'read-aloud-playing'
  | 'read-aloud-paused'
  | 'read-aloud-failed'
  | 'read-aloud-completed'
>

type ReadAloudSourceMode = 'selection-or-document' | 'selection' | 'document'

type ReadAloudGeneratedSegment = {
  index: number
  audio: TtsSynthesisFileResult
  objectUrl: string
  waveformPeaks: number[] | null
  savedPath: string | null
}

type ReadAloudSession = {
  id: string
  sourceName: string
  sourcePath: string
  sourceMode: 'selection' | 'document'
  chunks: string[]
  provider: TtsProvider
  abortController: AbortController
  generatedSegments: Map<number, ReadAloudGeneratedSegment>
  synthesisPromises: Map<number, Promise<ReadAloudGeneratedSegment>>
  currentIndex: number
  audioElement: HTMLAudioElement | null
  saveSession: GeneratedAudioSaveSession | null
  autoSaveFailed: boolean
  stopped: boolean
}

type ReadAloudPendingStart = {
  sourceName: string
  sourcePath: string
  sourceMode: 'selection' | 'document'
  chunks: string[]
  provider: TtsProvider
}

type ReadAloudMessageSourceMode = 'selection' | 'document'

type ReadAloudControllerDeps = {
  app: import('obsidian').App
  getSettings: () => YoloSettings
  getStatusState: () => VoiceInputStatus['state']
  updateStatus: (
    state: ReadAloudStatusState | 'idle',
    extra?: Pick<VoiceInputStatus, 'message' | 'progressLabel' | 'readAloud'>,
  ) => void
  getActiveMarkdownView: () => MarkdownView | null
  clearInlineSuggestion: () => void
  addAbortController: (controller: AbortController) => void
  removeAbortController: (controller: AbortController) => void
  cancelPendingTabCompletion: () => void
  setVoiceInputInProgress: (inProgress: boolean) => void
  t: (key: string, fallback: string) => string
}

const COMPLETED_STATUS_HOLD_MS = 1200
const LONG_TEXT_CONFIRM_SEGMENTS = 2
const READ_ALOUD_WAVEFORM_SAMPLES = 80
const READ_ALOUD_WAVEFORM_MAX_DECODE_BYTES = 4 * 1024 * 1024
const READ_ALOUD_STATUS_STATES: ReadAloudStatusState[] = [
  'read-aloud-preparing',
  'read-aloud-confirm',
  'read-aloud-synthesizing',
  'read-aloud-playing',
  'read-aloud-paused',
  'read-aloud-failed',
  'read-aloud-completed',
]

export class ReadAloudController {
  private session: ReadAloudSession | null = null
  private pendingStart: ReadAloudPendingStart | null = null
  private readonly generatedAudioStore: GeneratedAudioStore
  private readonly cache = new Map<string, TtsSynthesisFileResult>()
  private lastGeneratedDragSegment: GeneratedAudioDragSegment | null = null
  private completionTimeout: number | null = null

  constructor(private readonly deps: ReadAloudControllerDeps) {
    this.generatedAudioStore = new GeneratedAudioStore(deps.app)
  }

  async start(sourceMode: ReadAloudSourceMode): Promise<void> {
    const currentState = this.deps.getStatusState()
    if (currentState !== 'idle') {
      if (currentState === 'read-aloud-paused') {
        await this.resume()
      }
      return
    }

    const settings = this.deps.getSettings()
    const options = settings.contextVoiceInputOptions
    if (!options.voiceReadAloudEnabled) {
      new Notice(
        this.deps.t(
          'voiceInput.readAloudDisabledNotice',
          'Read aloud is disabled in voice settings.',
        ),
      )
      return
    }

    const ttsConfig = resolveActiveTtsConfig(options)
    if (!ttsConfig) {
      new Notice(
        this.deps.t(
          'voiceInput.readAloudNoProvider',
          'No TTS provider is configured.',
        ),
      )
      return
    }

    const view = this.deps.getActiveMarkdownView()
    const editor = view?.editor ?? null
    const snapshot = this.captureTextSnapshot(editor, view, sourceMode)
    if (!snapshot.text.trim()) {
      new Notice(
        this.deps.t('voiceInput.readAloudNoText', 'No text to read aloud.'),
      )
      return
    }

    const provider = getTtsProvider(options)
    const chunks = splitReadAloudText(
      snapshot.text,
      options.readAloudChunkTargetChars,
      provider.capabilities?.maxInputChars,
    )
    if (chunks.length === 0) {
      new Notice(
        this.deps.t('voiceInput.readAloudNoText', 'No text to read aloud.'),
      )
      return
    }

    const pendingStart: ReadAloudPendingStart = {
      sourceName: snapshot.sourceName,
      sourcePath: snapshot.sourcePath,
      sourceMode: snapshot.sourceMode,
      chunks,
      provider,
    }

    this.clearCompletionTimeout()
    this.deps.cancelPendingTabCompletion()
    this.deps.clearInlineSuggestion()
    this.deps.setVoiceInputInProgress(true)

    if (chunks.length >= LONG_TEXT_CONFIRM_SEGMENTS) {
      this.pendingStart = pendingStart
      this.updateConfirmStatus(pendingStart)
      return
    }

    this.startPending(pendingStart)
  }

  async confirmLongText(): Promise<void> {
    const pending = this.pendingStart
    if (!pending) return
    this.pendingStart = null
    this.startPending(pending)
  }

  hasPendingLongTextConfirmation(): boolean {
    return !!this.pendingStart
  }

  async pause(): Promise<void> {
    const session = this.session
    if (!session?.audioElement) return
    this.updateStatus(session, 'read-aloud-paused')
    session.audioElement.pause()
  }

  async resume(): Promise<void> {
    const session = this.session
    if (!session?.audioElement) return
    await session.audioElement.play()
    this.updateStatus(session, 'read-aloud-playing')
  }

  stop(reason = 'user-cancel'): boolean {
    if (this.pendingStart) {
      this.pendingStart = null
      this.deps.setVoiceInputInProgress(false)
      if (reason !== 'shutdown') {
        new Notice(
          this.deps.t('voiceInput.readAloudCancelled', 'Read aloud stopped.'),
        )
      }
      this.deps.updateStatus('idle')
      return true
    }
    const session = this.session
    if (!session) return false
    this.finishSession(
      session,
      reason === 'completed'
        ? 'completed'
        : reason === 'shutdown'
          ? 'shutdown'
          : 'cancelled',
    )
    return true
  }

  prepareGeneratedAudioDrag(event: DragEvent): boolean {
    const segment = this.resolveDragSegment()
    if (!segment) return false
    return applyGeneratedAudioDragData(event, segment)
  }

  seekToRatio(ratio: number): void {
    const session = this.session
    const audio = session?.audioElement
    if (!session || !audio || !Number.isFinite(audio.duration)) return
    audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration
    this.updateStatus(
      session,
      audio.paused ? 'read-aloud-paused' : 'read-aloud-playing',
    )
  }

  hasGeneratedAudio(): boolean {
    return !!this.resolveDragSegment()
  }

  private captureTextSnapshot(
    editor: Editor | null,
    view: MarkdownView | null,
    requestedMode: ReadAloudSourceMode,
  ): {
    sourceMode: 'selection' | 'document'
    text: string
    sourcePath: string
    sourceName: string
  } {
    const selection = editor?.getSelection() ?? ''
    const hasSelection = selection.trim().length > 0
    const sourceMode =
      requestedMode === 'selection'
        ? 'selection'
        : requestedMode === 'document'
          ? 'document'
          : hasSelection
            ? 'selection'
            : 'document'
    if (sourceMode === 'selection') {
      return {
        sourceMode,
        text: normalizeReadAloudSelectionText(selection),
        sourcePath: view?.file?.path ?? '',
        sourceName: 'selection',
      }
    }

    const markdown =
      requestedMode === 'document' || !editor
        ? (editor?.getValue() ?? '')
        : this.getMarkdownFromCursor(editor)
    const mode =
      this.deps.getSettings().contextVoiceInputOptions.readAloudMarkdownMode
    return {
      sourceMode,
      text: prepareReadAloudText(markdown, mode),
      sourcePath: view?.file?.path ?? '',
      sourceName: view?.file?.basename || 'note',
    }
  }

  private async runSession(session: ReadAloudSession): Promise<void> {
    try {
      while (
        this.session === session &&
        !session.abortController.signal.aborted &&
        session.currentIndex < session.chunks.length
      ) {
        const preload = Math.max(
          0,
          this.deps.getSettings().contextVoiceInputOptions
            .readAloudPreloadSegments,
        )
        const segment = await this.ensureSegmentSynthesized(
          session,
          session.currentIndex,
        )
        for (let offset = 1; offset <= preload; offset++) {
          const index = session.currentIndex + offset
          if (index >= session.chunks.length) continue
          // Preload only after the current segment is ready, so we keep the
          // first request single-shot while still reducing gaps between
          // already-confirmed long-text segments.
          void this.ensureSegmentSynthesized(session, index).catch((error) => {
            if (
              this.session === session &&
              !session.abortController.signal.aborted
            ) {
              console.error('Read aloud preload failed:', error)
            }
          })
        }
        await this.ensureSegmentSavedForDrag(session, segment)
        await this.playSegment(session, segment)
        session.currentIndex += 1
      }
      if (this.session === session && !session.abortController.signal.aborted) {
        this.finishSession(session, 'completed')
      }
    } catch (error) {
      if (this.session !== session) return
      if (isAbortError(error) || session.abortController.signal.aborted) {
        this.finishSession(session, 'cancelled')
        return
      }
      console.error('Read aloud failed:', error)
      new Notice(
        this.format(
          'voiceInput.readAloudFailedWithMessage',
          'Read aloud failed: {{message}}',
          {
            message:
              error instanceof Error
                ? error.message
                : this.deps.t(
                    'voiceInput.readAloudFailed',
                    'Read aloud failed.',
                  ),
          },
        ),
      )
      this.updateStatus(session, 'read-aloud-failed')
      this.finishSession(session, 'failed')
    }
  }

  private getMarkdownFromCursor(editor: Editor): string {
    const from = editor.getCursor()
    const lastLine = editor.lastLine()
    return editor.getRange(from, {
      line: lastLine,
      ch: editor.getLine(lastLine).length,
    })
  }

  private ensureSegmentSynthesized(
    session: ReadAloudSession,
    index: number,
  ): Promise<ReadAloudGeneratedSegment> {
    const existing = session.generatedSegments.get(index)
    if (existing) return Promise.resolve(existing)
    const pending = session.synthesisPromises.get(index)
    if (pending) return pending

    const promise = this.synthesizeSegment(session, index)
    session.synthesisPromises.set(index, promise)
    return promise
  }

  private async synthesizeSegment(
    session: ReadAloudSession,
    index: number,
  ): Promise<ReadAloudGeneratedSegment> {
    if (this.session === session && index === session.currentIndex) {
      this.updateStatus(session, 'read-aloud-synthesizing')
    }
    const settings = this.deps.getSettings()
    const options = settings.contextVoiceInputOptions
    const config = resolveActiveTtsConfig(options)
    if (!config) {
      throw new Error('No TTS provider is configured.')
    }
    const text = session.chunks[index]
    const cacheKey = buildTtsCacheKey(config, text)
    const cached = options.readAloudCacheEnabled
      ? this.cache.get(cacheKey)
      : null
    const audio =
      cached ??
      (await session.provider.synthesize({
        text,
        voice: config.voice,
        model: config.model,
        format: config.outputFormat,
        sampleRate: config.sampleRate ?? undefined,
        speed: config.speed ?? undefined,
        pitch: config.pitch ?? undefined,
        volume: config.volume ?? undefined,
        language: config.language || undefined,
        styleInstruction: config.styleInstruction || undefined,
        signal: session.abortController.signal,
      }))
    if (options.readAloudCacheEnabled && !cached) {
      this.cache.set(cacheKey, audio)
    }

    const waveformPeaks = await buildAudioWaveformPeaks(audio)
    const objectUrl = URL.createObjectURL(
      new Blob([audio.bytes], { type: audio.mimeType }),
    )
    const segment: ReadAloudGeneratedSegment = {
      index,
      audio,
      objectUrl,
      waveformPeaks,
      savedPath: null,
    }
    session.generatedSegments.set(index, segment)
    await this.autoSaveSegment(session, segment)
    return segment
  }

  private startPending(pending: ReadAloudPendingStart): void {
    const settings = this.deps.getSettings()
    const options = settings.contextVoiceInputOptions
    const ttsConfig = resolveActiveTtsConfig(options)
    if (!ttsConfig) {
      this.deps.setVoiceInputInProgress(false)
      this.deps.updateStatus('idle')
      new Notice(
        this.deps.t(
          'voiceInput.readAloudNoProvider',
          'No TTS provider is configured.',
        ),
      )
      return
    }

    const abortController = new AbortController()
    const saveDir =
      options.readAloudGeneratedAudioSaveDir.trim() ||
      DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR
    const saveSession = saveDir
      ? this.generatedAudioStore.createSession({
          saveDir,
          sourceName: pending.sourceName,
          sourcePath: pending.sourcePath,
          totalSegments: pending.chunks.length,
          ttsConfig,
        })
      : null

    const session: ReadAloudSession = {
      id: `read-aloud-${Date.now().toString(36)}`,
      sourceName: pending.sourceName,
      sourcePath: pending.sourcePath,
      sourceMode: pending.sourceMode,
      chunks: pending.chunks,
      provider: pending.provider,
      abortController,
      generatedSegments: new Map(),
      synthesisPromises: new Map(),
      currentIndex: 0,
      audioElement: null,
      saveSession,
      autoSaveFailed: false,
      stopped: false,
    }
    this.session = session
    this.deps.addAbortController(abortController)
    this.updateStatus(session, 'read-aloud-preparing')
    void this.runSession(session)
  }

  private async autoSaveSegment(
    session: ReadAloudSession,
    segment: ReadAloudGeneratedSegment,
  ): Promise<void> {
    if (
      !session.saveSession ||
      session.autoSaveFailed ||
      !this.deps.getSettings().contextVoiceInputOptions
        .readAloudGeneratedAudioAutoSaveEnabled
    ) {
      return
    }
    await this.saveSegment(session, segment)
  }

  private async ensureSegmentSavedForDrag(
    session: ReadAloudSession,
    segment: ReadAloudGeneratedSegment,
  ): Promise<void> {
    if (
      !this.deps.getSettings().contextVoiceInputOptions
        .readAloudGeneratedAudioAutoSaveEnabled
    ) {
      return
    }
    if (segment.savedPath || !session.saveSession || session.autoSaveFailed) {
      return
    }
    await this.saveSegment(session, segment)
  }

  private async saveSegment(
    session: ReadAloudSession,
    segment: ReadAloudGeneratedSegment,
  ): Promise<void> {
    try {
      const saveSession = session.saveSession
      if (!saveSession) return
      segment.savedPath = await this.generatedAudioStore.saveSegment({
        session: saveSession,
        segmentIndex: segment.index,
        audio: segment.audio,
      })
      this.rememberDragSegment(session, segment)
      const currentState = this.deps.getStatusState()
      if (this.session === session && isReadAloudStatusState(currentState)) {
        this.updateStatus(session, currentState)
      }
    } catch (error) {
      session.autoSaveFailed = true
      console.error('Read aloud generated audio save failed:', error)
      new Notice(
        error instanceof Error
          ? error.message
          : this.deps.t(
              'voiceInput.readAloudAutoSaveFailed',
              'Failed to save generated audio.',
            ),
      )
    }
  }

  private playSegment(
    session: ReadAloudSession,
    segment: ReadAloudGeneratedSegment,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const audio = new Audio(segment.objectUrl)
      session.audioElement = audio
      let cleanup = (): void => {}
      const onEnded = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('Audio playback failed.'))
      }
      const onAbort = () => {
        cleanup()
        audio.pause()
        const error = new Error('Audio playback aborted.')
        error.name = 'AbortError'
        reject(error)
      }
      const onTimeUpdate = () => {
        if (this.session !== session) return
        this.updateStatus(
          session,
          audio.paused ? 'read-aloud-paused' : 'read-aloud-playing',
        )
      }
      const onPause = () => {
        if (this.session !== session) return
        this.updateStatus(session, 'read-aloud-paused')
      }
      const onPlay = () => {
        if (this.session !== session) return
        this.updateStatus(session, 'read-aloud-playing')
      }
      cleanup = () => {
        audio.removeEventListener('ended', onEnded)
        audio.removeEventListener('error', onError)
        audio.removeEventListener('timeupdate', onTimeUpdate)
        audio.removeEventListener('pause', onPause)
        audio.removeEventListener('play', onPlay)
        session.abortController.signal.removeEventListener('abort', onAbort)
      }

      audio.addEventListener('ended', onEnded)
      audio.addEventListener('error', onError)
      audio.addEventListener('timeupdate', onTimeUpdate)
      audio.addEventListener('pause', onPause)
      audio.addEventListener('play', onPlay)
      session.abortController.signal.addEventListener('abort', onAbort, {
        once: true,
      })
      this.updateStatus(session, 'read-aloud-playing')
      void (async () => {
        try {
          await applyAudioOutputDevice(
            audio,
            this.deps.getSettings().contextVoiceInputOptions
              .ttsOutputDeviceId ?? '',
          )
        } catch (error) {
          // A stale or unsupported output device should not make read aloud
          // unusable; fall back to the host default and keep playback going.
          console.warn('Failed to apply TTS output device:', error)
        }
        await audio.play()
      })().catch((error) => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private updateStatus(
    session: ReadAloudSession,
    state: ReadAloudStatusState,
  ): void {
    const status = this.buildReadAloudStatus(session)
    const message = this.buildMessage(state, status, session.sourceMode)
    this.deps.updateStatus(state, {
      message,
      progressLabel:
        status.totalSegments > 1
          ? `${status.currentSegment}/${status.totalSegments}`
          : '',
      readAloud: status,
    })
  }

  private buildMessage(
    state: ReadAloudStatusState,
    status: VoiceReadAloudStatus,
    sourceMode: ReadAloudMessageSourceMode,
  ): string {
    switch (state) {
      case 'read-aloud-preparing':
      case 'read-aloud-synthesizing':
        return this.deps.t(
          'voiceInput.readAloudPreparing',
          'Preparing speech...',
        )
      case 'read-aloud-confirm':
        return this.format(
          'voiceInput.readAloudConfirmLongText',
          'Long text will play in {{segments}} segments.',
          {
            segments: status.totalSegments,
          },
        )
      case 'read-aloud-playing':
        return status.totalSegments > 1
          ? this.format(
              'voiceInput.readAloudProgress',
              'Reading {{index}}/{{total}}',
              {
                current: status.currentSegment,
                index: status.currentSegment,
                total: status.totalSegments,
              },
            )
          : this.formatTimeProgress(status)
      case 'read-aloud-paused':
        return this.deps.t('voiceInput.readAloudPaused', 'Paused')
      case 'read-aloud-completed':
        return this.deps.t('voiceInput.readAloudCompleted', 'Read aloud done')
      case 'read-aloud-failed':
        return this.deps.t('voiceInput.readAloudFailed', 'Read aloud failed.')
      default:
        return sourceMode === 'selection'
          ? this.deps.t('voiceInput.readSelection', 'Read selection')
          : this.deps.t('voiceInput.readNote', 'Read note')
    }
  }

  private buildReadAloudStatus(
    session: ReadAloudSession,
  ): VoiceReadAloudStatus {
    const audio = session.audioElement
    const currentSegment = session.generatedSegments.get(session.currentIndex)
    const duration = Number.isFinite(audio?.duration)
      ? Math.max(0, audio?.duration ?? 0)
      : null
    return {
      currentSegment: Math.min(session.currentIndex + 1, session.chunks.length),
      totalSegments: session.chunks.length,
      elapsedSeconds: Math.max(0, audio?.currentTime ?? 0),
      durationSeconds: duration,
      progressRatio:
        duration && duration > 0
          ? Math.max(0, Math.min(1, (audio?.currentTime ?? 0) / duration))
          : null,
      waveformPeaks: currentSegment?.waveformPeaks ?? null,
      hasGeneratedAudio: !!this.resolveDragSegment(),
      sourceName: session.sourceName,
    }
  }

  private buildPendingStatus(
    pending: ReadAloudPendingStart,
  ): VoiceReadAloudStatus {
    return {
      currentSegment: 0,
      totalSegments: pending.chunks.length,
      elapsedSeconds: 0,
      durationSeconds: null,
      progressRatio: null,
      waveformPeaks: null,
      hasGeneratedAudio: false,
      sourceName: pending.sourceName,
    }
  }

  private updateConfirmStatus(pending: ReadAloudPendingStart): void {
    const status = this.buildPendingStatus(pending)
    this.deps.updateStatus('read-aloud-confirm', {
      message: this.buildMessage(
        'read-aloud-confirm',
        status,
        pending.sourceMode,
      ),
      progressLabel: `${pending.chunks.length}`,
      readAloud: status,
    })
  }

  private formatTimeProgress(status: VoiceReadAloudStatus): string {
    if (status.durationSeconds === null) {
      return this.deps.t('voiceInput.readAloudPlaying', 'Reading')
    }
    return `${formatSeconds(status.elapsedSeconds)}/${formatSeconds(
      status.durationSeconds,
    )}`
  }

  private finishSession(
    session: ReadAloudSession,
    outcome: 'completed' | 'cancelled' | 'failed' | 'shutdown',
  ): void {
    session.stopped = true
    try {
      session.abortController.abort()
    } catch {
      // Best-effort.
    }
    session.audioElement?.pause()
    session.audioElement = null
    for (const segment of session.generatedSegments.values()) {
      URL.revokeObjectURL(segment.objectUrl)
    }
    this.deps.removeAbortController(session.abortController)
    this.deps.setVoiceInputInProgress(false)
    if (this.session === session) this.session = null

    if (outcome === 'completed') {
      this.deps.updateStatus('read-aloud-completed', {
        message: this.deps.t(
          'voiceInput.readAloudCompleted',
          'Read aloud done',
        ),
        readAloud: this.buildReadAloudStatus(session),
      })
      this.completionTimeout = window.setTimeout(() => {
        this.completionTimeout = null
        if (!this.session) this.deps.updateStatus('idle')
      }, COMPLETED_STATUS_HOLD_MS)
      return
    }

    if (outcome === 'cancelled') {
      new Notice(
        this.deps.t('voiceInput.readAloudCancelled', 'Read aloud stopped.'),
      )
    }
    this.deps.updateStatus('idle')
  }

  private resolveDragSegment(): GeneratedAudioDragSegment | null {
    if (
      !this.deps.getSettings().contextVoiceInputOptions
        .readAloudGeneratedAudioAutoSaveEnabled
    ) {
      return null
    }
    const session = this.session
    if (session) {
      const current = session.generatedSegments.get(session.currentIndex)
      const latestSaved =
        (current?.savedPath ? current : null) ??
        Array.from(session.generatedSegments.values())
          .sort((a, b) => b.index - a.index)
          .find((segment) => !!segment.savedPath)
      return latestSaved ? this.toDragSegment(session, latestSaved) : null
    }
    return this.lastGeneratedDragSegment
  }

  private rememberDragSegment(
    session: ReadAloudSession,
    segment: ReadAloudGeneratedSegment,
  ): void {
    this.lastGeneratedDragSegment = this.toDragSegment(session, segment)
  }

  private toDragSegment(
    session: ReadAloudSession,
    segment: ReadAloudGeneratedSegment,
  ): GeneratedAudioDragSegment {
    return {
      segmentIndex: segment.index,
      audio: segment.audio,
      savedPath: segment.savedPath,
      sourceName: session.sourceName,
    }
  }

  private format(
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

  private clearCompletionTimeout(): void {
    if (this.completionTimeout === null) return
    window.clearTimeout(this.completionTimeout)
    this.completionTimeout = null
  }
}

const isAbortError = (error: unknown): boolean =>
  (error as { name?: string })?.name === 'AbortError'

const isReadAloudStatusState = (
  state: VoiceInputStatus['state'],
): state is ReadAloudStatusState =>
  READ_ALOUD_STATUS_STATES.includes(state as ReadAloudStatusState)

const buildTtsCacheKey = (
  config: NonNullable<ReturnType<typeof resolveActiveTtsConfig>>,
  text: string,
): string =>
  JSON.stringify({
    id: config.id,
    format: config.format,
    baseURL: config.baseURL,
    model: config.model,
    voice: config.voice,
    outputFormat: config.outputFormat,
    requestPath: config.requestPath,
    sampleRate: config.sampleRate,
    speed: config.speed,
    pitch: config.pitch,
    volume: config.volume,
    language: config.language,
    styleInstruction: config.styleInstruction,
    text,
  })

const buildAudioWaveformPeaks = async (
  audio: TtsSynthesisFileResult,
): Promise<number[] | null> => {
  if (audio.bytes.byteLength > READ_ALOUD_WAVEFORM_MAX_DECODE_BYTES) {
    return null
  }

  const AudioContextCtor: typeof AudioContext | undefined =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (
      globalThis as unknown as {
        webkitAudioContext?: typeof AudioContext
      }
    ).webkitAudioContext
  if (!AudioContextCtor) return null

  let context: AudioContext | null = null
  try {
    context = new AudioContextCtor()
    const decoded = await context.decodeAudioData(audio.bytes.slice(0))
    if (decoded.length <= 0 || decoded.numberOfChannels <= 0) return null

    const bucketSize = Math.max(
      1,
      Math.ceil(decoded.length / READ_ALOUD_WAVEFORM_SAMPLES),
    )
    const peaks: number[] = []
    let maxPeak = 0

    for (let i = 0; i < READ_ALOUD_WAVEFORM_SAMPLES; i++) {
      const start = i * bucketSize
      const end = Math.min(decoded.length, start + bucketSize)
      let peak = 0
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const data = decoded.getChannelData(channel)
        for (let offset = start; offset < end; offset++) {
          const value = Math.abs(data[offset] ?? 0)
          if (value > peak) peak = value
        }
      }
      peaks.push(peak)
      if (peak > maxPeak) maxPeak = peak
    }

    if (maxPeak <= 0) return null
    // The UI keeps only compact normalized peaks. Large audio skips decoding
    // above so a long MP3 does not linger as full PCM in plugin memory.
    return peaks.map((peak) => Math.max(0.04, Math.min(1, peak / maxPeak)))
  } catch {
    return null
  } finally {
    if (context) {
      void context.close().catch(() => {
        // Best-effort release; waveform generation is non-critical.
      })
    }
  }
}

const formatSeconds = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}
