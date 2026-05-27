import { EditorView } from '@codemirror/view'
import { Editor, MarkdownView, Notice } from 'obsidian'

import { executeSingleTurn } from '../../../core/ai/single-turn'
import {
  AsrConfigError,
  getAsrProvider,
  resolveActiveAsrConfig,
} from '../../../core/asr/manager'
import { getChatModelClient } from '../../../core/llm/manager'
import { promoteProviderTransportModeToObsidian } from '../../../core/llm/transportModePromotion'
import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { LLMRequestBase } from '../../../types/llm/request'
import { escapeMarkdownSpecialChars } from '../../../utils/markdown-escape'
import type { InlineSuggestionGhostPayload } from '../inline-suggestion/inlineSuggestion'

import type { DocumentSummaryManager } from './documentSummaryManager'
import {
  type VoiceEditorDecision,
  parseVoiceEditorDecision,
} from './voiceDecisionParser'
import type { VoicePrefixCacheManager } from './voicePrefixCacheManager'
import {
  type RecordedAudio,
  VoiceInputRecorder,
  VoiceInputRecorderError,
} from './voiceInputRecorder'
import {
  type VoiceInputTarget,
  buildVoiceInputMessages,
} from './voicePromptBuilder'

export type VoiceInputState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'polishing'
  | 'ready'

export type VoiceInputStatus = {
  state: VoiceInputState
  error?: string
  overlayState?: Exclude<VoiceInputState, 'idle' | 'recording'>
  recordingStartedAt: number | null
  mediaStream: MediaStream | null
  canCancel: boolean
  asrDurationMs?: number
  polishDurationMs?: number
}

export type VoiceInputStateListener = (status: VoiceInputStatus) => void

/**
 * One unit of work queued for the polish worker. The raw transcript starts
 * out as a promise (ASR is in flight) and gets filled in once it resolves.
 */
type SegmentRecord = {
  transcribePromise: Promise<string | null>
}

type InFlightPolish = {
  controller: AbortController
  promise: Promise<VoiceEditorDecision>
  rawTranscript: string
  baselinePreviousOutput: string
  startedAt: number
}

type ActiveSession = {
  editor: Editor
  view: EditorView
  startCursorOffset: number
  selectionFromOffset: number
  selectionToOffset: number
  hasSelection: boolean
  selectionText: string
  filePath: string
  fileTitle: string
  abortController: AbortController
  decision: VoiceEditorDecision | null
  ghostFromOffset: number | null
  recordingStartedAt: number
  asrTranscript: string | null
  /** Polished text the user has not Tab-accepted yet. Becomes the next
   *  polish call's `previous_model_output`. */
  previousModelOutput: string
  /** Segments queued for the polish worker (in arrival order). */
  pendingSegments: SegmentRecord[]
  /** True while runPolishWorker is draining `pendingSegments`. */
  polishWorkerRunning: boolean
  /** Most recent polish call still running, if any. */
  inFlightPolish: InFlightPolish | null
  asrDurationMs?: number
  polishDurationMs?: number
}

type VoiceInputControllerDeps = {
  getSettings: () => YoloSettings
  setSettings: (next: YoloSettings) => Promise<void>
  getEditorView: (editor: Editor) => EditorView | null
  getActiveMarkdownView: () => MarkdownView | null
  setInlineSuggestionGhost: (
    view: EditorView,
    payload: InlineSuggestionGhostPayload,
  ) => void
  setActiveVoiceSuggestion: (
    suggestion: {
      editor: Editor
      view: EditorView
      fromOffset: number
      text: string
    } | null,
  ) => void
  clearInlineSuggestion: () => void
  addAbortController: (controller: AbortController) => void
  removeAbortController: (controller: AbortController) => void
  cancelPendingTabCompletion: () => void
  setVoiceInputInProgress: (inProgress: boolean) => void
  getDocumentSummary?: (input: {
    filePath: string
    content: string
  }) => string | null
  t: (key: string, fallback: string) => string
}

const DEFAULT_FALLBACK_MODEL_KEYS = [
  'continuationOptions',
  'chatTitleModelId',
  'chatModelId',
] as const

/**
 * Grace window for the in-flight polish when new ASR segments arrive. If the
 * in-flight polish hasn't returned within this many ms past the new segment
 * being enqueued, the worker aborts it and re-issues one polish call over
 * the combined raw transcripts. Small enough that rapid dictation stays
 * responsive; large enough that we don't waste a polish call when the
 * in-flight one was about to land anyway.
 */
const MERGE_WAIT_FOR_INFLIGHT_MS = 1500
const PREFIX_CACHE_GROWTH_MULTIPLIER = 4

const resolvePolishModelId = (settings: YoloSettings): string | null => {
  const voice = settings.contextVoiceInputOptions
  if (voice?.polishModelId && voice.polishModelId.trim().length > 0) {
    return voice.polishModelId
  }
  for (const key of DEFAULT_FALLBACK_MODEL_KEYS) {
    if (key === 'continuationOptions') {
      const fallback =
        settings.continuationOptions?.continuationModelId ??
        settings.continuationOptions?.tabCompletionModelId ??
        ''
      if (fallback.trim().length > 0) return fallback
    } else {
      const value = settings[key]
      if (typeof value === 'string' && value.trim().length > 0) return value
    }
  }
  return null
}

