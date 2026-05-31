import { decodeAudioBlob } from '../../../../core/asr/audioTranscode'

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
  mp4MoovPosition: Mp4MoovPosition | null
  decodedAudio: AudioBuffer | null
  canDecodeLocally: boolean
}

export type AudioFileInspectionOptions = {
  decode?: boolean
}

export type Mp4MoovPosition = 'before-mdat' | 'after-mdat' | 'unknown'

type ContainerMetadata = {
  durationMs: number | null
  mp4MoovPosition: Mp4MoovPosition | null
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
  const containerMetadata = await probeContainerMetadata(source, extension)
  durationMs = durationMs ?? containerMetadata.durationMs
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
    mp4MoovPosition: containerMetadata.mp4MoovPosition,
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

async function probeContainerMetadata(
  source: AudioFileSource,
  extension: string,
): Promise<ContainerMetadata> {
  try {
    if (extension === 'wav') {
      return {
        durationMs: await probeWavDurationMs(source),
        mp4MoovPosition: null,
      }
    }
    if (extension === 'm4a' || extension === 'mp4') {
      return await probeMp4Metadata(source)
    }
  } catch {
    return { durationMs: null, mp4MoovPosition: null }
  }
  return { durationMs: null, mp4MoovPosition: null }
}

async function probeWavDurationMs(
  source: AudioFileSource,
): Promise<number | null> {
  const header = await readSourceBytes(source, 0, 12)
  if (
    header.length < 12 ||
    readAscii(header, 0, 4) !== 'RIFF' ||
    readAscii(header, 8, 12) !== 'WAVE'
  ) {
    return null
  }

  let offset = 12
  let byteRate: number | null = null
  let dataBytes: number | null = null
  for (let count = 0; count < 1024 && offset + 8 <= source.size; count++) {
    const chunkHeader = await readSourceBytes(source, offset, offset + 8)
    if (chunkHeader.length < 8) return null
    const chunkId = readAscii(chunkHeader, 0, 4)
    const chunkSize = readUint32Le(chunkHeader, 4)
    const chunkDataOffset = offset + 8
    if (chunkId === 'fmt ') {
      const fmt = await readSourceBytes(
        source,
        chunkDataOffset,
        chunkDataOffset + Math.min(chunkSize, 16),
      )
      if (fmt.length >= 12) byteRate = readUint32Le(fmt, 8)
    } else if (chunkId === 'data') {
      dataBytes = chunkSize
    }
    if (byteRate !== null && byteRate > 0 && dataBytes !== null) {
      return Math.round((dataBytes / byteRate) * 1000)
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2)
  }
  return null
}

// MP4 here means the ISO BMFF container used by m4a/mp4 audio files. This
// audio-only fallback mainly serves Obsidian sidebar drags, where vault
// resource URLs can fail browser metadata probing; video/* inputs are rejected
// before this path.
async function probeMp4Metadata(
  source: AudioFileSource,
): Promise<ContainerMetadata> {
  let offset = 0
  let seenMdat = false
  let mp4MoovPosition: Mp4MoovPosition = 'unknown'
  for (let count = 0; count < 2048 && offset + 8 <= source.size; count++) {
    const box = await readMp4BoxHeader(source, offset, source.size)
    if (!box) return { durationMs: null, mp4MoovPosition }
    if (box.type === 'mdat') seenMdat = true
    if (box.type === 'moov') {
      mp4MoovPosition = seenMdat ? 'after-mdat' : 'before-mdat'
      const durationMs = await probeMp4MoovDurationMs(
        source,
        offset + box.headerSize,
        offset + box.size,
      )
      return { durationMs, mp4MoovPosition }
    }
    offset += box.size
  }
  return { durationMs: null, mp4MoovPosition }
}

async function probeMp4MoovDurationMs(
  source: AudioFileSource,
  start: number,
  end: number,
): Promise<number | null> {
  let offset = start
  for (let count = 0; count < 2048 && offset + 8 <= end; count++) {
    const box = await readMp4BoxHeader(source, offset, end)
    if (!box) return null
    if (box.type === 'mvhd') {
      return await readMp4MovieHeaderDurationMs(
        source,
        offset + box.headerSize,
        offset + box.size,
      )
    }
    offset += box.size
  }
  return null
}

async function readMp4MovieHeaderDurationMs(
  source: AudioFileSource,
  start: number,
  end: number,
): Promise<number | null> {
  const payload = await readSourceBytes(
    source,
    start,
    Math.min(end, start + 32),
  )
  if (payload.length < 20) return null

  const version = payload[0]
  if (version === 0) {
    const timescale = readUint32Be(payload, 12)
    const duration = readUint32Be(payload, 16)
    return durationToMs(duration, timescale)
  }
  if (version === 1 && payload.length >= 32) {
    const timescale = readUint32Be(payload, 20)
    const duration = readUint64BeAsNumber(payload, 24)
    return duration === null ? null : durationToMs(duration, timescale)
  }
  return null
}

type Mp4BoxHeader = {
  type: string
  size: number
  headerSize: number
}

async function readMp4BoxHeader(
  source: AudioFileSource,
  offset: number,
  containerEnd: number,
): Promise<Mp4BoxHeader | null> {
  const header = await readSourceBytes(
    source,
    offset,
    Math.min(offset + 16, containerEnd),
  )
  if (header.length < 8) return null

  let size = readUint32Be(header, 0)
  const type = readAscii(header, 4, 8)
  let headerSize = 8
  if (size === 1) {
    if (header.length < 16) return null
    const largeSize = readUint64BeAsNumber(header, 8)
    if (largeSize === null) return null
    size = largeSize
    headerSize = 16
  } else if (size === 0) {
    size = containerEnd - offset
  }

  if (size < headerSize || offset + size > containerEnd) return null
  return { type, size, headerSize }
}

function durationToMs(duration: number, timescale: number): number | null {
  if (!Number.isFinite(duration) || timescale <= 0) return null
  const ms = Math.round((duration / timescale) * 1000)
  return ms > 0 ? ms : null
}

async function readSourceBytes(
  source: AudioFileSource,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const blob = await source.readSlice(start, end)
  return new Uint8Array(await blob.arrayBuffer())
}

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
    0,
    true,
  )
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
    0,
    false,
  )
}

function readUint64BeAsNumber(
  bytes: Uint8Array,
  offset: number,
): number | null {
  const high = readUint32Be(bytes, offset)
  const low = readUint32Be(bytes, offset + 4)
  if (high > 0x1f_ffff) return null
  return high * 0x1_0000_0000 + low
}
