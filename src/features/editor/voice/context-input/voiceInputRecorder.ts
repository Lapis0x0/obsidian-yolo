/**
 * Lightweight wrapper around `navigator.mediaDevices.getUserMedia` plus
 * `MediaRecorder` for the context-aware voice input feature.
 *
 * Responsibilities:
 * - Request mic permission lazily, only when the user actually triggers
 *   recording (not at plugin load).
 * - Pick a mime type that the host's MediaRecorder supports (`audio/webm`
 *   in Obsidian / Electron, `audio/mp4` on iOS Safari builds).
 * - Surface a single `stop()` promise that resolves with the final Blob,
 *   and a single `cancel()` that aborts cleanly with no Blob delivered.
 * - Provide a "max recording seconds" auto-stop so a forgotten session
 *   doesn't run forever and waste ASR quota.
 */

export type RecordedAudio = {
  blob: Blob
  mimeType: string
  durationMs: number
}

export type VoiceInputRecorderStartOptions = {
  maxRecordingSeconds: number
  deviceId?: string
  onChunk?: (chunk: Blob) => void
  onPcm16Chunk?: (chunk: ArrayBuffer, sampleRate: number) => void
  /** Called when MediaRecorder fails before a caller has entered stop(). */
  onError?: (error: VoiceInputRecorderError) => void
  /**
   * Called when the max-duration guard fires. Return `true` when the caller
   * took ownership of stopping; return `false` to fall back to recorder-owned
   * stopping.
   */
  onAutoStop?: () => boolean | undefined
}

export class VoiceInputRecorderError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'permission-denied'
      | 'no-device'
      | 'device-busy'
      | 'unsupported'
      | 'aborted'
      | 'unknown',
  ) {
    super(message)
    this.name = 'VoiceInputRecorderError'
  }
}

const CANDIDATE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  '',
]

const pickMimeType = (): string => {
  const MR = (globalThis as any).MediaRecorder
  if (!MR) return ''
  for (const candidate of CANDIDATE_MIME_TYPES) {
    if (!candidate) return ''
    if (
      typeof MR.isTypeSupported === 'function' &&
      MR.isTypeSupported(candidate)
    ) {
      return candidate
    }
  }
  return ''
}

const mapGetUserMediaError = (err: unknown): VoiceInputRecorderError => {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return new VoiceInputRecorderError(
        'Microphone access was denied. Grant the permission in your system / Obsidian settings.',
        'permission-denied',
      )
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return new VoiceInputRecorderError(
        'No microphone device was found.',
        'no-device',
      )
    }
    if (name === 'NotReadableError') {
      return new VoiceInputRecorderError(
        'The microphone is busy or not readable.',
        'device-busy',
      )
    }
    if (name === 'AbortError') {
      return new VoiceInputRecorderError('Recording aborted.', 'aborted')
    }
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Could not start recording.'
  return new VoiceInputRecorderError(message, 'unknown')
}

export class VoiceInputRecorder {
  private mediaRecorder: any = null
  private mediaStream: MediaStream | null = null
  private chunks: Blob[] = []
  private mimeType = ''
  private startedAt = 0
  private resolveStop: ((value: RecordedAudio) => void) | null = null
  private rejectStop: ((reason: unknown) => void) | null = null
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null
  private pcmAudioContext: AudioContext | null = null
  private pcmSource: MediaStreamAudioSourceNode | null = null
  private pcmWorkletNode: AudioWorkletNode | null = null
  private state: 'idle' | 'recording' | 'stopping' | 'stopped' = 'idle'
  // Tracks an in-flight stop so duplicate `stop()` calls (e.g. external timer
  // races the internal auto-stop) attach to the same promise instead of
  // rejecting with "not active recording".
  private inFlightStop: Promise<RecordedAudio> | null = null
  // Preserve the final Blob after an internally-triggered stop long enough for
  // an external caller's later `stop()` to pick it up. This covers settings
  // tests and other timer races without losing audio.
  private completedStopResult: RecordedAudio | null = null
  private cancelRequested = false

  isRecording(): boolean {
    return this.state === 'recording'
  }

  /**
   * Live MediaStream exposed for visualization (waveform / VU meter) only.
   * Returns null when no recording is in progress. Callers must not stop the
   * tracks — the recorder owns the lifetime.
   */
  getMediaStream(): MediaStream | null {
    return this.mediaStream
  }

  async start(opts: VoiceInputRecorderStartOptions): Promise<void> {
    if (this.state !== 'idle') {
      throw new VoiceInputRecorderError(
        `Recorder is not idle (state=${this.state}).`,
        'unknown',
      )
    }

    const mediaDevices =
      typeof navigator !== 'undefined' ? navigator.mediaDevices : null
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw new VoiceInputRecorderError(
        'Microphone capture is not supported in this environment.',
        'unsupported',
      )
    }

