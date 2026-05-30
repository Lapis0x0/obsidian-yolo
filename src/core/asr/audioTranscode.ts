/**
 * Client-side audio transcoder for the chat-audio ASR path.
 *
 * Why this exists:
 *   - MediaRecorder hands us a webm/opus blob.
 *   - Google's chat-audio endpoint rejects webm with
 *     "Invalid audio format. Valid formats are: [wav, mp3]".
 *
 * Strategy: decode via the host's AudioContext (Obsidian runs on Electron, so
 * Web Audio is available), then write a speech-focused 16 kHz mono 16-bit PCM
 * WAV by hand. No external encoder dependency, no main-thread blocking beyond
 * the decode itself (browser-native, very fast for ≤120 s clips).
 *
 * We do NOT offer mp3 transcoding: it would require ~150 KB of lamejs in the
 * bundle and adds an extra lossy hop on top of an already-lossy opus capture.
 * WAV is widely accepted by chat-audio providers (OpenAI, Google, Qwen3,
 * FireRedASR2). 16 kHz mono keeps the outgoing bitrate predictable and avoids
 * sending high-sample-rate stereo files when speech recognition does not need
 * them.
 */

import type { AsrAudioInput } from './types'

const SAMPLE_BITS = 16
const BYTES_PER_SAMPLE = SAMPLE_BITS / 8
const AUDIO_DECODE_TIMEOUT_MS = 60_000
const ASR_WAV_SAMPLE_RATE = 16_000

let cachedDecodeContext: AudioContext | null = null

const getDecodeContext = (): AudioContext => {
  if (cachedDecodeContext) return cachedDecodeContext
  const Ctor: typeof AudioContext =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (
      globalThis as unknown as {
        webkitAudioContext?: typeof AudioContext
      }
    ).webkitAudioContext!
  if (!Ctor) {
    throw new Error(
      'AudioContext is unavailable; cannot transcode audio in this environment.',
    )
  }
  cachedDecodeContext = new Ctor()
  return cachedDecodeContext
}

/**
 * Decode any browser-decodable container (webm/opus, ogg/opus, mp4/aac, …)
 * into a 16-bit PCM WAV. Returns a new `AsrAudioInput` ready to send.
 */
export const transcodeToWav = async (
  input: AsrAudioInput,
): Promise<AsrAudioInput> => {
  const audioBuffer = await decodeAudioBlob(input.blob)
  assertDecodedAudioNotEmpty(audioBuffer)

  const wavBlob = encodePcm16Wav(audioBuffer, ASR_WAV_SAMPLE_RATE)
  return {
    blob: wavBlob,
    mimeType: 'audio/wav',
    durationMs: Math.round(audioBuffer.duration * 1000),
  }
}

export const transcodeToPcm16 = async (
  input: AsrAudioInput,
  targetSampleRate = 16_000,
): Promise<{ audio: ArrayBuffer; sampleRate: number; durationMs: number }> => {
  const audioBuffer = await decodeAudioBlob(input.blob)
  assertDecodedAudioNotEmpty(audioBuffer)
  return {
    audio: encodePcm16Raw(audioBuffer, targetSampleRate),
    sampleRate: targetSampleRate,
    durationMs: Math.round(audioBuffer.duration * 1000),
  }
}

export const decodeAudioBlob = async (blob: Blob): Promise<AudioBuffer> => {
  const arrayBuffer = await blob.arrayBuffer()
  const ctx = getDecodeContext()
  const audioBuffer = await withTimeout(
    ctx.decodeAudioData(arrayBuffer.slice(0)),
    AUDIO_DECODE_TIMEOUT_MS,
    'Audio decoding timed out.',
  )
  assertDecodedAudioNotEmpty(audioBuffer)
  return audioBuffer
}

