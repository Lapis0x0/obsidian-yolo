import { decodeAudioBlob } from '../../../core/asr/audioTranscode'

import type { AudioFileSource } from './audioFileSource'

const ACCEPTED_AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'mp4',
  'wav',
  'webm',
  'ogg',
  'opus',
  'flac',
  'aac',
  'amr',
])

export type AudioFileInspection = {
  source: AudioFileSource
  mimeType: string
  extension: string
  fileSizeBytes: number
  durationMs: number | null
  decodedAudio: AudioBuffer | null
  canDecodeLocally: boolean
}

export type AudioFileInspectionOptions = {
  decode?: boolean
}

export async function inspectAudioFile(
  source: AudioFileSource,
  options: AudioFileInspectionOptions = {},
): Promise<AudioFileInspection> {
  const mimeType = (source.type || '').trim()
  const extension = getFileExtension(source.name)
  if (!isAcceptedAudioFile({ mimeType, extension })) {
    throw new Error('Only local audio files can be transcribed.')
  }
  if (source.size <= 0) {
    throw new Error('The audio file is empty.')
  }

  let durationMs = await probeAudioDurationMs(source)
  let decodedAudio: AudioBuffer | null = null
  if (options.decode) {
    const file = await source.getFile()
    try {
      decodedAudio = await decodeAudioBlob(file)
    } catch {
      // Some providers can read containers the browser cannot decode. Keep the
      // file eligible for direct upload, but mark it as not locally chunkable.
    }
  }

  durationMs = decodedAudio
    ? Math.round(decodedAudio.duration * 1000)
    : durationMs
  if (durationMs !== null && durationMs <= 0) {
    throw new Error('The audio file has no playable duration.')
  }

  return {
    source,
    mimeType,
    extension,
    fileSizeBytes: source.size,
    durationMs,
    decodedAudio,
    canDecodeLocally: decodedAudio !== null,
  }
}

function isAcceptedAudioFile(input: {
  mimeType: string
  extension: string
}): boolean {
  const mimeType = input.mimeType.toLowerCase()
  if (mimeType.startsWith('video/')) return false
  if (mimeType.startsWith('audio/')) return true
  if (mimeType.length > 0) return false
  return ACCEPTED_AUDIO_EXTENSIONS.has(input.extension)
}

function getFileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.')
  if (idx < 0 || idx === fileName.length - 1) return ''
  return fileName.slice(idx + 1).toLowerCase()
}

async function probeAudioDurationMs(
  source: AudioFileSource,
): Promise<number | null> {
  if (typeof Audio === 'undefined') return null
  const objectUrl = await source.createObjectUrl()
  if (!objectUrl) return null

  const audio = new Audio()
  audio.preload = 'metadata'
  audio.src = objectUrl.url

  return new Promise((resolve) => {
    let settled = false
    let timeout: number | null = null
    const cleanup = () => {
      if (settled) return
      settled = true
      if (timeout !== null) window.clearTimeout(timeout)
      audio.removeAttribute('src')
      audio.load()
      objectUrl.revoke()
    }
    const finish = (value: number | null) => {
      cleanup()
      resolve(value)
    }
    audio.onloadedmetadata = () => {
      const duration = audio.duration
      finish(
        Number.isFinite(duration) && duration > 0
          ? Math.round(duration * 1000)
          : null,
      )
    }
    audio.onerror = () => finish(null)
    timeout = window.setTimeout(() => finish(null), 3000)
  })
}
