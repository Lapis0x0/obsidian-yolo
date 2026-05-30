/**
 * Bottom-of-editor floating island for the context-aware voice input feature.
 *
 * Design summary:
 *   - ONE persistent mic button. No outer double-ring; the button itself
 *     shows state via colour (idle → red recording → blue processing). The
 *     halo around the recording mic breathes gently (not a strobe) so it
 *     reads as "we're listening" without screaming for attention.
 *   - Two interaction modes, switchable via the small mode-toggle button:
 *       * 'toggle-listen' (default): click to start. VAD auto-stops after
 *         ~1.2 s of silence and the controller pipes through ASR + polish
 *         automatically. Click again before VAD fires to stop manually.
 *       * 'hold-to-talk': pointerdown to start, pointerup (anywhere) to stop
 *         & process. The bar is PRE-EXPANDED in this mode (placeholder
 *         centre slot reserved) so pressing the mic doesn't shift its
 *         position. Race-safe: if the user releases before recording
 *         actually started, the release is queued and fires the stop the
 *         moment recording becomes live.
 *   - Centre slot is shared real estate: waveform during recording, then a
 *     status overlay (fade-in, semi-transparent) during transcribing /
 *     polishing / ready. Same width either way, so nothing reflows when
 *     phases change. Timer is a small badge in the corner of the waveform
 *     during recording; latency replaces it in the overlay afterwards.
 *   - On narrow viewports the bar can wrap; the centre slot shrinks.
 */

import type { MarkdownView } from 'obsidian'

import type {
  ContextVoiceInputController,
  VoiceInputStatus,
} from './contextVoiceInputController'

type InteractionMode = 'toggle-listen' | 'hold-to-talk' | 'audio-file'
type AudioFileDragKind = 'audio' | 'maybe-audio' | 'unsupported'

type VoiceVadOptions = {
  speechStartDecibels: number
  silenceDecibels: number
  speechRequiredMs: number
  silenceHoldMs: number
}

type IslandDeps = {
  getController: () => ContextVoiceInputController | null
  getActiveMarkdownView: () => MarkdownView | null
  t: (key: string, fallback: string) => string
  isFeatureReady: () => boolean
  isAudioFileModeEnabled: () => boolean
  getAudioFileDragKind: (event: DragEvent) => AudioFileDragKind | null
  resolveAudioFileFromDrop: (event: DragEvent) => Promise<File | null>
  getInteractionMode: () => InteractionMode
  setInteractionMode: (mode: InteractionMode) => Promise<void>
  getVadOptions: () => VoiceVadOptions
  getBottomOffsetVh: () => number
}

/**
 * The status overlay in the `ready` state first shows the polish latency
 * ("Tab insert · 1.2s") for READY_LATENCY_HOLD_MS, then cross-fades to a
 * combined hint ("Tab insert · Esc discard") so both shortcuts are visible
 * without crowding the badge with the latency at the same time. Once the
 * combined hint is shown we DO NOT rotate any further — earlier iterations
 * alternated forever, which the user found distracting.
 */
const READY_LATENCY_HOLD_MS = 3000

const WAVE_HISTORY_SAMPLES = 80 // ~2.5 s of audio at 32 fps draw rate
// 4096 samples gives VAD and the waveform a ~85ms window at 48kHz
// (~93ms at 44.1kHz), smoothing out short spikes while keeping auto-stop
// responsive enough for dictation.
const WAVE_FFT_SIZE = 4096
const WAVE_BAR_WIDTH = 3 // px per amplitude sample in the scrolling band

// VAD tuning. Start detection is a little more sensitive so quiet speech can
// arm the session; once speech has been heard, the stop threshold becomes
// stricter so room noise does not keep toggle-listen alive forever.
const DEFAULT_VAD_SPEECH_START_DECIBELS = -40
const DEFAULT_VAD_SILENCE_DECIBELS = -36
const DEFAULT_VAD_SILENCE_HOLD_MS = 1200 // stop ~1.2 s after speech tails off
const DEFAULT_VAD_SPEECH_REQUIRED_MS = 200 // ignore stray pops < this duration

export class VoiceFloatingIslandController {
  private root: HTMLElement | null = null
  private micButton: HTMLButtonElement | null = null
  private modeToggleButton: HTMLButtonElement | null = null
  private waveCanvas: HTMLCanvasElement | null = null
  private timerEl: HTMLElement | null = null
  private statusEl: HTMLElement | null = null
  private fileInput: HTMLInputElement | null = null
  private host: HTMLElement | null = null
  private attachedView: MarkdownView | null = null

  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private streamSource: MediaStreamAudioSourceNode | null = null
  private waveBuffer: Uint8Array | null = null
  private waveHistory: Float32Array = new Float32Array(WAVE_HISTORY_SAMPLES)
  private waveRafId: number | null = null
  private timerInterval: number | null = null
  private currentStream: MediaStream | null = null
  private unsubscribeController: (() => void) | null = null

  // VAD state
  private vadSpeechActiveSinceMs = 0
  private vadSilenceSinceMs = 0
  private vadEverHeardSpeech = false
  private vadAutoStopRequested = false

  // hold-to-talk state. `holdActive` flips to true on pointerdown in hold
  // mode; `pendingHoldRelease` traps the race where the user releases the
  // button BEFORE `startRecording` has finished setting state to 'recording'.
  private holdActive = false
  private pendingHoldRelease = false
  private documentPointerUpListener: ((e: PointerEvent) => void) | null = null

  // Ready-state hint reveal. After READY_LATENCY_HOLD_MS in ready, swap
  // the latency badge for "Tab insert · Esc discard" via a one-shot timer.
  // Stays on that label until ready ends.
  private readyHintTimeout: number | null = null
  private readyHintRevealed = false
  private statusHostA: HTMLElement | null = null
  private statusHostB: HTMLElement | null = null
  private activeStatusHost: 'a' | 'b' = 'a'
  private audioDragDepth = 0
  private audioDragOver = false
  private audioDragKind: AudioFileDragKind | null = null
  private externalAudioDragRevealTimeout: number | null = null
  private lastPrimaryButtonKey: string | null = null
  private lastModeButtonKey: string | null = null
  private suppressModeButtonClickOnce = false
  private suppressModeButtonClickClearTimeout: number | null = null

