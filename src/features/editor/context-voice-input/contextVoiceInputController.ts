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

import {
  type VoiceEditorDecision,
  parseVoiceEditorDecision,
} from './voiceDecisionParser'
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
  /** Processing phase to show over the waveform while recording continues. */
  overlayState?: Exclude<VoiceInputState, 'idle' | 'recording'>
  /** Wall-clock ms when recording began; null while idle. */
  recordingStartedAt: number | null
  /** Live audio stream for waveform visualization; null when not recording. */
  mediaStream: MediaStream | null
  /** Whether the user can click cancel to abort the active session. */
  canCancel: boolean
  /**
   * Latency of the last ASR call in ms. Populated once we transition out of
   * `'transcribing'`. The UI surfaces this so users can compare endpoints.
   */
  asrDurationMs?: number
  /** Latency of the last polish LLM call. Populated leaving `'polishing'`. */
  polishDurationMs?: number
}

export type VoiceInputStateListener = (status: VoiceInputStatus) => void

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
  /** Raw ASR transcript, shown as light-grey ghost text before polish. */
  asrTranscript: string | null
  /** Polished draft that has not landed in the editor yet. */
  previousModelOutput: string
  /** Number of audio segments currently in ASR/polish. */
  pendingSegmentCount: number
  /** Serialises polish calls so each segment sees the previous polished draft. */
  polishTail: Promise<void>
  /** Captured ASR call duration in ms. */
  asrDurationMs?: number
  /** Captured polish LLM call duration in ms. */
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
}

const DEFAULT_FALLBACK_MODEL_KEYS = [
  'continuationOptions',
  'chatTitleModelId',
  'chatModelId',
] as const

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

/**
 * Orchestrates the context-aware voice input feature (Slice A).
 *
 * Flow:
 *   1. User toggles recording (command, hotkey, or status-bar mic).
 *   2. We capture the editor target (file, cursor, selection, before/after).
 *   3. Recorder produces an audio Blob; ASR provider returns a transcript.
 *   4. Polish LLM rewrites the transcript into a `VoiceEditorDecision`
 *      JSON payload; we render the polished text as a dark-grey ghost
 *      preview that the user accepts with Tab or discards with Esc.
 *   5. On accept, we insert at the captured cursor / replace the captured
 *      selection, after re-validating that the editor target is still
 *      intact.
 */
const IDLE_STATUS: VoiceInputStatus = {
  state: 'idle',
  recordingStartedAt: null,
  mediaStream: null,
  canCancel: false,
  asrDurationMs: undefined,
  polishDurationMs: undefined,
}

export class ContextVoiceInputController {
  private recorder: VoiceInputRecorder | null = null
  private session: ActiveSession | null = null
  private status: VoiceInputStatus = IDLE_STATUS
  private listeners = new Set<VoiceInputStateListener>()

