import { EditorView } from '@codemirror/view'
import { Editor, MarkdownView, Notice } from 'obsidian'

import { executeSingleTurn } from '../../../core/ai/single-turn'
import { AsrConfigError, getAsrProvider } from '../../../core/asr/manager'
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

const truncatePreview = (text: string, limit = 80): string => {
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}…`
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
export class ContextVoiceInputController {
  private recorder: VoiceInputRecorder | null = null
  private session: ActiveSession | null = null
  private status: VoiceInputStatus = { state: 'idle' }
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
    if (this.status.state === 'idle') {
      await this.startRecording(editor)
    }
    // While transcribing / polishing / ready we ignore toggle requests; the
    // user can cancel via Esc which clears the ghost preview.
  }

  async startRecording(editor: Editor): Promise<void> {
    if (this.status.state !== 'idle') return

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
      await recorder.start({ maxRecordingSeconds: options.maxRecordingSeconds })
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

    if (options.pauseTabCompletionWhileListening) {
      this.deps.cancelPendingTabCompletion()
    }
    this.deps.clearInlineSuggestion()
    this.deps.setVoiceInputInProgress(true)

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
    }
    this.updateStatus({ state: 'recording' })
  }

  async stopAndProcess(): Promise<void> {
    if (this.status.state !== 'recording') return
    const session = this.session
    const recorder = this.recorder
    if (!session || !recorder) {
      this.cancelActiveSession('internal-error')
      return
    }

    this.updateStatus({ state: 'transcribing' })
    let audio
    try {
      audio = await recorder.stop()
    } catch (error) {
      this.handleSessionError(error)
      return
    }
    this.recorder = null

    if (!audio.blob || audio.blob.size === 0) {
      this.handleSessionError(
        new VoiceInputRecorderError(
          'No audio captured — the recording was empty.',
          'unknown',
        ),
      )
      return
    }

    const settings = this.deps.getSettings()
    const options = settings.contextVoiceInputOptions

    let transcript: string
    try {
      const asrProvider = getAsrProvider(options)
      const asrResult = await asrProvider.transcribe(
        {
          blob: audio.blob,
          mimeType: audio.mimeType,
          durationMs: audio.durationMs,
        },
        {
          language: options.language,
          signal: session.abortController.signal,
        },
      )
      transcript = asrResult.text?.trim() ?? ''
    } catch (error) {
      this.handleSessionError(error)
      return
    }

    if (!transcript) {
      this.handleSessionError(new Error('ASR returned an empty transcript.'))
      return
    }

    this.updateStatus({ state: 'polishing' })

    let decision: VoiceEditorDecision
    try {
      decision = await this.polishTranscript({
        transcript,
        session,
        settings,
      })
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

    this.showPolishedPreview(session, decision)
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
    })

    const request: LLMRequestBase = {
      model: model.model,
      messages,
      temperature: 0.2,
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
    const previewText = truncatePreview(safeText, 240)

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

    this.updateStatus({ state: 'ready' })
    new Notice(`Voice ready — Tab to insert: "${previewText}"`)
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
      this.updateStatus({ state: 'idle' })
      return
    }
    const userVisible = reason !== 'rejected'
    if (userVisible) {
      // Silent for now; future Slice can surface a chip with the reason.
    }
    this.updateStatus({ state: 'idle' })
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
    this.updateStatus({ state: 'idle' })
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

  private updateStatus(status: VoiceInputStatus): void {
    this.status = status
    for (const listener of this.listeners) {
      listener(status)
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