    const MR = (globalThis as any).MediaRecorder
    if (!MR) {
      throw new VoiceInputRecorderError(
        'MediaRecorder is not available in this environment.',
        'unsupported',
      )
    }

    let stream: MediaStream
    try {
      // Standard browser-side cleanup before the audio hits ASR. Matches
      // OpenWebUI's getUserMedia preset; cheap on the host, materially
      // improves WER on noisy mics, AC hum, and close-mic clipping.
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      if (opts.deviceId && opts.deviceId.trim().length > 0) {
        // `exact` so the browser errors instead of silently falling back to
        // a different mic when the user-chosen device is unplugged.
        audioConstraints.deviceId = { exact: opts.deviceId }
      }
      stream = await mediaDevices.getUserMedia({ audio: audioConstraints })
    } catch (err) {
      throw mapGetUserMediaError(err)
    }
    if (opts.onPcm16Chunk) {
      try {
        await this.startPcm16Streaming(stream, opts.onPcm16Chunk)
      } catch (err) {
        for (const track of stream.getTracks()) {
          try {
            track.stop()
          } catch {
            // Best-effort cleanup; ignore.
          }
        }
        throw mapGetUserMediaError(err)
      }
    }

    this.mediaStream = stream
    this.mimeType = pickMimeType()
    let recorder: unknown
    try {
      recorder = this.mimeType
        ? new MR(stream, { mimeType: this.mimeType })
        : new MR(stream)
    } catch (err) {
      this.releaseStream()
      throw mapGetUserMediaError(err)
    }
    this.mediaRecorder = recorder
    this.chunks = []
    this.completedStopResult = null
    this.cancelRequested = false
    this.startedAt = Date.now()
    ;(recorder as any).ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data)
        opts.onChunk?.(event.data)
      }
    }
    ;(recorder as any).onerror = (event: Event) => {
      const message =
        ((event as any).error?.message as string | undefined) ??
        'Recorder error.'
      const error = new VoiceInputRecorderError(message, 'unknown')
      this.cancelRequested = true
      if (this.rejectStop) {
        const reject = this.rejectStop
        this.resetCallbacks()
        this.cleanup()
        reject(error)
        return
      }
      this.resetCallbacks()
      this.cleanup()
      opts.onError?.(error)
    }
    ;(recorder as any).onstop = () => {
      if (this.cancelRequested) {
        this.resetCallbacks()
        this.cleanup()
        return
      }
      const blob = new Blob(
        this.chunks,
        this.mimeType ? { type: this.mimeType } : undefined,
      )
      const result: RecordedAudio = {
        blob,
        mimeType: this.mimeType || blob.type || 'audio/webm',
        durationMs: Date.now() - this.startedAt,
      }
      const resolve = this.resolveStop
      this.completedStopResult = result
      this.resetCallbacks()
      this.cleanup()
      if (resolve) resolve(result)
    }
    ;(recorder as any).start(250)
    this.state = 'recording'

    const maxMs = Math.max(5, opts.maxRecordingSeconds) * 1000
    this.autoStopTimer = setTimeout(() => {
      if (this.state === 'recording') {
        if (opts.onAutoStop) {
          try {
            if (opts.onAutoStop() !== false) return
          } catch {
            // Fall back to recorder-owned stopping below.
          }
        }
        void this.stop().catch(() => {
          /* surfaced via onerror */
        })
      }
    }, maxMs)
  }

  stop(): Promise<RecordedAudio> {
    // Idempotent: if a stop is already in flight (auto-stop fired first, or
    // a previous external call started shutdown), return the same promise.
    if (this.inFlightStop) return this.inFlightStop
    if (this.state === 'stopped' && this.completedStopResult) {
      return Promise.resolve(this.completedStopResult)
    }
    if (this.state !== 'recording' || !this.mediaRecorder) {
      return Promise.reject(
        new VoiceInputRecorderError(
          'Cannot stop: no active recording.',
          'unknown',
        ),
      )
    }
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer)
      this.autoStopTimer = null
    }
    this.state = 'stopping'
    const promise = new Promise<RecordedAudio>((resolve, reject) => {
      this.resolveStop = resolve
      this.rejectStop = reject
      try {
        this.mediaRecorder.stop()
      } catch (err) {
        this.resetCallbacks()
        this.cleanup()
        reject(mapGetUserMediaError(err))
      }
    })
    this.inFlightStop = promise
    void promise.then(
      () => {
        if (this.inFlightStop === promise) this.inFlightStop = null
      },
      () => {
        if (this.inFlightStop === promise) this.inFlightStop = null
      },
    )
    return promise
  }

  cancel(): void {
    this.cancelRequested = true
    this.completedStopResult = null
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer)
      this.autoStopTimer = null
    }
    if (
      this.mediaRecorder &&
      (this.state === 'recording' || this.state === 'stopping')
    ) {
      try {
        this.mediaRecorder.stop()
      } catch {
        // Ignore stop errors during cancel; cleanup runs unconditionally.
      }
    }
    if (this.rejectStop) {
      const reject = this.rejectStop
      this.resetCallbacks()
      reject(new VoiceInputRecorderError('Recording cancelled.', 'aborted'))
    }
    this.cleanup()
  }

  private resetCallbacks() {
    this.resolveStop = null
    this.rejectStop = null
  }

  private cleanup() {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer)
      this.autoStopTimer = null
    }
    this.stopPcm16Streaming()
    this.releaseStream()
    this.mediaRecorder = null
    this.chunks = []
    this.state = 'stopped'
  }

  private releaseStream() {
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Best-effort cleanup; ignore.
        }
      }
      this.mediaStream = null
    }
  }

  private async startPcm16Streaming(
    stream: MediaStream,
    onChunk: (chunk: ArrayBuffer, sampleRate: number) => void,
  ): Promise<void> {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (
        window as unknown as {
          webkitAudioContext?: typeof AudioContext
        }
      ).webkitAudioContext!
    if (!Ctor) {
      throw new VoiceInputRecorderError(
        'AudioContext is unavailable; cannot stream PCM audio.',
        'unsupported',
      )
    }
    const ctx = new Ctor()
    if (!ctx.audioWorklet) {
      try {
        void ctx.close()
      } catch {
        // best-effort
      }
      throw new VoiceInputRecorderError(
        'AudioWorklet is unavailable; cannot stream PCM audio.',
        'unsupported',
      )
    }
    const workletUrl = URL.createObjectURL(
      new Blob([PCM16_WORKLET_SOURCE], { type: 'text/javascript' }),
    )
    try {
      await ctx.audioWorklet.addModule(workletUrl)
    } finally {
      URL.revokeObjectURL(workletUrl)
    }
    const source = ctx.createMediaStreamSource(stream)
    const targetSampleRate = 16_000
    const node = new AudioWorkletNode(ctx, 'yolo-pcm16-streamer', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        targetSampleRate,
      },
    })
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (event.data.byteLength > 0) onChunk(event.data, targetSampleRate)
    }
    source.connect(node)
    node.connect(ctx.destination)
    if (ctx.state === 'suspended') await ctx.resume()
    this.pcmAudioContext = ctx
    this.pcmSource = source
    this.pcmWorkletNode = node
  }

  private stopPcm16Streaming(): void {
    if (this.pcmWorkletNode) {
      this.pcmWorkletNode.port.onmessage = null
      try {
        this.pcmWorkletNode.disconnect()
      } catch {
        // best-effort
      }
      this.pcmWorkletNode = null
    }
    if (this.pcmSource) {
      try {
        this.pcmSource.disconnect()
      } catch {
        // best-effort
      }
      this.pcmSource = null
    }
    if (this.pcmAudioContext) {
      try {
        void this.pcmAudioContext.close()
      } catch {
        // best-effort
      }
      this.pcmAudioContext = null
    }
  }
}