  constructor(private readonly deps: IslandDeps) {}

  attachToActiveView(): void {
    const view = this.deps.getActiveMarkdownView()
    if (!view) {
      this.detach()
      return
    }
    this.attachToView(view)
  }

  attachToView(view: MarkdownView): void {
    const host = view.contentEl
    if (this.host === host && this.root) {
      this.attachedView = view
      this.applyStatus(this.deps.getController()?.getStatus() ?? null)
      return
    }
    this.detach()
    this.attachedView = view
    this.host = host
    this.mount(host)
    this.subscribeToController()
  }

  revealAudioDropTargetForView(
    view: MarkdownView,
    kind: AudioFileDragKind,
  ): void {
    this.attachToView(view)
    this.setAudioDragOver(true, kind)
    this.scheduleExternalAudioDragRevealClear()
  }

  clearAudioDropTargetReveal(): void {
    this.audioDragDepth = 0
    this.clearExternalAudioDragRevealTimeout()
    this.setAudioDragOver(false, null)
  }

  destroy(): void {
    this.detach({ immediate: true })
  }

  detach(options?: { immediate?: boolean }): void {
    this.unsubscribeController?.()
    this.unsubscribeController = null
    this.stopMonitoring()
    this.stopReadyHintReveal()
    this.clearExternalAudioDragRevealTimeout()
    this.removeDocumentPointerUpListener()
    const root = this.root
    if (root) {
      if (options?.immediate) {
        root.remove()
      } else {
        this.animateRootRemoval(root)
      }
    }
    this.micButton = null
    this.modeToggleButton = null
    this.waveCanvas = null
    this.timerEl = null
    this.statusEl = null
    this.fileInput = null
    this.attachedView = null
    this.statusHostA = null
    this.statusHostB = null
    this.host = null
    this.root = null
    this.audioDragDepth = 0
    this.audioDragOver = false
    this.audioDragKind = null
    this.lastPrimaryButtonKey = null
    this.lastModeButtonKey = null
    this.clearSuppressedModeButtonClick()
  }

  private animateRootRemoval(root: HTMLElement): void {
    root.classList.add('is-hidden')
    window.setTimeout(() => {
      root.remove()
    }, 180)
  }

