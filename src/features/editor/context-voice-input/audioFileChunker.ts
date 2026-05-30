import { encodeAudioBufferSliceToWav } from '../../../core/asr/audioTranscode'

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
  maxChunkDurationMs: number | null
}): AudioFileChunkSchedule {
  const totalMs = Math.max(1, Math.round(input.audioBuffer.duration * 1000))
  const targetMs = clampInt(input.targetDurationSec, 15, 600) * 1000
  const overlapMs = clampInt(input.overlapMs, 0, 1500)
  const maxDurationMs =
    input.maxChunkDurationMs === null
      ? null
      : Math.max(1000, input.maxChunkDurationMs - overlapMs * 2)
  const effectiveChunkDurationMs = Math.max(
    1000,
    Math.min(targetMs, maxDurationMs ?? targetMs),
  )

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
  return schedule.chunks.map((entry) =>
    createAudioFileChunk(audioBuffer, entry),
  )
}

export function createAudioFileChunk(
  audioBuffer: AudioBuffer,
  entry: AudioFileChunkScheduleEntry,
): AudioFileChunk {
  return {
    ...entry,
    blob: encodeAudioBufferSliceToWav(
      audioBuffer,
      entry.actualStartMs,
      entry.actualEndMs,
    ),
    mimeType: 'audio/wav',
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}
