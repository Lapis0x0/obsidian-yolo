import { decodeAudioBlob } from '../../../core/asr/audioTranscode'

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
  file: File
  mimeType: string
  extension: string
  durationMs: number | null
  decodedAudio: AudioBuffer | null
  canDecodeLocally: boolean
}

export async function inspectAudioFile(
  file: File,
): Promise<AudioFileInspection> {
  const mimeType = (file.type || '').trim()
  const extension = getFileExtension(file.name)
  if (!isAcceptedAudioFile({ mimeType, extension })) {
    throw new Error('Only local audio files can be transcribed.')
  }
  if (file.size <= 0) {
    throw new Error('The audio file is empty.')
  }

  let decodedAudio: AudioBuffer | null = null
  try {
    decodedAudio = await decodeAudioBlob(file)
  } catch {
    // Some providers can read containers the browser cannot decode. Keep the
    // file eligible for direct upload, but mark it as not locally chunkable.
  }

  const durationMs = decodedAudio
    ? Math.round(decodedAudio.duration * 1000)
    : null
  if (durationMs !== null && durationMs <= 0) {
    throw new Error('The audio file has no playable duration.')
  }

  return {
    file,
    mimeType,
    extension,
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