const sliceBefore = (editor: Editor, fromOffset: number): string => {
  const fromPos = editor.offsetToPos(fromOffset)
  return editor.getRange({ line: 0, ch: 0 }, fromPos)
}

const sliceAfter = (
  editor: Editor,
  fromOffset: number,
  maxChars: number,
): string => {
  if (maxChars <= 0) return ''
  const fromPos = editor.offsetToPos(fromOffset)
  const totalLines = editor.lineCount()
  const lastLine = totalLines - 1
  const lastLineLen = editor.getLine(lastLine)?.length ?? 0
  const endPos = { line: lastLine, ch: lastLineLen }
  const fullAfter = editor.getRange(fromPos, endPos)
  return fullAfter.slice(0, maxChars)
}

const IDLE_STATUS: VoiceInputStatus = {
  state: 'idle',
  recordingStartedAt: null,
  mediaStream: null,
  canCancel: false,
  asrDurationMs: undefined,
  polishDurationMs: undefined,
}

const isAbortError = (error: unknown): boolean =>
  (error as { name?: string })?.name === 'AbortError' ||
  (error instanceof VoiceInputRecorderError && error.kind === 'aborted')

/**
 * Orchestrates the context-aware voice input feature.
 *
 * Per-segment lifecycle:
 *   1. User toggles or holds the mic; we capture the editor target.
 *   2. Each segment of audio (stop, or VAD slice) is pushed to the polish
 *      worker as a pending record. ASR runs in parallel with the previous
 *      segment's polish call.
 *   3. The polish worker drains segments one at a time. If a new segment
 *      arrives while a polish is in flight, we wait MERGE_WAIT_FOR_INFLIGHT_MS
 *      and then cancel the in-flight polish so the worker can re-issue one
 *      polish call over the merged raw transcripts. This keeps responsive
 *      latency when dictating rapidly without spending an extra LLM call.
 *   4. The polished candidate is rendered as a dark-grey ghost; user accepts
 *      with Tab (and, with `autoRestartAfterAccept`, the session auto-arms
 *      the next recording).
 */
export class ContextVoiceInputController {
  private recorder: VoiceInputRecorder | null = null
  private session: ActiveSession | null = null
  private status: VoiceInputStatus = IDLE_STATUS
  private listeners = new Set<VoiceInputStateListener>()
  private summaryManager: DocumentSummaryManager | null = null
  private prefixCacheManager: VoicePrefixCacheManager | null = null

  constructor(private readonly deps: VoiceInputControllerDeps) {}

  setSummaryManager(manager: DocumentSummaryManager | null): void {
    this.summaryManager = manager
  }

  setPrefixCacheManager(manager: VoicePrefixCacheManager | null): void {
    this.prefixCacheManager = manager
  }

  getStatus(): VoiceInputStatus {
    return this.status
  }

  isBusy(): boolean {
    return this.status.state !== 'idle'
  }

  isListening(): boolean {
    return this.status.state === 'recording'
  }

  hasPendingPreview(): boolean {
    return this.status.state === 'ready' && !!this.session?.decision
  }

  subscribe(listener: VoiceInputStateListener): () => void {
    this.listeners.add(listener)
    listener(this.status)
    return () => {
      this.listeners.delete(listener)
    }
  }

  destroy() {
    this.cancelActiveSession('shutdown')
    this.listeners.clear()
  }

  async toggle(editor: Editor): Promise<void> {
    if (this.status.state === 'recording') {
      await this.stopAndProcess()
      return
    }
    if (this.status.state === 'idle' || this.status.state === 'ready') {
      await this.startRecording(editor)
    }
  }

  async startRecording(editor: Editor): Promise<void> {
    if (this.status.state !== 'idle' && this.status.state !== 'ready') return
    await this.initRecordingSession({
      editor,
      previousModelOutput:
        (this.status.state === 'ready'
          ? this.session?.decision?.text?.trim()
          : '') ?? '',
    })
  }

