import {
  encodeAudioBufferSliceToWav,
  estimatePcm16WavByteLength,
} from '../../../core/asr/audioTranscode'

export type AudioFileChunk = {
  index: number
  startMs: number
  endMs: number
  actualStartMs: number
  actualEndMs: number
  blob: Blob
  mimeType: string
}

export type AudioFileChunkScheduleEntry = {
  index: number
  startMs: number
  endMs: number
  actualStartMs: number
  actualEndMs: number
}

export type AudioFileChunkSchedule = {
  chunks: AudioFileChunkScheduleEntry[]
  effectiveChunkDurationMs: number
}

export function buildAudioFileChunkSchedule(input: {
  audioBuffer: AudioBuffer
  targetDurationSec: number
  overlapMs: number
  maxChunkBytes: number | null
}): AudioFileChunkSchedule {
  const totalMs = Math.max(1, Math.round(input.audioBuffer.duration * 1000))
  const targetMs = clampInt(input.targetDurationSec, 60, 600) * 1000
  const overlapMs = clampInt(input.overlapMs, 0, 1500)
  const maxPayloadDurationMs =
    input.maxChunkBytes && input.maxChunkBytes > 44
      ? estimateMaxDurationMs(input.audioBuffer, input.maxChunkBytes)
      : null
  const maxDurationMs =
    maxPayloadDurationMs === null
      ? null
      : Math.max(1000, maxPayloadDurationMs - overlapMs * 2)
  const effectiveChunkDurationMs = Math.max(
    1000,
    Math.min(targetMs, maxDurationMs ?? targetMs),
  )
  if (
    input.maxChunkBytes &&
    estimatePcm16WavByteLength(input.audioBuffer, 1000 + overlapMs * 2) >
      input.maxChunkBytes
  ) {
    throw new Error('Audio chunks would exceed the provider request limit.')
  }

  const chunks: AudioFileChunkScheduleEntry[] = []
  let startMs = 0
  while (startMs < totalMs) {
    const endMs = Math.min(totalMs, startMs + effectiveChunkDurationMs)
    chunks.push({
      index: chunks.length,
      startMs,
      endMs,
      actualStartMs: Math.max(0, startMs - (chunks.length > 0 ? overlapMs : 0)),
      actualEndMs: Math.min(totalMs, endMs + (endMs < totalMs ? overlapMs : 0)),
    })
    startMs = endMs
  }

  return { chunks, effectiveChunkDurationMs }
}

export function createAudioFileChunks(
  audioBuffer: AudioBuffer,
  schedule: AudioFileChunkSchedule,
): AudioFileChunk[] {
  return schedule.chunks.map((entry) => ({
    ...entry,
    blob: encodeAudioBufferSliceToWav(
      audioBuffer,
      entry.actualStartMs,
      entry.actualEndMs,
    ),
    mimeType: 'audio/wav',
  }))
}

function estimateMaxDurationMs(
  audioBuffer: AudioBuffer,
  maxChunkBytes: number,
): number {
  let low = 1000
  let high = Math.max(1000, Math.floor(audioBuffer.duration * 1000))
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimatePcm16WavByteLength(audioBuffer, mid) <= maxChunkBytes) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return low
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}