  constructor(private readonly deps: VoiceInputControllerDeps) {}

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
    // While transcribing / polishing we ignore toggle requests; the user can
    // cancel via Esc which clears the ghost preview.
  }

  async startRecording(editor: Editor): Promise<void> {
    if (this.status.state !== 'idle' && this.status.state !== 'ready') return
    const previousSession = this.status.state === 'ready' ? this.session : null
    const previousModelOutput = previousSession?.decision?.text?.trim() ?? ''

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
      return
    }

    this.recorder = recorder
    const abortController = new AbortController()
    this.deps.addAbortController(abortController)

    this.deps.cancelPendingTabCompletion()
    if (previousSession) {
      if (previousSession.view) {
        this.deps.setInlineSuggestionGhost(previousSession.view, null)
      }
      this.deps.setActiveVoiceSuggestion(null)
      this.deps.removeAbortController(previousSession.abortController)
    } else {
      this.deps.clearInlineSuggestion()
    }
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
      previousModelOutput,
      pendingSegmentCount: 0,
      polishTail: Promise.resolve(),
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
    await this.processAudioSegment({ session, audio, settings })
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
    void this.processAudioSegment({ session, audio, settings })
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

  private async processAudioSegment({
    session,
    audio,
    settings,
  }: {
    session: ActiveSession
    audio: RecordedAudio
    settings: YoloSettings
  }): Promise<void> {
    session.pendingSegmentCount += 1
    const transcriptPromise = this.transcribeAudioSegment({
      session,
      audio,
      settings,
    })
    const run = async (): Promise<void> => {
      try {
        const transcript = await transcriptPromise
        if (!transcript) return
        await this.runAudioSegmentPipeline({ session, transcript, settings })
      } finally {
        if (!this.session || this.session !== session) {
          return
        }
        session.pendingSegmentCount = Math.max(
          0,
          session.pendingSegmentCount - 1,
        )
        this.updateProcessingStatus(session)
      }
    }
    const task = session.polishTail.then(run, run)
    session.polishTail = task.catch(() => {
      // The concrete error has already been surfaced by runAudioSegmentPipeline.
    })
    await task
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
      // Language is now stored per-config (see v63→v64 migration); pull it
      // from the active config rather than the legacy top-level field.
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
      // Prefer the provider-reported duration when present (more accurate;
      // strips out our own queue/preamble). Fall back to wall clock.
      session.asrDurationMs =
        asrResult.requestDurationMs ?? Date.now() - asrStartedAt
      const transcript = asrResult.text?.trim() ?? ''
      if (!transcript) {
        if (session.decision) {
          return null
        }
        this.handleSessionError(new Error('ASR returned an empty transcript.'))
        return null
      }
      return transcript
    } catch (error) {
      this.handleSessionError(error)
      return null
    }
  }

  private async runAudioSegmentPipeline({
    session,
    transcript,
    settings,
  }: {
    session: ActiveSession
    transcript: string
    settings: YoloSettings
  }): Promise<void> {
    // Phase 1: show the raw ASR transcript as a light-grey ghost so the user
    // sees something land immediately. Phase 2 below replaces it with the
    // polished dark-grey candidate (the only one the user can accept).
    if (!this.session || this.session !== session) return
    session.asrTranscript = transcript
    this.showAsrPreview(session, transcript)
    this.updateProcessingStatus(session, 'polishing')

    let decision: VoiceEditorDecision
    const polishStartedAt = Date.now()
    try {
      decision = await this.polishTranscript({
        transcript,
        session,
        settings,
      })
      session.polishDurationMs = Date.now() - polishStartedAt
    } catch (error) {
      this.handleSessionError(error)
      return
    }

    if (!this.session || this.session !== session) {
      // Session was cancelled mid-flight.
      return
    }

    session.decision = decision

    if (
      decision.action === 'cancel_input' ||
      decision.text.trim().length === 0
    ) {
      this.finishSession()
      new Notice('Voice input cancelled by the spoken directive.')
      return
    }

    session.previousModelOutput = decision.text
    this.showPolishedPreview(session, decision)
  }

  private updateProcessingStatus(
    session: ActiveSession,
    overlayState?: Exclude<VoiceInputState, 'idle' | 'recording'>,
  ): void {
    if (!this.session || this.session !== session) return
    if (this.status.state === 'recording') {
      this.updateStatus('recording', overlayState ?? 'ready')
      return
    }
    if (session.pendingSegmentCount > 0) {
      this.updateStatus(overlayState ?? 'polishing')
      return
    }
    if (session.decision) {
      this.updateStatus('ready')
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
  }: {
    transcript: string
    session: ActiveSession
    settings: YoloSettings
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

    const before = sliceBefore(session.editor, session.selectionFromOffset)
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

    const messages = buildVoiceInputMessages({
      options,
      target,
      asrTranscript: transcript,
      previousModelOutput: session.previousModelOutput || undefined,
    })

    const request: LLMRequestBase = {
      model: model.model,
      messages,
      // Force thinking OFF (instead of leaving it unset). Voice polish is a
      // latency-sensitive lightweight rewrite; without this, models whose
      // default is thinking-on (e.g. some reasoning-tier endpoints) will
      // burn 5-30 s on hidden reasoning before emitting the JSON envelope.
      // We pass an explicit 'off' so providers that respect a level override
      // disable thinking even when their server-side default is enabled.
      reasoningLevel: 'off',
    }
    const polishTemperature =
      typeof options.polishTemperature === 'number'
        ? options.polishTemperature
        : model.temperature
    if (typeof polishTemperature === 'number') {
      request.temperature = Math.min(Math.max(polishTemperature, 0), 2)
    }

    const result = await executeSingleTurn({
      providerClient,
      model,
      request,
      signal: session.abortController.signal,
      // Polish must be deterministic; streaming is unnecessary here.
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
   * Phase 1 of the two-phase preview. Shows the raw ASR transcript as a
   * light-grey ghost at the cursor (or selection end) so the user sees
   * something land within a few hundred ms of stopping the recording. We do
   * NOT register this as the active inline suggestion — Tab still waits for
   * the polished phase to land. The chip continues to read "整理中".
   */
  private showAsrPreview(session: ActiveSession, transcript: string): void {
    const view = session.view
    if (!view) return
    if (this.deps.getEditorView(session.editor) !== view) return
    const fromOffset = session.hasSelection
      ? session.selectionToOffset
      : session.startCursorOffset
    session.ghostFromOffset = fromOffset
    const previewText = session.previousModelOutput
      ? `${session.previousModelOutput}\n${transcript}`
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
    const view = session.view
    if (!view) {
      this.finishSession()
      return
    }
    if (this.deps.getEditorView(session.editor) !== view) {
      this.finishSession()
      return
    }

    // Choose the position where the ghost preview should appear. For
    // selection replacement, hover the ghost at the selection end so the
    // user sees both the old selection and the candidate.
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

    // The floating-island status bar already shows "Tab to insert · Esc to
    // discard" the moment we hit 'ready', and the ghost text itself is the
    // preview — an extra Notice on top of those was just noise.
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
    if (session.view !== view) return false

    if (this.deps.getEditorView(session.editor) !== view) {
      this.cancelActiveSession('editor-changed')
      return false
    }

    const editor = session.editor
    const startPos = editor.offsetToPos(session.startCursorOffset)
    const fromPos = editor.offsetToPos(session.selectionFromOffset)
    const toPos = editor.offsetToPos(session.selectionToOffset)

    // Re-check that the editor state has not drifted past the original
    // cursor/selection. If the user kept typing while polishing, abandon
    // the insert rather than smash their new text.
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

    switch (decision.action) {
      case 'replace_selection': {
        editor.replaceRange(insertionText, fromPos, toPos)
        const endCursor = this.computeEndCursor(fromPos, insertionText)
        editor.setCursor(endCursor)
        break
      }
      case 'insert_after_selection': {
        editor.replaceRange(insertionText, toPos, toPos)
        const endCursor = this.computeEndCursor(toPos, insertionText)
        editor.setCursor(endCursor)
        break
      }
      case 'insert_at_cursor':
      default: {
        editor.replaceRange(insertionText, startPos, startPos)
        const endCursor = this.computeEndCursor(startPos, insertionText)
        editor.setCursor(endCursor)
        break
      }
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
        // Best-effort abort.
      }
      this.deps.removeAbortController(session.abortController)
    }
    if (this.recorder) {
      try {
        this.recorder.cancel()
      } catch {
        // Best-effort cancel.
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
    const aborted =
      (error as { name?: string })?.name === 'AbortError' ||
      (error instanceof VoiceInputRecorderError && error.kind === 'aborted')
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