  /**
   * Core recording-start path. Separated from `startRecording` so the
   * auto-restart pivot (in `tryAcceptFromView`) can call it directly after
   * already nulling the session, without re-tripping the entry-state guard.
   */
  private async initRecordingSession(input: {
    editor: Editor
    previousModelOutput: string
  }): Promise<void> {
    const { editor } = input
    const settings = this.deps.getSettings()
    const options = settings.contextVoiceInputOptions
    if (!options || !options.enabled) {
      new Notice('Context-aware voice input is disabled in settings.')
      return
    }
    try {
      getAsrProvider(options)
    } catch (error) {
      const message =
        error instanceof AsrConfigError
          ? error.message
          : 'Configure an ASR provider before using voice input.'
      new Notice(message)
      return
    }

    const polishModelId = resolvePolishModelId(settings)
    if (!polishModelId) {
      new Notice('Select a polish model in Editor → Voice input settings.')
      return
    }

    const view = this.deps.getEditorView(editor)
    if (!view) {
      new Notice('Voice input needs a focused editor.')
      return
    }

    const markdownView = this.deps.getActiveMarkdownView()
    const filePath = markdownView?.file?.path ?? ''
    const fileTitle = markdownView?.file?.basename ?? ''

    // Kick off document summary generation in the background BEFORE the
    // recorder spins up. Non-blocking — the first polish in this session
    // either picks up a fresh summary or skips it; we don't pay the LLM
    // round trip in the latency-critical preview path.
    if (
      options.documentSummaryEnabled &&
      this.summaryManager &&
      filePath.length > 0
    ) {
      try {
        const fullContent = editor.getValue()
        if (fullContent && fullContent.trim().length > 0) {
          this.summaryManager.warm({ filePath, content: fullContent })
        }
      } catch (error) {
        console.warn('Voice-input summary warm failed:', error)
      }
    }

    const cursorPos = editor.getCursor()
    const cursorOffset = editor.posToOffset(cursorPos)
    const selectionText = editor.getSelection()
    const hasSelection = !!selectionText && selectionText.length > 0
    const fromPos = hasSelection ? editor.getCursor('from') : cursorPos
    const toPos = hasSelection ? editor.getCursor('to') : cursorPos
    const fromOffset = editor.posToOffset(fromPos)
    const toOffset = editor.posToOffset(toPos)

    const recorder = new VoiceInputRecorder()
    try {
      await recorder.start({
        maxRecordingSeconds: options.maxRecordingSeconds,
        deviceId: options.microphoneDeviceId,
        onAutoStop: () => this.handleRecorderAutoStop(recorder),
      })
    } catch (error) {
      const message =
        error instanceof VoiceInputRecorderError
          ? error.message
          : 'Could not start recording.'
      new Notice(message)
      // The status may have been pre-pivoted to 'recording' by the auto-
      // restart path; reset to idle so the bar doesn't get stuck.
      if (this.session === null) this.updateStatus('idle')
      return
    }

    this.recorder = recorder
    const abortController = new AbortController()
    this.deps.addAbortController(abortController)

    this.deps.cancelPendingTabCompletion()
    // Per-source cleanup. Both startRecording (when state was 'ready') and
    // the auto-restart pivot will have pre-cleared most of this, but keep
    // it here so a fresh `idle → recording` start also clears any stale
    // ghost text the inline suggestion controller is still holding onto.
    this.deps.clearInlineSuggestion()
    this.deps.setVoiceInputInProgress(true)

    const recordingStartedAt = Date.now()
    this.session = {
      editor,
      view,
      startCursorOffset: cursorOffset,
      selectionFromOffset: fromOffset,
      selectionToOffset: toOffset,
      hasSelection,
      selectionText,
      filePath,
      fileTitle,
      abortController,
      decision: null,
      ghostFromOffset: null,
      recordingStartedAt,
      asrTranscript: null,
      previousModelOutput: input.previousModelOutput,
      pendingSegments: [],
      polishWorkerRunning: false,
      inFlightPolish: null,
    }
    this.updateStatus('recording')
  }

  private handleRecorderAutoStop(recorder: VoiceInputRecorder): boolean {
    if (this.recorder !== recorder) return false
    if (this.status.state !== 'recording') return false
    void this.stopAndProcess()
    return true
  }

  async stopAndProcess(): Promise<void> {
    if (this.status.state !== 'recording') return
    const session = this.session
    const recorder = this.recorder
    if (!session || !recorder) {
      this.cancelActiveSession('internal-error')
      return
    }

    this.updateStatus('transcribing')
    let audio
    try {
      audio = await recorder.stop()
    } catch (error) {
      this.handleSessionError(error)
      return
    }
    this.recorder = null

    if (!audio.blob || audio.blob.size === 0) {
      if (session.decision) {
        this.updateStatus('ready')
        return
      }
      this.handleSessionError(
        new VoiceInputRecorderError(
          'No audio captured — the recording was empty.',
          'unknown',
        ),
      )
      return
    }

    const settings = this.deps.getSettings()
    this.enqueueAudioSegment({ session, audio, settings })
  }

  async stopSegmentAndContinue(): Promise<void> {
    if (this.status.state !== 'recording') return
    const session = this.session
    const recorder = this.recorder
    if (!session || !recorder) {
      this.cancelActiveSession('internal-error')
      return
    }

    this.updateStatus('recording', 'transcribing')
    let audio: RecordedAudio
    try {
      audio = await recorder.stop()
    } catch (error) {
      this.handleSessionError(error)
      return
    }
    this.recorder = null

    if (!audio.blob || audio.blob.size === 0) {
      if (session.decision) {
        await this.startNextRecordingSegment(session, this.deps.getSettings())
        return
      }
      this.handleSessionError(
        new VoiceInputRecorderError(
          'No audio captured — the recording was empty.',
          'unknown',
        ),
      )
      return
    }

    const settings = this.deps.getSettings()
    await this.startNextRecordingSegment(session, settings)
    if (!this.session || this.session !== session) return
    this.enqueueAudioSegment({ session, audio, settings })
  }