export const encodeAudioBufferSliceToWav = (
  audioBuffer: AudioBuffer,
  startMs: number,
  endMs: number,
): Blob => {
  assertDecodedAudioNotEmpty(audioBuffer)
  const sampleRate = audioBuffer.sampleRate
  const fromFrame = clampFrame(
    Math.floor((startMs / 1000) * sampleRate),
    audioBuffer.length,
  )
  const toFrame = clampFrame(
    Math.ceil((endMs / 1000) * sampleRate),
    audioBuffer.length,
  )
  const frameCount = Math.max(1, toFrame - fromFrame)
  const ctx = getDecodeContext()
  const slice = ctx.createBuffer(
    audioBuffer.numberOfChannels,
    frameCount,
    sampleRate,
  )
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const source = audioBuffer.getChannelData(ch).subarray(fromFrame, toFrame)
    slice.copyToChannel(source, ch, 0)
  }
  return encodePcm16Wav(slice, ASR_WAV_SAMPLE_RATE)
}

export const estimatePcm16WavByteLength = (durationMs: number): number =>
  44 + estimatePcm16RawByteLength(durationMs, ASR_WAV_SAMPLE_RATE)

const assertDecodedAudioNotEmpty = (audioBuffer: AudioBuffer): void => {
  if (audioBuffer.length > 0 && audioBuffer.numberOfChannels > 0) return
  throw new Error(
    'Decoded audio is empty; cannot transcode an empty recording.',
  )
}

const clampFrame = (frame: number, maxFrame: number): number =>
  Math.min(maxFrame, Math.max(0, frame))

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeout: number | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = window.setTimeout(() => {
          reject(new Error(message))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== null) window.clearTimeout(timeout)
  }
}

/**
 * Encode an `AudioBuffer` to a 16-bit PCM WAV blob.
 *
 * Layout (https://docs.fileformat.com/audio/wav/):
 *   RIFF header (12 bytes)
 *   fmt chunk (24 bytes, PCM)
 *   data chunk (8 bytes + samples * 2 * channels)
 */
const encodePcm16Wav = (
  audioBuffer: AudioBuffer,
  targetSampleRate: number,
): Blob => {
  const audio = encodePcm16Raw(audioBuffer, targetSampleRate)
  const numChannels = 1
  const sampleRate = targetSampleRate
  const dataBytes = audio.byteLength
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  // RIFF header
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')

  // fmt chunk
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * BYTES_PER_SAMPLE, true)
  view.setUint16(32, numChannels * BYTES_PER_SAMPLE, true) // block align
  view.setUint16(34, SAMPLE_BITS, true)

  // data chunk header
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  new Uint8Array(buffer, 44).set(new Uint8Array(audio))

  return new Blob([buffer], { type: 'audio/wav' })
}

const encodePcm16Raw = (
  audioBuffer: AudioBuffer,
  targetSampleRate: number,
): ArrayBuffer => {
  const mono = mixToMono(audioBuffer)
  const ratio = audioBuffer.sampleRate / targetSampleRate
  const outputLength = Math.max(1, Math.ceil(mono.length / ratio))
  const buffer = new ArrayBuffer(outputLength * BYTES_PER_SAMPLE)
  const view = new DataView(buffer)
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = Math.min(mono.length - 1, Math.floor(i * ratio))
    writePcm16Sample(view, i * BYTES_PER_SAMPLE, mono[sourceIndex])
  }
  return buffer
}

const estimatePcm16RawByteLength = (
  durationMs: number,
  sampleRate: number,
): number => {
  const frames = Math.max(1, Math.ceil((durationMs / 1000) * sampleRate))
  return frames * BYTES_PER_SAMPLE
}

const mixToMono = (audioBuffer: AudioBuffer): Float32Array => {
  const numChannels = audioBuffer.numberOfChannels
  const numFrames = audioBuffer.length
  if (numChannels === 1) {
    return audioBuffer.getChannelData(0).slice()
  }
  const out = new Float32Array(numFrames)
  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch)
    for (let i = 0; i < numFrames; i++) {
      out[i] += data[i] / numChannels
    }
  }
  return out
}

const writePcm16Sample = (
  view: DataView,
  offset: number,
  value: number,
): void => {
  let sample = value
  if (sample > 1) sample = 1
  else if (sample < -1) sample = -1
  const intSample =
    sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
  view.setInt16(offset, intSample, true)
}

const writeAscii = (view: DataView, offset: number, text: string): void => {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}
