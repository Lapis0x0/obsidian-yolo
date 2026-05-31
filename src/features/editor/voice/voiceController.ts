import type { ChangeDesc } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { App, Editor, MarkdownView } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { InlineSuggestionGhostPayload } from '../inline-suggestion/inlineSuggestion'

import type { AudioFileSource } from './audio-file-transcription/audioFileSource'
import { AudioFileTranscriptionController } from './audio-file-transcription/audioFileTranscriptionController'
import { ContextVoiceInputWorkflow } from './context-input/contextVoiceInputWorkflow'
import type { DocumentSummaryManager } from './context-input/documentSummaryManager'
import type { VoicePrefixCacheManager } from './context-input/voicePrefixCacheManager'
import { ReadAloudController } from './read-aloud/readAloudController'
import {
  IDLE_VOICE_INPUT_STATUS,
  type VoiceInputState,
  type VoiceInputStateListener,
  type VoiceInputStatus,
} from './voiceStatus'

type VoiceControllerDeps = {
  app: App
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
  createFallbackMarkdownFile: (
    desiredPath: string,
    content: string,
  ) => Promise<string>
  appendToMarkdownFile: (path: string, content: string) => Promise<void>
  getDocumentSummary?: (input: {
    filePath: string
    content: string
  }) => string | null
  t: (key: string, fallback: string) => string
}

/**
 * Shared facade for floating-island voice workflows.
 *
 * It owns the externally observed status stream and delegates concrete work
 * to feature workflows. Read-aloud will plug in here later without changing
 * the island / inline-suggestion integration points.
 */
export class VoiceController {
  private readonly contextInputWorkflow: ContextVoiceInputWorkflow
  private readonly audioFileTranscriptionController: AudioFileTranscriptionController
  private readonly readAloudController: ReadAloudController
  private status: VoiceInputStatus = IDLE_VOICE_INPUT_STATUS
  private listeners = new Set<VoiceInputStateListener>()

  constructor(private readonly deps: VoiceControllerDeps) {
    this.contextInputWorkflow = new ContextVoiceInputWorkflow({
      getSettings: this.deps.getSettings,
      setSettings: this.deps.setSettings,
      getEditorView: this.deps.getEditorView,
      getActiveMarkdownView: this.deps.getActiveMarkdownView,
      setInlineSuggestionGhost: this.deps.setInlineSuggestionGhost,
      setActiveVoiceSuggestion: this.deps.setActiveVoiceSuggestion,
      clearInlineSuggestion: this.deps.clearInlineSuggestion,
      addAbortController: this.deps.addAbortController,
      removeAbortController: this.deps.removeAbortController,
      cancelPendingTabCompletion: this.deps.cancelPendingTabCompletion,
      setVoiceInputInProgress: this.deps.setVoiceInputInProgress,
      getDocumentSummary: this.deps.getDocumentSummary,
      onStatusChange: (status) => this.setStatus(status),
      t: this.deps.t,
    })
    this.audioFileTranscriptionController =
      new AudioFileTranscriptionController({
        getSettings: this.deps.getSettings,
        getStatusState: () => this.status.state,
        updateStatus: (state, extra) =>
          this.updateStatus(state, undefined, extra),
        getEditorView: this.deps.getEditorView,
        getActiveMarkdownView: this.deps.getActiveMarkdownView,
        clearInlineSuggestion: this.deps.clearInlineSuggestion,
        addAbortController: this.deps.addAbortController,
        removeAbortController: this.deps.removeAbortController,
        cancelPendingTabCompletion: this.deps.cancelPendingTabCompletion,
        setVoiceInputInProgress: this.deps.setVoiceInputInProgress,
        createFallbackMarkdownFile: this.deps.createFallbackMarkdownFile,
        appendToMarkdownFile: this.deps.appendToMarkdownFile,
        localizeAsrRuntimeError: (message) =>
          this.contextInputWorkflow.localizeAsrRuntimeError(message),
        t: this.deps.t,
      })
    this.readAloudController = new ReadAloudController({
      app: this.deps.app,
      getSettings: this.deps.getSettings,
      getStatusState: () => this.status.state,
      updateStatus: (state, extra) =>
        this.updateStatus(state, undefined, extra),
      getActiveMarkdownView: this.deps.getActiveMarkdownView,
      clearInlineSuggestion: this.deps.clearInlineSuggestion,
      addAbortController: this.deps.addAbortController,
      removeAbortController: this.deps.removeAbortController,
      cancelPendingTabCompletion: this.deps.cancelPendingTabCompletion,
      setVoiceInputInProgress: this.deps.setVoiceInputInProgress,
      t: this.deps.t,
    })
  }

  setSummaryManager(manager: DocumentSummaryManager | null): void {
    this.contextInputWorkflow.setSummaryManager(manager)
  }