  private async startNextRecordingSegment(
    session: ActiveSession,
    settings: YoloSettings,
  ): Promise<void> {
    const options = settings.contextVoiceInputOptions
    const recorder = new VoiceInputRecorder()
    try {
      await recorder.start({
        maxRecordingSeconds: options.maxRecordingSeconds,
        deviceId: options.microphoneDeviceId,
        onAutoStop: () => this.handleRecorderAutoStop(recorder),
      })
    } catch (error) {
      this.handleSessionError(error)
      return
    }
    if (!this.session || this.session !== session) {
      recorder.cancel()
      return
    }
    this.recorder = recorder
    session.recordingStartedAt = Date.now()
    this.updateStatus('recording', 'transcribing')
  }

  /**
   * Push a freshly-recorded audio blob onto the per-session polish queue.
   * Starts ASR immediately so it overlaps the in-flight polish, then arms
   * the merge-wait timer that will cancel the in-flight polish if it
   * outlives the new segment's grace window.
   */
  private enqueueAudioSegment({
    session,
    audio,
    settings,
  }: {
    session: ActiveSession
    audio: RecordedAudio
    settings: YoloSettings
  }): void {
    const transcribePromise = this.transcribeAudioSegment({
      session,
      audio,
      settings,
    })
    session.pendingSegments.push({ transcribePromise })

    // If a polish is in flight, give it the merge grace window before we
    // forcibly cancel-and-merge. The setTimeout is intentionally fire-and-
    // forget — abort() is idempotent and the worker handles the abort path.
    const inflight = session.inFlightPolish
    if (inflight) {
      window.setTimeout(() => {
        if (this.session !== session) return
        if (session.inFlightPolish !== inflight) return
        try {
          inflight.controller.abort()
        } catch {
          // Best-effort.
        }
      }, MERGE_WAIT_FOR_INFLIGHT_MS)
    }

    if (!session.polishWorkerRunning) {
      session.polishWorkerRunning = true
      void this.runPolishWorker(session, settings).finally(() => {
        if (this.session === session) {
          session.polishWorkerRunning = false
        }
      })
    }
  }

  /**
   * Loop until the session's segment queue is drained. Each iteration:
   *   1. Drain every transcript that is already known (or the head if none
   *      are ready), so a rapid-fire dictation can be polished in one call.
   *   2. Polish with the captured baseline previousModelOutput.
   *   3. If polish completes normally → commit it as the new
   *      previousModelOutput and surface the preview.
   *   4. If polish was aborted (a newer segment arrived past the merge
   *      window) → push the cancelled raw transcript back onto the queue
   *      head so the next iteration merges it with the newcomer.
   */
  private async runPolishWorker(
    session: ActiveSession,
    settings: YoloSettings,
  ): Promise<void> {
    while (this.session === session && session.pendingSegments.length > 0) {
      const transcripts: string[] = []
      while (session.pendingSegments.length > 0) {
        const segment = session.pendingSegments.shift()
        if (!segment) break
        let transcript: string | null = null
        try {
          transcript = await segment.transcribePromise
        } catch (error) {
          this.handleSessionError(error)
          return
        }
        if (this.session !== session) return
        if (transcript && transcript.trim().length > 0) {
          transcripts.push(transcript)
        }
      }
      if (transcripts.length === 0) continue

      // Join with a single space, never a newline. The previous '\n' join
      // showed up as an unwanted line break in the preview and biased the
      // polish model toward emitting paragraph breaks where the user just
      // paused.
      const combinedTranscript = transcripts.join(' ').trim()
      session.asrTranscript = combinedTranscript
      this.showAsrPreview(session, combinedTranscript)

      // Critical: set `inFlightPolish` BEFORE updating processing status.
      // updateProcessingStatus' last-resort branch disposes the session
      // when there's no recorder + no pending work + no decision + no
      // in-flight polish — and in hold-to-talk the recorder is already
      // null by the time the worker runs (stopAndProcess nulls it). If
      // we call updateProcessingStatus before setting inFlightPolish,
      // the worker kills its own session right before the polish HTTP
      // call lands, the bar snaps back to idle, and the polished text
      // arrives too late to ever render. This was the hold-to-talk
      // "ASR/LLM run fine but editor stays blank" bug.
      const baselinePrev = session.previousModelOutput
      const controller = new AbortController()
      const polishStartedAt = Date.now()
      const polishPromise = this.polishTranscript({
        transcript: combinedTranscript,
        session,
        settings,
        signal: controller.signal,
      })
      const record: InFlightPolish = {
        controller,
        promise: polishPromise,
        rawTranscript: combinedTranscript,
        baselinePreviousOutput: baselinePrev,
        startedAt: polishStartedAt,
      }
      session.inFlightPolish = record
      this.updateProcessingStatus(session, 'polishing')

      let decision: VoiceEditorDecision | null = null
      try {
        decision = await polishPromise
        session.polishDurationMs = Date.now() - polishStartedAt
      } catch (error) {
        if (this.session !== session) return
        if (isAbortError(error)) {
          // Cancelled by the merge-wait timer because newer segments are
          // queued. Put the cancelled raw transcript back at the head so
          // the next drain includes it.
          session.pendingSegments.unshift({
            transcribePromise: Promise.resolve(record.rawTranscript),
          })
          // The aborted polish never committed; the baseline previousModelOutput
          // is still the truth.
          if (session.inFlightPolish === record) session.inFlightPolish = null
          continue
        }
        this.handleSessionError(error)
        return
      } finally {
        if (session.inFlightPolish === record) session.inFlightPolish = null
      }

      if (!decision) continue
      if (this.session !== session) return

      // Malformed: parser refused to insert the raw output because it
      // looked like broken JSON. Surface a dedicated notice with the
      // prefix and drop this segment without touching the editor.
      if (decision.malformed) {
        const prefix = this.deps.t('voiceInput.noticePrefix', 'Voice polish')
        const msg = this.deps.t(
          'voiceInput.malformedOutput',
          'Voice polish returned malformed output; nothing inserted.',
        )
        new Notice(`${prefix}: ${msg}`)
        // Keep prior draft alive if there was one.
        if (baselinePrev.trim().length > 0) {
          session.decision = { action: 'insert_at_cursor', text: baselinePrev }
        } else {
          session.decision = null
        }
        continue
      }

      const hasNotice = !!decision.notice && decision.notice.trim().length > 0
      // Surface a polish-provided notice as an Obsidian toast with a
      // prefix so users can tell it came from the polish model (vs the
      // recorder, vs Obsidian itself, etc).
      if (hasNotice) {
        const prefix = this.deps.t('voiceInput.noticePrefix', 'Voice polish')
        new Notice(`${prefix}: ${decision.notice!.trim()}`)
      }

      const polishedText = decision.text.trim()
      if (polishedText.length === 0) {
        // Empty text: two distinct sub-cases.
        //
        //  1) hasNotice → the model intentionally cancelled or transformed
        //     something to nothing. Honour that as a session-wide reset:
        //     wipe the running draft so the NEXT segment doesn't bring
        //     back the cancelled text via previous_model_output.
        //  2) no notice → "I had nothing substantive to add" (filler, noise,
        //     a stray pop). Keep the prior draft alive so the user can
        //     still Tab-accept it.
        if (hasNotice) {
          session.previousModelOutput = ''
          session.decision = null
          if (session.view) {
            this.deps.setInlineSuggestionGhost(session.view, null)
          }
          this.deps.setActiveVoiceSuggestion(null)
        } else if (baselinePrev.trim().length > 0) {
          session.decision = { action: 'insert_at_cursor', text: baselinePrev }
        } else {
          session.decision = null
        }
        continue
      }

      session.decision = decision
      session.previousModelOutput = decision.text
      this.showPolishedPreview(session, decision)
    }
    if (this.session === session) {
      this.updateProcessingStatus(session)
    }
  }