  private mount(host: HTMLElement): void {
    const root = host.createDiv({ cls: 'yolo-voice-island' })
    root.dataset.voiceState = 'idle'
    root.classList.add('is-hidden')

    const mic = root.createEl('button', {
      cls: 'yolo-voice-island__mic',
      attr: { type: 'button', 'aria-label': 'Voice input' },
    })
    this.attachMicEventListeners(mic)

    // Centre slot. Holds the waveform (visible while recording), a small
    // corner timer badge, and a fade-in status overlay used during the
    // post-recording phases. All three share the same box so the bar width
    // stays constant once the centre slot is shown — nothing reflows when
    // we move between recording → transcribing → polishing → ready.
    const center = root.createDiv({ cls: 'yolo-voice-island__center' })

    const wave = center.createEl('canvas', {
      cls: 'yolo-voice-island__wave',
    })
    wave.width = WAVE_HISTORY_SAMPLES * WAVE_BAR_WIDTH
    wave.height = 32

    const timer = center.createDiv({ cls: 'yolo-voice-island__timer' })
    timer.textContent = '0:00'

    const overlay = center.createDiv({ cls: 'yolo-voice-island__overlay' })
    // Two stacked status hosts that cross-fade so the Tab / Esc hint
    // rotation in `ready` doesn't snap-flash text and the user can read
    // each phrase without losing place. Width animates via the centre
    // slot's CSS transition.
    const statusA = overlay.createDiv({
      cls: 'yolo-voice-island__status-text yolo-voice-island__status-text--a is-active',
    })
    const statusB = overlay.createDiv({
      cls: 'yolo-voice-island__status-text yolo-voice-island__status-text--b',
    })
    const statusText = statusA

    const modeToggle = root.createEl('button', {
      cls: 'yolo-voice-island__mode',
      attr: { type: 'button', 'aria-label': 'Switch interaction mode' },
    })
    this.renderModeButton(modeToggle, this.deps.getInteractionMode(), 'idle')
    modeToggle.addEventListener('mousedown', (e) => e.preventDefault())
    modeToggle.addEventListener('pointerdown', (e) => {
      const controller = this.deps.getController()
      const state = controller?.getStatus().state ?? 'idle'
      if (!this.isModeButtonCancel(state)) return
      e.preventDefault()
      e.stopPropagation()
      this.suppressNextModeButtonClick()
      controller?.cancelActiveSession('mode-button-cancel')
    })
    modeToggle.addEventListener(
      'click',
      () => void this.handleModeButtonClick(),
    )

    const fileInput = root.createEl('input', {
      cls: 'yolo-voice-island__file-input',
      attr: {
        type: 'file',
        accept: 'audio/*,.mp3,.m4a,.mp4,.wav,.webm,.ogg,.opus,.flac,.aac,.amr',
      },
    })
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0] ?? null
      fileInput.value = ''
      if (file) void this.startAudioFileTranscription(file)
    })

    this.attachAudioFileDragListeners(root)

    this.root = root
    this.micButton = mic
    this.modeToggleButton = modeToggle
    this.waveCanvas = wave
    this.timerEl = timer
    this.statusEl = statusText
    this.fileInput = fileInput
    this.statusHostA = statusA
    this.statusHostB = statusB
    this.activeStatusHost = 'a'

    // Commit the hidden initial style before `applyStatus` reveals the bar,
    // otherwise fresh mounts can skip the CSS transition in the same frame.
    void root.offsetHeight
    this.applyStatus(this.deps.getController()?.getStatus() ?? null)
  }

  /**
   * Attach pointer events for the mic button.
   *
   * - `pointerdown` in 'hold-to-talk' mode: kick off recording AND register a
   *   document-level `pointerup` so the release fires even if the cursor
   *   wandered off the button. We intentionally do NOT use `mouseleave`
   *   anymore — it was prematurely ending recordings every time the layout
   *   reflowed (the .is-recording class expands the bar, which can shift the
   *   mic's rect under the cursor and trigger a spurious mouseleave).
   * - `click` in 'toggle-listen' mode: start recording on first click, stop +
   *   process on second click (or auto via VAD).
   */
  private attachMicEventListeners(mic: HTMLButtonElement): void {
    mic.addEventListener('pointerdown', (e) => {
      // Don't let the editor / button lose / regain focus — the editor
      // selection must stay put while voice input runs.
      e.preventDefault()
      const controller = this.deps.getController()
      if (controller?.getStatus().state !== 'idle') return
      const mode = this.deps.getInteractionMode()
      if (mode !== 'hold-to-talk') return
      void this.beginHoldToTalk()
    })

    mic.addEventListener('click', (e) => {
      e.preventDefault()
      void this.handlePrimaryButtonClick()
    })
  }

  private subscribeToController(): void {
    const controller = this.deps.getController()
    if (!controller) return
    this.unsubscribeController = controller.subscribe((status) => {
      this.applyStatus(status)
    })
  }

  private applyStatus(status: VoiceInputStatus | null): void {
    if (!this.root) return
    const ready = this.deps.isFeatureReady()
    if (!ready) {
      this.root.classList.add('is-hidden')
      this.stopMonitoring()
      return
    }

    // Re-applied on every status change so updating the offset in settings
    // takes effect on the next attach without needing a dedicated event.
    // setCssProps (Obsidian helper) avoids the lint rule against direct
    // element.style writes.
    const offsetVh = this.deps.getBottomOffsetVh()
    this.root.setCssProps({
      '--yolo-voice-island-bottom': `${offsetVh}vh`,
    })

    const state = status?.state ?? 'idle'
    this.root.dataset.voiceState = state
    if (status?.overlayState) {
      this.root.dataset.voiceOverlayState = status.overlayState
    } else {
      delete this.root.dataset.voiceOverlayState
    }
    this.root.classList.remove('is-hidden')
    this.root.classList.toggle('is-audio-drag-over', this.audioDragOver)
    this.root.classList.toggle(
      'is-audio-drag-unsupported',
      this.audioDragKind === 'unsupported',
    )
    if (this.micButton) {
      this.renderPrimaryButton(this.micButton, state)
    }

    const interactionMode = this.deps.getInteractionMode()
    if (this.modeToggleButton) {
      this.renderModeButton(this.modeToggleButton, interactionMode, state)
    }
    // In hold-to-talk mode, pre-expand the bar even when idle so pressing
    // the mic doesn't shift its horizontal position. The centre slot stays
    // empty until recording begins (no overlay text — the user said the
    // overlay should only appear when needed, not as a permanent label).
    this.root.classList.toggle(
      'is-hold-mode',
      interactionMode === 'hold-to-talk',
    )
    this.root.classList.toggle(
      'is-audio-file-mode',
      interactionMode === 'audio-file' || this.audioDragOver,
    )

    // Drive status text shown inside the bar.
    if (this.statusHostA && this.statusHostB) {
      this.renderStatusText(state, status ?? null)
    }

    // Ready: hold the latency badge for 3s, then reveal "Tab + Esc" combined
    // hint (one-shot, no further rotation). Leaving ready cancels the
    // pending reveal and resets so the next ready cycle starts fresh.
    if (state === 'ready' || status?.overlayState === 'ready') {
      this.scheduleReadyHintReveal()
    } else {
      this.stopReadyHintReveal()
    }

    if (state === 'recording') {
      this.root.classList.add('is-recording')
      // If the user released the button before recording actually began
      // (hold-to-talk race), fire the stop now that we're live.
      if (this.pendingHoldRelease) {
        this.pendingHoldRelease = false
        this.holdActive = false
        const controller = this.deps.getController()
        if (controller) {
          void controller.stopAndProcess()
        }
        return
      }
      this.beginMonitoring(status?.mediaStream ?? null)
      this.beginTimer(status?.recordingStartedAt ?? null)
    } else {
      this.root.classList.remove('is-recording')
      // Stop waveform + VAD as soon as we leave 'recording'. Bar stays
      // visible while transcribing/polishing/ready so the user sees the
      // latency badges + status text without anything moving around.
      this.stopMonitoring()
    }
  }

  private buildStatusText(
    state: VoiceInputStatus['state'],
    status: VoiceInputStatus | null,
  ): string {
    const latency = this.formatCompactStateLatency(state, status)
    if (this.audioDragOver && state === 'idle') {
      if (this.audioDragKind === 'unsupported') {
        return this.deps.t(
          'voiceInput.audioFileUnsupportedDropHint',
          'Only audio files',
        )
      }
      if (this.audioDragKind === 'maybe-audio') {
        return this.deps.t(
          'voiceInput.audioFileCheckDropHint',
          'Drop file to check audio',
        )
      }
      return this.deps.t(
        'voiceInput.audioFileDropHint',
        'Drop audio to transcribe',
      )
    }
    if (status?.message) return status.message
    const displayState =
      state === 'recording' && status?.overlayState
        ? status.overlayState
        : state
    switch (displayState) {
      case 'transcribing':
        return this.deps.t('voiceInput.barTranscribing', 'Transcribing…')
      case 'checking':
        return this.deps.t('voiceInput.audioFileChecking', 'Checking…')
      case 'confirm-plan':
        return this.deps.t('voiceInput.audioFileConfirm', 'Confirm upload')
      case 'preparing':
        return this.deps.t('voiceInput.audioFilePreparing', 'Preparing…')
      case 'uploading':
        return this.deps.t('voiceInput.audioFileUploading', 'Uploading…')
      case 'inserting':
        return this.deps.t('voiceInput.audioFileInserting', 'Inserting…')
      case 'polishing':
        return this.deps.t('voiceInput.barPolishing', 'Polishing…') + latency
      case 'ready': {
        const tab = this.deps.t('voiceInput.barReadyShort', 'Tab insert')
        if (!this.readyHintRevealed) {
          // First 3s: highlight latency next to the Tab hint.
          return tab + latency
        }
        // After 3s: replace the latency with the Esc hint so both Tab and
        // Esc are visible at once without truncating on narrow viewports.
        const esc = this.deps.t('voiceInput.barReadyEsc', 'Esc discard')
        return `${tab} · ${esc}`
      }
      case 'recording':
      case 'idle':
      default:
        // Hold-to-talk idle: prompt the user that the mic is a press-and-
        // hold control; otherwise the centre slot stays empty.
        if (
          displayState === 'idle' &&
          this.deps.getInteractionMode() === 'hold-to-talk'
        ) {
          return this.deps.t('voiceInput.holdToTalkHint', 'Press & hold')
        }
        if (
          displayState === 'idle' &&
          this.deps.getInteractionMode() === 'audio-file'
        ) {
          return this.deps.t(
            'voiceInput.audioFileIdleHint',
            'Drop or choose audio',
          )
        }
        return ''
    }
  }

  private renderStatusText(
    state: VoiceInputStatus['state'],
    status: VoiceInputStatus | null,
  ): void {
    const text = this.buildStatusText(state, status)
    const title = this.buildStatusTitle(state, status)
    // Always set both hosts' title so hover tooltips work no matter which
    // host is currently visible.
    if (this.statusHostA) this.statusHostA.title = title
    if (this.statusHostB) this.statusHostB.title = title

    const currentHost =
      this.activeStatusHost === 'a' ? this.statusHostA : this.statusHostB
    if (currentHost?.textContent === text) return

    // Cross-fade by swapping which host is the active (visible) one.
    const nextHostName: 'a' | 'b' = this.activeStatusHost === 'a' ? 'b' : 'a'
    const nextHost = nextHostName === 'a' ? this.statusHostA : this.statusHostB
    if (!nextHost) return
    nextHost.textContent = text
    nextHost.classList.add('is-active')
    if (currentHost) currentHost.classList.remove('is-active')
    this.activeStatusHost = nextHostName
  }

  private scheduleReadyHintReveal(): void {
    if (this.readyHintRevealed) return
    if (this.readyHintTimeout !== null) return
    this.readyHintTimeout = window.setTimeout(() => {
      this.readyHintRevealed = true
      this.readyHintTimeout = null
      const controller = this.deps.getController()
      const status = controller?.getStatus() ?? null
      if (this.statusHostA && this.statusHostB) {
        this.renderStatusText(status?.state ?? 'idle', status)
      }
    }, READY_LATENCY_HOLD_MS)
  }

  private stopReadyHintReveal(): void {
    if (this.readyHintTimeout !== null) {
      window.clearTimeout(this.readyHintTimeout)
      this.readyHintTimeout = null
    }
    this.readyHintRevealed = false
  }

  private buildStatusTitle(
    state: VoiceInputStatus['state'],
    status: VoiceInputStatus | null,
  ): string {
    const latency = this.formatVerboseStateLatency(state, status)
    const displayState =
      state === 'recording' && status?.overlayState
        ? status.overlayState
        : state
    if (displayState === 'polishing') {
      return this.deps.t('voiceInput.barPolishing', 'Polishing…') + latency
    }
    if (status?.message) return status.message
    if (displayState === 'ready') {
      return (
        this.deps.t('voiceInput.barReady', 'Tab to insert · Esc to discard') +
        latency
      )
    }
    return this.buildStatusText(state, status)
  }

  private formatCompactStateLatency(
    state: VoiceInputStatus['state'],
    status: VoiceInputStatus | null,
  ): string {
    if (!status) return ''
    const displayState =
      state === 'recording' && status.overlayState ? status.overlayState : state
    if (
      displayState === 'polishing' &&
      typeof status.asrDurationMs === 'number'
    ) {
      return ` · ${(status.asrDurationMs / 1000).toFixed(1)}s`
    }
    if (
      displayState === 'ready' &&
      typeof status.polishDurationMs === 'number'
    ) {
      return ` · ${(status.polishDurationMs / 1000).toFixed(1)}s`
    }
    return ''
  }

  private formatVerboseStateLatency(
    state: VoiceInputStatus['state'],
    status: VoiceInputStatus | null,
  ): string {
    if (!status) return ''
    const displayState =
      state === 'recording' && status.overlayState ? status.overlayState : state
    if (
      displayState === 'polishing' &&
      typeof status.asrDurationMs === 'number'
    ) {
      return ` · ASR ${(status.asrDurationMs / 1000).toFixed(1)}s`
    }
    if (
      displayState === 'ready' &&
      typeof status.polishDurationMs === 'number'
    ) {
      return ` · LLM ${(status.polishDurationMs / 1000).toFixed(1)}s`
    }
    return ''
  }

  private async handlePrimaryButtonClick(): Promise<void> {
    const controller = this.deps.getController()
    if (!controller) return
    const view = this.deps.getActiveMarkdownView()
    const state = controller.getStatus().state
    if (state === 'ready') {
      if (!view?.editor) return
      controller.acceptPendingPreview(view.editor)
      return
    }
    if (state === 'confirm-plan') {
      void controller.confirmAudioFileTranscription()
      return
    }
    if (state === 'recording') {
      await controller.stopAndProcess()
      return
    }
    if (state === 'idle' && this.deps.getInteractionMode() === 'audio-file') {
      this.fileInput?.click()
      return
    }
    if (
      state === 'idle' &&
      this.deps.getInteractionMode() === 'toggle-listen'
    ) {
      if (!view?.editor) return
      try {
        await controller.startRecording(view.editor)
      } catch (err) {
        console.error('Voice toggle-listen start failed:', err)
      }
    }
  }

  private renderPrimaryButton(
    button: HTMLButtonElement,
    state: VoiceInputStatus['state'],
  ): void {
    button.disabled =
      state === 'transcribing' ||
      state === 'polishing' ||
      state === 'checking' ||
      state === 'preparing' ||
      state === 'uploading' ||
      state === 'inserting'
    const renderKey = this.getPrimaryButtonRenderKey(state)
    if (this.lastPrimaryButtonKey === renderKey) {
      this.updatePrimaryButtonLabel(button, state)
      return
    }
    this.lastPrimaryButtonKey = renderKey
    button.empty()
    // Use only aria-label for the tooltip. Setting both `title` and
    // `aria-label` causes two tooltips to stack — the browser's native one
    // from `title` plus Obsidian's styled one from `aria-label`.
    button.removeAttribute('title')
    switch (state) {
      case 'recording':
        button.appendChild(buildStopSvg())
        button.setAttribute(
          'aria-label',
          this.deps.t('voiceInput.buttonStop', 'Stop recording'),
        )
        break
      case 'transcribing':
      case 'checking':
      case 'preparing':
      case 'uploading':
      case 'inserting':
      case 'polishing':
        button.appendChild(buildSpinnerSvg())
        button.setAttribute(
          'aria-label',
          this.buildStatusTitle(
            state,
            this.deps.getController()?.getStatus() ?? null,
          ),
        )
        break
      case 'ready':
      case 'confirm-plan':
        button.appendChild(buildCheckSvg())
        button.setAttribute(
          'aria-label',
          state === 'confirm-plan'
            ? this.deps.t('voiceInput.audioFileConfirmButton', 'Start upload')
            : this.deps.t('voiceInput.buttonAccept', 'Insert draft'),
        )
        break
      case 'idle':
      default:
        button.appendChild(
          this.deps.getInteractionMode() === 'audio-file'
            ? buildFileAudioSvg()
            : buildMicSvg(),
        )
        button.setAttribute(
          'aria-label',
          this.deps.getInteractionMode() === 'audio-file'
            ? this.deps.t(
                'voiceInput.audioFileChooseButton',
                'Choose audio file',
              )
            : this.deps.t('voiceInput.buttonStart', 'Start recording'),
        )
        break
    }
  }

  private getPrimaryButtonRenderKey(state: VoiceInputStatus['state']): string {
    switch (state) {
      case 'transcribing':
      case 'checking':
      case 'preparing':
      case 'uploading':
      case 'inserting':
      case 'polishing':
        return 'processing'
      case 'idle':
        return `idle:${this.deps.getInteractionMode()}`
      default:
        return state
    }
  }

  private updatePrimaryButtonLabel(
    button: HTMLButtonElement,
    state: VoiceInputStatus['state'],
  ): void {
    if (
      state === 'transcribing' ||
      state === 'checking' ||
      state === 'preparing' ||
      state === 'uploading' ||
      state === 'inserting' ||
      state === 'polishing'
    ) {
      button.setAttribute(
        'aria-label',
        this.buildStatusTitle(
          state,
          this.deps.getController()?.getStatus() ?? null,
        ),
      )
    }
  }

  private async beginHoldToTalk(): Promise<void> {
    const controller = this.deps.getController()
    if (!controller) return
    const view = this.deps.getActiveMarkdownView()
    if (!view?.editor) return
    if (controller.getStatus().state !== 'idle') return

    this.holdActive = true
    this.pendingHoldRelease = false
    // Document-level pointerup so the release fires even if the cursor left
    // the mic (very common while holding). We register one-shot per press.
    this.addDocumentPointerUpListener()

    try {
      await controller.startRecording(view.editor)
    } catch (err) {
      console.error('Voice hold-to-talk start failed:', err)
      this.holdActive = false
      this.pendingHoldRelease = false
      this.removeDocumentPointerUpListener()
      return
    }
    // Race: user may have already released by the time startRecording
    // finished its async work. `applyStatus` will see pendingHoldRelease and
    // fire the stop the moment state flips to 'recording'.
  }

  private endHoldToTalk(): void {
    if (!this.holdActive) return
    const controller = this.deps.getController()
    if (!controller) {
      this.holdActive = false
      this.removeDocumentPointerUpListener()
      return
    }
    const state = controller.getStatus().state
    if (state === 'recording') {
      this.holdActive = false
      this.pendingHoldRelease = false
      this.removeDocumentPointerUpListener()
      void controller.stopAndProcess()
      return
    }
    // Recording still spinning up — queue the stop for after the state
    // transition. holdActive stays true so a duplicate release is a no-op.
    this.pendingHoldRelease = true
    this.removeDocumentPointerUpListener()
  }

  /**
   * Resolve the document the island is currently mounted into. In Obsidian
   * pop-out windows the markdown view's `contentEl` lives in a different
   * document than the main window, so listening on the main `document`
   * would miss pointerup events the user fires in the popped-out window.
   * Fall back to the global `document` only when no host is attached yet
   * (defensive — listeners shouldn't be registered before mount).
   */
  private getActiveDocument(): Document {
    return this.host?.ownerDocument ?? document
  }

  private addDocumentPointerUpListener(): void {
    if (this.documentPointerUpListener) return
    const handler = () => this.endHoldToTalk()
    this.documentPointerUpListener = handler
    const doc = this.getActiveDocument()
    doc.addEventListener('pointerup', handler, { capture: true })
    // Also handle pointercancel (browser-initiated cancel mid-press, common
    // on touch when the gesture is reinterpreted as scroll).
    doc.addEventListener('pointercancel', handler, { capture: true })
  }

  private removeDocumentPointerUpListener(): void {
    const handler = this.documentPointerUpListener
    if (!handler) return
    const doc = this.getActiveDocument()
    doc.removeEventListener('pointerup', handler, { capture: true })
    doc.removeEventListener('pointercancel', handler, { capture: true })
    this.documentPointerUpListener = null
  }

  private async handleModeButtonClick(): Promise<void> {
    if (this.suppressModeButtonClickOnce) {
      this.clearSuppressedModeButtonClick()
      return
    }
    const controller = this.deps.getController()
    const state = controller?.getStatus().state ?? 'idle'
    if (this.isModeButtonCancel(state)) {
      controller?.cancelActiveSession('mode-button-cancel')
      return
    }
    await this.cycleMode()
  }

  private suppressNextModeButtonClick(): void {
    this.clearSuppressedModeButtonClick()
    this.suppressModeButtonClickOnce = true
    this.suppressModeButtonClickClearTimeout = window.setTimeout(() => {
      this.clearSuppressedModeButtonClick()
    }, 1000)
  }

  private clearSuppressedModeButtonClick(): void {
    this.suppressModeButtonClickOnce = false
    if (this.suppressModeButtonClickClearTimeout !== null) {
      window.clearTimeout(this.suppressModeButtonClickClearTimeout)
      this.suppressModeButtonClickClearTimeout = null
    }
  }

  private async cycleMode(): Promise<void> {
    const current = this.deps.getInteractionMode()
    const next = this.getNextInteractionMode(current)
    await this.deps.setInteractionMode(next)
    if (this.modeToggleButton) {
      this.renderModeButton(
        this.modeToggleButton,
        next,
        this.deps.getController()?.getStatus().state ?? 'idle',
      )
    }
  }

  private isModeButtonCancel(state: VoiceInputStatus['state']): boolean {
    if (this.deps.getInteractionMode() === 'audio-file' && state !== 'idle') {
      return true
    }
    if (this.deps.getInteractionMode() !== 'toggle-listen') return false
    // Cancel button replaces the mode-switch icon for every active phase of
    // a click-mode session. Switching interaction mode mid-flow has no useful
    // meaning (the current session is already past the listen phase) and
    // accidentally clicking would just be a click-eaten no-op — turning the
    // right button into an explicit ✕ both prevents mistaken mode flips and
    // exposes one-click bail-out from any in-flight ASR / LLM call or pending
    // preview, matching the behaviour the user already sees while recording.
    return (
      state === 'recording' ||
      state === 'checking' ||
      state === 'confirm-plan' ||
      state === 'preparing' ||
      state === 'uploading' ||
      state === 'transcribing' ||
      state === 'inserting' ||
      state === 'polishing' ||
      state === 'ready'
    )
  }

  private getAvailableInteractionModes(): InteractionMode[] {
    return this.deps.isAudioFileModeEnabled()
      ? ['toggle-listen', 'hold-to-talk', 'audio-file']
      : ['toggle-listen', 'hold-to-talk']
  }

  private getNextInteractionMode(current: InteractionMode): InteractionMode {
    const modes = this.getAvailableInteractionModes()
    const index = modes.indexOf(current)
    return modes[(index + 1) % modes.length] ?? 'toggle-listen'
  }

  private renderModeButton(
    button: HTMLButtonElement,
    mode: InteractionMode,
    state: VoiceInputStatus['state'],
  ): void {
    const renderKey = this.getModeButtonRenderKey(mode, state)
    if (this.lastModeButtonKey === renderKey) return
    this.lastModeButtonKey = renderKey
    button.empty()
    // Drop any prior native `title` so we don't stack a browser tooltip on
    // top of Obsidian's aria-label tooltip (see renderPrimaryButton).
    button.removeAttribute('title')
    if (this.isModeButtonCancel(state)) {
      button.appendChild(buildCancelSvg())
      button.setAttribute(
        'aria-label',
        this.deps.t('voiceInput.buttonCancel', 'Cancel voice input'),
      )
      return
    }
    const nextMode = this.getNextInteractionMode(mode)
    if (nextMode === 'hold-to-talk') {
      button.appendChild(buildHoldSvg())
      button.setAttribute(
        'aria-label',
        this.deps.t(
          'voiceInput.modeSwitchToHold',
          'Click to switch to push-to-talk',
        ),
      )
    } else if (nextMode === 'audio-file') {
      button.appendChild(buildFileAudioSvg())
      button.setAttribute(
        'aria-label',
        this.deps.t(
          'voiceInput.modeSwitchToAudioFile',
          'Click to switch to audio file mode',
        ),
      )
    } else {
      button.appendChild(buildToggleSvg())
      button.setAttribute(
        'aria-label',
        this.deps.t(
          'voiceInput.modeSwitchToToggle',
          'Click to switch to click-toggle',
        ),
      )
    }
  }

  private getModeButtonRenderKey(
    mode: InteractionMode,
    state: VoiceInputStatus['state'],
  ): string {
    return this.isModeButtonCancel(state)
      ? 'cancel'
      : `mode:${this.getNextInteractionMode(mode)}`
  }

  private attachAudioFileDragListeners(root: HTMLElement): void {
    root.addEventListener('dragenter', (event) => {
      const kind = this.resolveAudioFileDragKind(event)
      if (!kind) return
      event.preventDefault()
      this.clearExternalAudioDragRevealTimeout()
      this.audioDragDepth += 1
      this.setAudioDragOver(true, kind)
    })
    root.addEventListener('dragover', (event) => {
      const kind = this.resolveAudioFileDragKind(event)
      if (!kind) return
      event.preventDefault()
      this.clearExternalAudioDragRevealTimeout()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = kind === 'unsupported' ? 'none' : 'copy'
      }
      this.setAudioDragOver(true, kind)
    })
    root.addEventListener('dragleave', (event) => {
      if (!this.audioDragOver) return
      event.preventDefault()
      this.audioDragDepth = Math.max(0, this.audioDragDepth - 1)
      if (this.audioDragDepth === 0) this.setAudioDragOver(false, null)
    })
    root.addEventListener('drop', (event) => {
      const kind = this.resolveAudioFileDragKind(event)
      if (!kind) return
      event.preventDefault()
      event.stopPropagation()
      this.audioDragDepth = 0
      this.setAudioDragOver(false, null)
      if (kind === 'unsupported') return
      void this.handleAudioFileDrop(event)
    })
  }

  private resolveAudioFileDragKind(event: DragEvent): AudioFileDragKind | null {
    if (!this.deps.isAudioFileModeEnabled()) return null
    const controller = this.deps.getController()
    if (controller?.getStatus().state !== 'idle') return null
    return this.deps.getAudioFileDragKind(event)
  }

  private async handleAudioFileDrop(event: DragEvent): Promise<void> {
    const file = await this.deps.resolveAudioFileFromDrop(event)
    if (file) await this.startAudioFileTranscription(file)
  }

  private setAudioDragOver(
    value: boolean,
    kind: AudioFileDragKind | null,
  ): void {
    if (this.audioDragOver === value && this.audioDragKind === kind) return
    this.audioDragOver = value
    this.audioDragKind = value ? kind : null
    this.applyStatus(this.deps.getController()?.getStatus() ?? null)
  }

  private scheduleExternalAudioDragRevealClear(): void {
    this.clearExternalAudioDragRevealTimeout()
    this.externalAudioDragRevealTimeout = window.setTimeout(() => {
      this.externalAudioDragRevealTimeout = null
      if (this.audioDragDepth === 0) this.setAudioDragOver(false, null)
    }, 300)
  }

  private clearExternalAudioDragRevealTimeout(): void {
    if (this.externalAudioDragRevealTimeout === null) return
    window.clearTimeout(this.externalAudioDragRevealTimeout)
    this.externalAudioDragRevealTimeout = null
  }

  private async startAudioFileTranscription(file: File): Promise<void> {
    const controller = this.deps.getController()
    if (!controller) return
    const view = this.attachedView ?? this.deps.getActiveMarkdownView()
    await controller.startAudioFileTranscription(file, view?.editor ?? null)
  }

  // ---- VAD + Waveform monitoring ----------------------------------------

  private beginMonitoring(stream: MediaStream | null): void {
    if (!stream) return
    if (this.currentStream === stream && this.waveRafId !== null) return
    this.stopMonitoring()
    this.currentStream = stream
    this.vadSpeechActiveSinceMs = 0
    this.vadSilenceSinceMs = 0
    this.vadEverHeardSpeech = false
    this.vadAutoStopRequested = false

    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (
          window as unknown as {
            webkitAudioContext?: typeof AudioContext
          }
        ).webkitAudioContext
      if (!Ctor) return
      const ctx = new Ctor()
      // Chrome / Electron may create the context in 'suspended' state if the
      // mic was acquired before any AudioContext was alive. The analyser
      // returns mid-byte (128, == silence) until we resume, which would make
      // VAD think the user is permanently silent and either misfire or stall.
      // Resuming is a no-op when the context is already running.
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {
          // Best-effort; if resume fails we still draw silence-looking
          // frames but at least won't crash.
        })
      }
      const analyser = ctx.createAnalyser()
      analyser.fftSize = WAVE_FFT_SIZE
      // Less smoothing = faster VAD response. 0.5 still keeps the waveform
      // visually smooth.
      analyser.smoothingTimeConstant = 0.5
      analyser.minDecibels = -90
      const source = ctx.createMediaStreamSource(stream)
      source.connect(analyser)
      this.audioContext = ctx
      this.analyser = analyser
      this.streamSource = source
      this.waveBuffer = new Uint8Array(analyser.fftSize)
      this.waveHistory = new Float32Array(WAVE_HISTORY_SAMPLES)
      this.drawWaveform()
    } catch (error) {
      console.error('Voice island: failed to start monitoring', error)
      this.stopMonitoring()
    }
  }

  /**
   * One animation frame:
   *   1. Pull byte-time-domain samples from the analyser.
   *   2. Compute amplitude (peak) for the waveform history + RMS dB for VAD.
   *   3. Repaint the canvas as a scrolling band with a horizontal centre line.
   *   4. In `toggle-listen` mode (re-read every frame so a mid-recording
   *      mode flip takes effect): if speech was heard and ≥ VAD_SILENCE_HOLD_MS
   *      of silence has elapsed, fire `stopAndProcess()`.
   */
  private drawWaveform = (): void => {
    const canvas = this.waveCanvas
    const analyser = this.analyser
    const buffer = this.waveBuffer
    if (!canvas || !analyser || !buffer) return

    analyser.getByteTimeDomainData(buffer)

    let peak = 0
    let sumSquares = 0
    for (let i = 0; i < buffer.length; i++) {
      const v = (buffer[i] - 128) / 128
      const abs = v < 0 ? -v : v
      if (abs > peak) peak = abs
      sumSquares += v * v
    }
    const rms = Math.sqrt(sumSquares / buffer.length)
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120

    this.waveHistory.copyWithin(0, 1)
    this.waveHistory[this.waveHistory.length - 1] = peak

    const ctx2d = canvas.getContext('2d')
    if (ctx2d) {
      this.repaintWaveform(ctx2d, canvas)
    }

    // VAD bookkeeping (toggle-listen only — re-read each frame in case the
    // user flipped the mode toggle mid-recording).
    if (
      !this.vadAutoStopRequested &&
      this.deps.getInteractionMode() === 'toggle-listen'
    ) {
      const now = Date.now()
      const vadOptions = this.deps.getVadOptions()
      const speechRequiredMs =
        vadOptions.speechRequiredMs ?? DEFAULT_VAD_SPEECH_REQUIRED_MS
      const speakingThreshold = this.vadEverHeardSpeech
        ? (vadOptions.silenceDecibels ?? DEFAULT_VAD_SILENCE_DECIBELS)
        : (vadOptions.speechStartDecibels ?? DEFAULT_VAD_SPEECH_START_DECIBELS)
      const speaking = rmsDb > speakingThreshold
      if (speaking) {
        if (this.vadSpeechActiveSinceMs === 0) {
          this.vadSpeechActiveSinceMs = now
        }
        this.vadSilenceSinceMs = 0
        if (now - this.vadSpeechActiveSinceMs >= speechRequiredMs) {
          this.vadEverHeardSpeech = true
        }
      } else {
        this.vadSpeechActiveSinceMs = 0
        if (this.vadEverHeardSpeech) {
          if (this.vadSilenceSinceMs === 0) {
            this.vadSilenceSinceMs = now
          }
          const silenceHoldMs =
            vadOptions.silenceHoldMs ?? DEFAULT_VAD_SILENCE_HOLD_MS
          if (now - this.vadSilenceSinceMs >= silenceHoldMs) {
            this.vadAutoStopRequested = true
            const controller = this.deps.getController()
            if (controller?.getStatus().state === 'recording') {
              void controller.stopSegmentAndContinue()
            }
            return
          }
        }
      }
    }

    this.waveRafId = window.requestAnimationFrame(this.drawWaveform)
  }

  private repaintWaveform(
    ctx2d: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
  ): void {
    const w = canvas.width
    const h = canvas.height
    ctx2d.clearRect(0, 0, w, h)

    ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.15)'
    ctx2d.lineWidth = 1
    ctx2d.beginPath()
    ctx2d.moveTo(0, h / 2)
    ctx2d.lineTo(w, h / 2)
    ctx2d.stroke()

    ctx2d.strokeStyle = 'rgba(108, 143, 255, 0.95)'
    ctx2d.lineWidth = WAVE_BAR_WIDTH - 1
    ctx2d.lineCap = 'round'

    const samples = this.waveHistory
    for (let i = 0; i < samples.length; i++) {
      const amplitude = samples[i]
      const x = i * WAVE_BAR_WIDTH + WAVE_BAR_WIDTH / 2
      const halfHeight = Math.max(0.5, amplitude * (h / 2 - 1))
      ctx2d.beginPath()
      ctx2d.moveTo(x, h / 2 - halfHeight)
      ctx2d.lineTo(x, h / 2 + halfHeight)
      ctx2d.stroke()
    }
  }

  private stopMonitoring(): void {
    if (this.waveRafId !== null) {
      window.cancelAnimationFrame(this.waveRafId)
      this.waveRafId = null
    }
    if (this.streamSource) {
      try {
        this.streamSource.disconnect()
      } catch {
        // best-effort
      }
      this.streamSource = null
    }
    if (this.audioContext) {
      try {
        void this.audioContext.close()
      } catch {
        // best-effort
      }
      this.audioContext = null
    }
    this.analyser = null
    this.waveBuffer = null
    this.currentStream = null
    this.waveHistory = new Float32Array(WAVE_HISTORY_SAMPLES)
    if (this.timerInterval !== null) {
      window.clearInterval(this.timerInterval)
      this.timerInterval = null
    }
    if (this.waveCanvas) {
      const ctx2d = this.waveCanvas.getContext('2d')
      if (ctx2d)
        ctx2d.clearRect(0, 0, this.waveCanvas.width, this.waveCanvas.height)
    }
    if (this.timerEl) this.timerEl.textContent = '0:00'
  }

  private beginTimer(startedAt: number | null): void {
    if (this.timerInterval !== null) {
      window.clearInterval(this.timerInterval)
      this.timerInterval = null
    }
    if (!this.timerEl || !startedAt) return
    const tick = () => {
      const elapsedSec = Math.max(
        0,
        Math.floor((Date.now() - startedAt) / 1000),
      )
      const m = Math.floor(elapsedSec / 60)
      const s = elapsedSec % 60
      this.timerEl!.textContent = `${m}:${s.toString().padStart(2, '0')}`
    }
    tick()
    this.timerInterval = window.setInterval(tick, 250)
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

const buildMicSvg = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')

  const body = document.createElementNS(SVG_NS, 'path')
  body.setAttribute('d', 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z')
  svg.appendChild(body)

  const arc = document.createElementNS(SVG_NS, 'path')
  arc.setAttribute('d', 'M19 10v2a7 7 0 0 1-14 0v-2')
  svg.appendChild(arc)

  const stand = document.createElementNS(SVG_NS, 'line')
  stand.setAttribute('x1', '12')
  stand.setAttribute('y1', '19')
  stand.setAttribute('x2', '12')
  stand.setAttribute('y2', '22')
  svg.appendChild(stand)
  return svg
}

const buildStopSvg = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '15')
  svg.setAttribute('height', '15')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'currentColor')
  const rect = document.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('x', '7')
  rect.setAttribute('y', '7')
  rect.setAttribute('width', '10')
  rect.setAttribute('height', '10')
  rect.setAttribute('rx', '2')
  svg.appendChild(rect)
  return svg
}

