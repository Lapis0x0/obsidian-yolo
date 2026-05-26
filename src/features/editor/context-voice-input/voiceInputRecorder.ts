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
  private state: 'idle' | 'recording' | 'stopping' | 'stopped' = 'idle'
  // Tracks an in-flight stop so duplicate `stop()` calls (e.g. external timer
  // races the internal auto-stop) attach to the same promise instead of
  // rejecting with "not active recording".
  private inFlightStop: Promise<RecordedAudio> | null = null

  isRecording(): boolean {
    return this.state === 'recording'
  }

  async start(opts: { maxRecordingSeconds: number }): Promise<void> {
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
      stream = await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (err) {
      throw mapGetUserMediaError(err)
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
    this.startedAt = Date.now()
    ;(recorder as any).ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data)
      }
    }
    ;(recorder as any).onerror = (event: Event) => {
      const message =
        ((event as any).error?.message as string | undefined) ??
        'Recorder error.'
      const error = new VoiceInputRecorderError(message, 'unknown')
      if (this.rejectStop) {
        const reject = this.rejectStop
        this.resetCallbacks()
        this.cleanup()
        reject(error)
      }
    }
    ;(recorder as any).onstop = () => {
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
      this.resetCallbacks()
      this.cleanup()
      if (resolve) resolve(result)
    }
    ;(recorder as any).start(250)
    this.state = 'recording'

    const maxMs = Math.max(5, opts.maxRecordingSeconds) * 1000
    this.autoStopTimer = setTimeout(() => {
      if (this.state === 'recording') {
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
    void promise.finally(() => {
      if (this.inFlightStop === promise) this.inFlightStop = null
    })
    return promise
  }

  cancel(): void {
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
}