  private async transcribeAudioSegment({
    session,
    audio,
    settings,
  }: {
    session: ActiveSession
    audio: RecordedAudio
    settings: YoloSettings
  }): Promise<string | null> {
    const options = settings.contextVoiceInputOptions
    const asrStartedAt = Date.now()
    try {
      const asrProvider = getAsrProvider(options)
      const activeConfig = resolveActiveAsrConfig(options)
      const asrResult = await asrProvider.transcribe(
        {
          blob: audio.blob,
          mimeType: audio.mimeType,
          durationMs: audio.durationMs,
        },
        {
          language: activeConfig?.language,
          signal: session.abortController.signal,
        },
      )
      session.asrDurationMs =
        asrResult.requestDurationMs ?? Date.now() - asrStartedAt
      const transcript = asrResult.text?.trim() ?? ''
      if (!transcript) return null
      return transcript
    } catch (error) {
      if (this.session === session && session.abortController.signal.aborted) {
        return null
      }
      throw error
    }
  }

  private updateProcessingStatus(
    session: ActiveSession,
    overlayState?: Exclude<VoiceInputState, 'idle' | 'recording'>,
  ): void {
    if (this.session !== session) return
    if (this.status.state === 'recording') {
      this.updateStatus('recording', overlayState ?? 'ready')
      return
    }
    // Explicit overlayState means "I'm actively doing work, stay alive".
    // Honour it even if our own bookkeeping (pending / inflight / decision)
    // hasn't been updated yet — the caller's word is the truth in this
    // case. Without this short-circuit the disposal branch below could
    // tear down the session mid-pipeline (see the hold-to-talk bug fixed
    // alongside this guard).
    if (overlayState) {
      this.updateStatus(overlayState)
      return
    }
    if (session.pendingSegments.length > 0 || session.inFlightPolish) {
      this.updateStatus('polishing')
      return
    }
    if (session.decision) {
      this.updateStatus('ready')
      return
    }
    // No decision, no pending work, no recorder → nothing to wait for.
    // Dispose the session so the floating island leaves the polishing /
    // ready state instead of getting stuck.
    if (!this.recorder) {
      this.finishSession()
    }
  }

