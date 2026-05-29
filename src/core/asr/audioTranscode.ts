/**
 * Client-side audio transcoder for the chat-audio ASR path.
 *
 * Why this exists:
 *   - MediaRecorder hands us a webm/opus blob.
 *   - Google's chat-audio endpoint rejects webm with
 *     "Invalid audio format. Valid formats are: [wav, mp3]".
 *
 * Strategy: decode via the host's AudioContext (Obsidian runs on Electron, so
 * Web Audio is available), then write a 16-bit PCM WAV by hand. No external
 * encoder dependency, no main-thread blocking beyond the decode itself
 * (browser-native, very fast for ≤120 s clips).
 *
 * We do NOT offer mp3 transcoding: it would require ~150 KB of lamejs in the
 * bundle and adds an extra lossy hop on top of an already-lossy opus capture.
 * WAV is universally accepted by chat-audio providers (OpenAI, Google, Qwen3,
 * FireRedASR2) and remains lossless re-packaging of the captured PCM.
 */

import type { AsrAudioInput } from './types'

const SAMPLE_BITS = 16
const BYTES_PER_SAMPLE = SAMPLE_BITS / 8

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
  const arrayBuffer = await input.blob.arrayBuffer()
  const ctx = getDecodeContext()
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
  assertDecodedAudioNotEmpty(audioBuffer)

  const wavBlob = encodePcm16Wav(audioBuffer)
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
  const arrayBuffer = await input.blob.arrayBuffer()
  const ctx = getDecodeContext()
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
  assertDecodedAudioNotEmpty(audioBuffer)
  return {
    audio: encodePcm16Raw(audioBuffer, targetSampleRate),
    sampleRate: targetSampleRate,
    durationMs: Math.round(audioBuffer.duration * 1000),
  }
}

const assertDecodedAudioNotEmpty = (audioBuffer: AudioBuffer): void => {
  if (audioBuffer.length > 0 && audioBuffer.numberOfChannels > 0) return
  throw new Error(
    'Decoded audio is empty; cannot transcode an empty recording.',
  )
}

/**
 * Encode an `AudioBuffer` to a 16-bit PCM WAV blob.
 *
 * Layout (https://docs.fileformat.com/audio/wav/):
 *   RIFF header (12 bytes)
 *   fmt chunk (24 bytes, PCM)
 *   data chunk (8 bytes + samples * 2 * channels)
 */
const encodePcm16Wav = (audioBuffer: AudioBuffer): Blob => {
  const numChannels = audioBuffer.numberOfChannels
  const sampleRate = audioBuffer.sampleRate
  const numFrames = audioBuffer.length

  const dataBytes = numFrames * numChannels * BYTES_PER_SAMPLE
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

  // Interleave channels: L R L R L R …  (mono just gives a flat stream).
  // We read channel by channel into typed arrays to avoid per-sample
  // function call overhead from getChannelData on every frame.
  const channelData: Float32Array[] = []
  for (let ch = 0; ch < numChannels; ch++) {
    channelData.push(audioBuffer.getChannelData(ch))
  }

  let offset = 44
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = channelData[ch][frame]
      // clamp to [-1, 1] before quantising to int16
      if (sample > 1) sample = 1
      else if (sample < -1) sample = -1
      const intSample =
        sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
      view.setInt16(offset, intSample, true)
      offset += 2
    }
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

const encodePcm16Raw = (
  audioBuffer: AudioBuffer,
  targetSampleRate: number,
): ArrayBuffer => {
  const mono = mixToMono(audioBuffer)
  const ratio = audioBuffer.sampleRate / targetSampleRate
  const outputLength = Math.max(1, Math.floor(mono.length / ratio))
  const buffer = new ArrayBuffer(outputLength * BYTES_PER_SAMPLE)
  const view = new DataView(buffer)
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = Math.min(mono.length - 1, Math.floor(i * ratio))
    writePcm16Sample(view, i * BYTES_PER_SAMPLE, mono[sourceIndex])
  }
  return buffer
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