  setPrefixCacheManager(manager: VoicePrefixCacheManager | null): void {
    this.contextInputWorkflow.setPrefixCacheManager(manager)
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
    return this.contextInputWorkflow.hasPendingPreview()
  }

  async startAudioFileTranscription(
    input: File | AudioFileSource,
    editor: Editor | null,
  ): Promise<void> {
    await this.audioFileTranscriptionController.start(input, editor)
  }

  async confirmAudioFileTranscription(): Promise<void> {
    await this.audioFileTranscriptionController.confirm()
  }

  async startReadAloudSelectionOrDocument(): Promise<void> {
    await this.readAloudController.start('selection-or-document')
  }

  async startReadAloudSelection(): Promise<void> {
    await this.readAloudController.start('selection')
  }

  async startReadAloudDocument(): Promise<void> {
    await this.readAloudController.start('document')
  }

  async confirmReadAloudLongText(): Promise<void> {
    await this.readAloudController.confirmLongText()
  }

  async pauseReadAloud(): Promise<void> {
    await this.readAloudController.pause()
  }

  async resumeReadAloud(): Promise<void> {
    await this.readAloudController.resume()
  }

  prepareGeneratedAudioDrag(event: DragEvent): boolean {
    return this.readAloudController.prepareGeneratedAudioDrag(event)
  }

  hasGeneratedAudio(): boolean {
    return this.readAloudController.hasGeneratedAudio()
  }

  seekReadAloudToRatio(ratio: number): void {
    this.readAloudController.seekToRatio(ratio)
  }

  subscribe(listener: VoiceInputStateListener): () => void {
    this.listeners.add(listener)
    listener(this.status)
    return () => {
      this.listeners.delete(listener)
    }
  }

  destroy(): void {
    this.cancelActiveSession('shutdown')
    this.listeners.clear()
  }

  handleEditorSelectionChange(view: EditorView): void {
    this.contextInputWorkflow.handleEditorSelectionChange(view)
  }

  handleEditorDocumentChange(view: EditorView, changes?: ChangeDesc): void {
    this.audioFileTranscriptionController.handleEditorDocumentChange(
      view,
      changes,
    )
    this.contextInputWorkflow.handleEditorDocumentChange(view, changes)
  }

  async toggle(editor: Editor): Promise<void> {
    if (this.status.state !== 'idle' && this.status.state !== 'ready') {
      if (this.status.state === 'recording') {
        await this.contextInputWorkflow.stopAndProcess()
      }
      return
    }
    await this.contextInputWorkflow.toggle(editor)
  }

  async startRecording(editor: Editor): Promise<void> {
    if (this.status.state !== 'idle' && this.status.state !== 'ready') return
    await this.contextInputWorkflow.startRecording(editor)
  }

  async stopAndProcess(): Promise<void> {
    await this.contextInputWorkflow.stopAndProcess()
  }

  async stopSegmentAndContinue(): Promise<void> {
    await this.contextInputWorkflow.stopSegmentAndContinue()
  }

  acceptPendingPreview(editor?: Editor): boolean {
    return this.contextInputWorkflow.acceptPendingPreview(editor)
  }

  tryAcceptFromView(view: EditorView): boolean {
    return this.contextInputWorkflow.tryAcceptFromView(view)
  }

  tryRejectFromView(view: EditorView): boolean {
    return this.contextInputWorkflow.tryRejectFromView(view)
  }

  cancelIfFileChanged(): void {
    this.contextInputWorkflow.cancelIfFileChanged()
  }

  cancelActiveSession(reason: string): void {
    this.readAloudController.stop(reason)
    this.audioFileTranscriptionController.cancelActiveSession(reason)
    this.contextInputWorkflow.cancelActiveSession(reason)
    if (reason === 'shutdown') {
      this.setStatus(IDLE_VOICE_INPUT_STATUS)
    }
  }

  private updateStatus(
    state: VoiceInputState,
    overlayState?: VoiceInputStatus['overlayState'],
    extra?: Pick<
      VoiceInputStatus,
      'message' | 'progressLabel' | 'audioFilePlan' | 'readAloud'
    >,
  ): void {
    this.setStatus({
      state,
      overlayState,
      recordingStartedAt: null,
      mediaStream: null,
      canCancel: state !== 'idle',
      message: extra?.message,
      progressLabel: extra?.progressLabel,
      audioFilePlan: extra?.audioFilePlan,
      readAloud: extra?.readAloud,
    })
  }

  private setStatus(status: VoiceInputStatus): void {
    this.status = status
    for (const listener of this.listeners) {
      listener(status)
    }
  }
}

export type {
  VoiceInputState,
  VoiceInputStateListener,
  VoiceInputStatus,
} from './voiceStatus'