  acceptPendingPreview(editor?: Editor): boolean {
    const view = editor ? this.deps.getEditorView(editor) : this.session?.view
    if (!view) return false
    return this.tryAcceptFromView(view)
  }

  private async polishTranscript({
    transcript,
    session,
    settings,
    signal,
  }: {
    transcript: string
    session: ActiveSession
    settings: YoloSettings
    signal: AbortSignal
  }): Promise<VoiceEditorDecision> {
    const options = settings.contextVoiceInputOptions
    const polishModelId = resolvePolishModelId(settings)
    if (!polishModelId) {
      throw new Error('Polish model is not configured.')
    }

    const { providerClient, model } = getChatModelClient({
      settings,
      modelId: polishModelId,
      onAutoPromoteTransportMode: (providerId, mode) => {
        void promoteProviderTransportModeToObsidian({
          getSettings: this.deps.getSettings,
          setSettings: this.deps.setSettings,
          providerId,
          mode,
        })
      },
    })

    // Anchor-based prefix slicing so prefix cache stays hot across
    // polish calls within a dictation arc. See `voicePrefixCacheManager`
    // for the full rationale. Falls back to the naive tail-slice when
    // no cache manager is wired (defensive — production main.ts always
    // wires one).
    const fullDocBefore = sliceBefore(
      session.editor,
      session.selectionFromOffset,
    )
    let before: string
    if (this.prefixCacheManager) {
      const pick = this.prefixCacheManager.pickBeforeSlice({
        filePath: session.filePath,
        fullDocBefore,
        // Re-anchor lands on the user-configured initial window, then the
        // slice can grow from there as the user keeps writing.
        // The setting is intentionally not a hard per-request cap anymore:
        // anchored prompts stay cache-friendly because they grow at the tail.
        minPrefixChars: options.contextRangeChars,
        maxPrefixChars:
          options.contextRangeChars * PREFIX_CACHE_GROWTH_MULTIPLIER,
      })
      before = pick.slice
    } else {
      before =
        fullDocBefore.length > options.contextRangeChars
          ? fullDocBefore.slice(
              fullDocBefore.length - options.contextRangeChars,
            )
          : fullDocBefore
    }
    const after = sliceAfter(
      session.editor,
      session.selectionToOffset,
      options.maxAfterContextChars,
    )

    const target: VoiceInputTarget = {
      fileTitle: session.fileTitle,
      filePath: session.filePath,
      before,
      after,
      selectionText: session.selectionText,
      hasSelection: session.hasSelection,
    }

    let documentSummary: string | null = null
    let documentHotWords: string[] | null = null
    if (options.documentSummaryEnabled && this.summaryManager) {
      try {
        // The summary cache is keyed by file path; the content arg is used
        // only for drift detection. Use the full editor value so the hash
        // matches what `warm()` was called with at recording start.
        const fullContent = session.editor.getValue()
        const cached = this.summaryManager.getSummary({
          filePath: session.filePath,
          content: fullContent,
        })
        documentSummary = cached?.summary ?? null
        documentHotWords =
          cached?.hotWords && cached.hotWords.length > 0
            ? cached.hotWords
            : null
      } catch (error) {
        console.warn('Voice-input summary lookup failed:', error)
      }
    }

    const messages = buildVoiceInputMessages({
      options,
      target,
      asrTranscript: transcript,
      previousModelOutput: session.previousModelOutput || undefined,
      documentSummary,
      documentHotWords,
    })

    const request: LLMRequestBase = {
      model: model.model,
      messages,
      // Force thinking OFF (instead of leaving it unset). Voice polish is a
      // latency-sensitive lightweight rewrite; without this, models whose
      // default is thinking-on (e.g. some reasoning-tier endpoints) will
      // burn 5-30 s on hidden reasoning before emitting the JSON envelope.
      reasoningLevel: 'off',
    }
    const polishTemperature =
      typeof options.polishTemperature === 'number'
        ? options.polishTemperature
        : model.temperature
    if (typeof polishTemperature === 'number') {
      request.temperature = Math.min(Math.max(polishTemperature, 0), 2)
    }

    // Combine the session-wide abort signal (user cancel / shutdown) with
    // the per-call signal (merge-wait timer) so either can short-circuit.
    const combinedSignal = combineAbortSignals([
      session.abortController.signal,
      signal,
    ])

    const result = await executeSingleTurn({
      providerClient,
      model,
      request,
      signal: combinedSignal,
      stream: false,
      primaryRequestTimeoutMs:
        settings.continuationOptions?.primaryRequestTimeoutMs,
      streamFallbackRecoveryEnabled: false,
      purpose: 'auxiliary',
    })

    return parseVoiceEditorDecision(result.content ?? '', {
      hasSelection: session.hasSelection,
    })
  }