const PCM16_WORKLET_SOURCE = `
class YoloPcm16Streamer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.targetSampleRate = options.processorOptions?.targetSampleRate || 16000
    this.pending = []
    this.pendingLength = 0
    this.inputFrameBatch = 4096
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (input) {
      if (output) output.fill(0)
      this.pending.push(new Float32Array(input))
      this.pendingLength += input.length
      if (this.pendingLength >= this.inputFrameBatch) {
        const merged = new Float32Array(this.pendingLength)
        let offset = 0
        for (const part of this.pending) {
          merged.set(part, offset)
          offset += part.length
        }
        this.pending = []
        this.pendingLength = 0
        const pcm = this.encodeResampledPcm16(
          merged,
          sampleRate,
          this.targetSampleRate,
        )
        this.port.postMessage(pcm, [pcm])
      }
    } else if (output) {
      output.fill(0)
    }
    return true
  }

  encodeResampledPcm16(input, inputSampleRate, targetSampleRate) {
    if (input.length === 0) return new ArrayBuffer(0)
    const ratio = inputSampleRate / targetSampleRate
    const outputLength = Math.max(1, Math.floor(input.length / ratio))
    const buffer = new ArrayBuffer(outputLength * 2)
    const view = new DataView(buffer)
    for (let i = 0; i < outputLength; i++) {
      const sourceIndex = Math.min(input.length - 1, Math.floor(i * ratio))
      let sample = input[sourceIndex]
      if (sample > 1) sample = 1
      else if (sample < -1) sample = -1
      const intSample =
        sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
      view.setInt16(i * 2, intSample, true)
    }
    return buffer
  }
}

registerProcessor('yolo-pcm16-streamer', YoloPcm16Streamer)
`