const buildCheckSvg = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M20 6 9 17l-5-5')
  svg.appendChild(path)
  return svg
}

const buildCancelSvg = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const line1 = document.createElementNS(SVG_NS, 'line')
  line1.setAttribute('x1', '18')
  line1.setAttribute('y1', '6')
  line1.setAttribute('x2', '6')
  line1.setAttribute('y2', '18')
  svg.appendChild(line1)
  const line2 = document.createElementNS(SVG_NS, 'line')
  line2.setAttribute('x1', '6')
  line2.setAttribute('y1', '6')
  line2.setAttribute('x2', '18')
  line2.setAttribute('y2', '18')
  svg.appendChild(line2)
  return svg
}

const buildSpinnerSvg = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2.2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.classList.add('yolo-voice-island__spinner-svg')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M21 12a9 9 0 1 1-6.2-8.56')
  svg.appendChild(path)
  return svg
}

const buildToggleSvg = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M3 12a9 9 0 0 1 15.5-6.3M21 12a9 9 0 0 1-15.5 6.3')
  svg.appendChild(path)
  const arrowTopRight = document.createElementNS(SVG_NS, 'polyline')
  arrowTopRight.setAttribute('points', '18 3 18 8 13 8')
  svg.appendChild(arrowTopRight)
  const arrowBottomLeft = document.createElementNS(SVG_NS, 'polyline')
  arrowBottomLeft.setAttribute('points', '6 21 6 16 11 16')
  svg.appendChild(arrowBottomLeft)
  return svg
}