  /**
   * Resolve the EditorView to render the preview against. We CAN'T just
   * trust the cached `session.view` because Obsidian may swap `editor.cm`
   * under us (live-preview toggle, focus shuffle when the user releases a
   * pointer outside the editor, pane re-layout, etc.). The cached ref
   * becomes stale and our previous "bail when view changes" guard caused
   * polish results to silently disappear (the hold-to-talk no-preview
   * bug). Instead, we look up the editor's CURRENT view; if it exists we
   * refresh `session.view` and carry on. Only bail when there is no
   * EditorView at all (editor truly gone).
   */
  private resolveSessionView(session: ActiveSession): EditorView | null {
    const current = this.deps.getEditorView(session.editor)
    if (!current) return null
    if (current !== session.view) {
      session.view = current
    }
    return current
  }

  private showAsrPreview(session: ActiveSession, transcript: string): void {
    const view = this.resolveSessionView(session)
    if (!view) return
    const fromOffset = session.hasSelection
      ? session.selectionToOffset
      : session.startCursorOffset
    session.ghostFromOffset = fromOffset
    // Join with a single space, never '\n' — the line break used to leak
    // into the preview when the user spoke a second segment.
    const previewText = session.previousModelOutput
      ? `${session.previousModelOutput} ${transcript}`
      : transcript
    const safeText = previewText.replace(/\r/g, '')
    this.deps.setInlineSuggestionGhost(view, {
      from: fromOffset,
      text: safeText,
      variant: 'voice-asr',
    })
  }

  private showPolishedPreview(
    session: ActiveSession,
    decision: VoiceEditorDecision,
  ): void {
    const view = this.resolveSessionView(session)
    if (!view) {
      this.finishSession()
      return
    }

    let fromOffset: number
    switch (decision.action) {
      case 'replace_selection':
      case 'insert_after_selection':
        fromOffset = session.selectionToOffset
        break
      case 'insert_at_cursor':
      default:
        fromOffset = session.startCursorOffset
        break
    }

    const safeText = decision.text.replace(/\r/g, '')

    session.ghostFromOffset = fromOffset
    this.deps.setInlineSuggestionGhost(view, {
      from: fromOffset,
      text: safeText,
      variant: 'voice-polished',
    })
    this.deps.setActiveVoiceSuggestion({
      editor: session.editor,
      view,
      fromOffset,
      text: safeText,
    })

    if (this.status.state === 'recording') {
      this.updateStatus('recording', 'ready')
    } else {
      this.updateStatus('ready')
    }
  }

  tryAcceptFromView(view: EditorView): boolean {
    const session = this.session
    const decision = session?.decision
    if (!session || !decision) return false

    // Accept only if the incoming view IS the editor's current view —
    // not if it's a stale handle from some other editor. We deliberately
    // do NOT require it to match the cached session.view: that ref can
    // drift mid-session (live-preview toggle, etc.) and forcing equality
    // would refuse the user's Tab on a still-valid session.
    const currentView = this.deps.getEditorView(session.editor)
    if (!currentView || currentView !== view) {
      this.cancelActiveSession('editor-changed')
      return false
    }
    session.view = currentView

    const editor = session.editor
    const startPos = editor.offsetToPos(session.startCursorOffset)
    const fromPos = editor.offsetToPos(session.selectionFromOffset)
    const toPos = editor.offsetToPos(session.selectionToOffset)

    const currentCursor = editor.getCursor()
    const currentCursorOffset = editor.posToOffset(currentCursor)
    const currentSelection = editor.getSelection() ?? ''
    if (session.hasSelection) {
      if (currentSelection.length === 0) {
        this.cancelActiveSession('selection-lost')
        return false
      }
      const currentFromOffset = editor.posToOffset(editor.getCursor('from'))
      const currentToOffset = editor.posToOffset(editor.getCursor('to'))
      if (
        currentFromOffset !== session.selectionFromOffset ||
        currentToOffset !== session.selectionToOffset
      ) {
        this.cancelActiveSession('selection-moved')
        return false
      }
    } else if (currentCursorOffset !== session.startCursorOffset) {
      this.cancelActiveSession('cursor-moved')
      return false
    }

    const insertionText = escapeMarkdownSpecialChars(decision.text, {
      escapeAngleBrackets: true,
      preserveCodeBlocks: true,
    })

    let endCursor: { line: number; ch: number }
    switch (decision.action) {
      case 'replace_selection': {
        editor.replaceRange(insertionText, fromPos, toPos)
        endCursor = this.computeEndCursor(fromPos, insertionText)
        editor.setCursor(endCursor)
        break
      }
      case 'insert_after_selection': {
        editor.replaceRange(insertionText, toPos, toPos)
        endCursor = this.computeEndCursor(toPos, insertionText)
        editor.setCursor(endCursor)
        break
      }
      case 'insert_at_cursor':
      default: {
        editor.replaceRange(insertionText, startPos, startPos)
        endCursor = this.computeEndCursor(startPos, insertionText)
        editor.setCursor(endCursor)
        break
      }
    }

    const settings = this.deps.getSettings()
    const voice = settings.contextVoiceInputOptions
    const shouldRestart =
      !!voice?.autoRestartAfterAccept &&
      voice.interactionMode === 'toggle-listen'

    if (shouldRestart) {
      // Pivot directly into a new recording session WITHOUT going through
      // idle. The previous implementation called finishSession() then
      // setTimeout → startRecording, which had two bugs:
      //   - The bar collapsed to idle (width 0) then re-expanded — a
      //     visible wobble.
      //   - The status stayed 'ready' during recorder.start() until the
      //     mic was live, so the bar got stuck on "Tab insert · Esc
      //     discard" while the user was already speaking; and if VAD
      //     fired on the new recording before status flipped to
      //     'recording', stopSegmentAndContinue silently early-returned
      //     (its first line is `if (state !== 'recording') return`),
      //     producing the "no output" symptom.
      //
      // The fix: synchronously clear the old session, immediately pivot
      // status to 'recording' (mediaStream null until the new recorder
      // is up), then init the new session. The bar's centre slot keeps
      // its 160px width because both 'ready' and 'recording' map to that
      // same expanded layout in CSS.
      this.deps.setInlineSuggestionGhost(session.view, null)
      this.deps.setActiveVoiceSuggestion(null)
      try {
        session.abortController.abort()
      } catch {
        // Best-effort.
      }
      this.deps.removeAbortController(session.abortController)
      this.session = null
      this.recorder = null
      // Synchronously pivot the bar to 'recording' so the worker / VAD
      // contract `state === 'recording'` is restored before the new mic
      // is live and the user can't see a stale "Tab · Esc" badge.
      this.updateStatus('recording')

      const editorRef = editor
      // Yield a tick so the editor's own cursor/text-update settles
      // before we hit getCursor again. 50ms is generous but the cost is
      // a single rAF.
      window.setTimeout(() => {
        void this.initRecordingSession({
          editor: editorRef,
          previousModelOutput: '',
        }).catch((err) => {
          console.warn('Voice auto-restart failed:', err)
          if (this.session === null) {
            this.updateStatus('idle')
          }
        })
      }, 50)
      return true
    }

    this.finishSession()
    return true
  }

  tryRejectFromView(view: EditorView): boolean {
    const session = this.session
    if (!session || !session.decision) return false
    if (session.view !== view) return false
    this.cancelActiveSession('rejected')
    return true
  }

  cancelActiveSession(reason: string): void {
    const session = this.session
    if (session) {
      try {
        session.abortController.abort()
      } catch {
        // Best-effort.
      }
      this.deps.removeAbortController(session.abortController)
    }
    if (this.recorder) {
      try {
        this.recorder.cancel()
      } catch {
        // Best-effort.
      }
      this.recorder = null
    }
    if (session?.view) {
      this.deps.setInlineSuggestionGhost(session.view, null)
    }
    this.deps.setActiveVoiceSuggestion(null)
    this.deps.setVoiceInputInProgress(false)
    this.session = null

    if (reason === 'shutdown') {
      this.updateStatus('idle')
      return
    }
    this.updateStatus('idle')
  }

  private finishSession(): void {
    const session = this.session
    if (session?.view) {
      this.deps.setInlineSuggestionGhost(session.view, null)
    }
    if (session) {
      this.deps.removeAbortController(session.abortController)
    }
    this.deps.setActiveVoiceSuggestion(null)
    this.deps.setVoiceInputInProgress(false)
    this.session = null
    this.recorder = null
    this.updateStatus('idle')
  }

  private handleSessionError(error: unknown): void {
    const aborted = isAbortError(error)
    if (!aborted) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Voice input failed.'
      console.error('Context voice input failed:', error)
      new Notice(`Voice input failed: ${message}`)
    }
    this.cancelActiveSession(aborted ? 'aborted' : 'error')
  }

  private updateStatus(
    state: VoiceInputState,
    overlayState?: VoiceInputStatus['overlayState'],
  ): void {
    const session = this.session
    const next: VoiceInputStatus = {
      state,
      overlayState,
      recordingStartedAt: session?.recordingStartedAt ?? null,
      mediaStream:
        state === 'recording' && this.recorder
          ? this.recorder.getMediaStream()
          : null,
      canCancel: state !== 'idle',
      asrDurationMs: session?.asrDurationMs,
      polishDurationMs: session?.polishDurationMs,
    }
    this.status = next
    for (const listener of this.listeners) {
      listener(next)
    }
  }

  private computeEndCursor(
    from: { line: number; ch: number },
    insertionText: string,
  ): { line: number; ch: number } {
    const parts = insertionText.split('\n')
    if (parts.length === 1) {
      return { line: from.line, ch: from.ch + parts[0].length }
    }
    return {
      line: from.line + parts.length - 1,
      ch: parts[parts.length - 1].length,
    }
  }
}

/**
 * Tiny polyfill of AbortSignal.any (Node 20+ / modern browsers) so we work
 * inside Electron's older renderer.
 */
const combineAbortSignals = (signals: AbortSignal[]): AbortSignal => {
  const native = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal
    }
  ).any
  if (typeof native === 'function') {
    return native(signals)
  }
  const controller = new AbortController()
  const propagate = (s: AbortSignal) => {
    if (s.aborted) {
      controller.abort(s.reason)
      return
    }
    s.addEventListener('abort', () => controller.abort(s.reason), {
      once: true,
    })
  }
  for (const s of signals) propagate(s)
  return controller.signal
}