const buildHoldSvg = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const p1 = document.createElementNS(SVG_NS, 'path')
  p1.setAttribute(
    'd',
    'M12 2v10M8 7v5a4 4 0 0 0 8 0V7M6 12v4a6 6 0 0 0 12 0v-4',
  )
  svg.appendChild(p1)
  return svg
}

const buildFileAudioSvg = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')

  const file = document.createElementNS(SVG_NS, 'path')
  file.setAttribute(
    'd',
    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
  )
  svg.appendChild(file)

  const fold = document.createElementNS(SVG_NS, 'path')
  fold.setAttribute('d', 'M14 2v6h6')
  svg.appendChild(fold)

  const note = document.createElementNS(SVG_NS, 'path')
  note.setAttribute('d', 'M9 17v-5l5-1v5')
  svg.appendChild(note)

  const leftStem = document.createElementNS(SVG_NS, 'circle')
  leftStem.setAttribute('cx', '8')
  leftStem.setAttribute('cy', '17')
  leftStem.setAttribute('r', '1')
  svg.appendChild(leftStem)

  const rightStem = document.createElementNS(SVG_NS, 'circle')
  rightStem.setAttribute('cx', '13')
  rightStem.setAttribute('cy', '16')
  rightStem.setAttribute('r', '1')
  svg.appendChild(rightStem)

  return svg
}
