import {
  estimatePcm16WavByteLength,
  transcodeToPcm16,
} from '../../../core/asr/audioTranscode'
import { getAudioFileAsrCapability } from '../../../core/asr/capabilities'
import {
  buildAsrProviderForConfig,
  resolveActiveAudioFileAsrConfig,
} from '../../../core/asr/manager'
import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../../settings/schema/setting.types'

import {
  type AudioFileChunk,
  type AudioFileChunkSchedule,
  buildAudioFileChunkSchedule,
  createAudioFileChunk,
} from './audioFileChunker'
import {
  type AudioFileInspection,
  inspectAudioFile,
} from './audioFileInspector'

export type AudioFileSubmissionMode =
  | 'direct-upload'
  | 'chunked-upload'
  | 'websocket-stream'

export type AudioFileTranscriptionPlan = {
  mode: AudioFileSubmissionMode
  fileName: string
  fileSizeBytes: number
  mimeType: string
  durationMs: number | null
  providerConfig: AsrConfig
  schedule: AudioFileChunkSchedule | null
  maxConcurrentChunks: number
  chunkStartStaggerMs: number
  chunkOverlapMs: number
  targetChunkDurationSec: number
  inspection: AudioFileInspection
}

export type AudioFileTranscriptionProgress = {
  phase: 'preparing' | 'uploading' | 'transcribing' | 'inserting'
  completedChunks?: number
  totalChunks?: number
  sentBytes?: number
  totalBytes?: number
  finalTextChars?: number
}

export type OrderedAudioFileText = {
  text: string
  chunkIndex: number | null
  chunkStartMs: number | null
}

export type AudioFileTranscriptionMessages = {
  noProvider: string
  longAudioNotImplemented: string
  unsupportedLocalFile: string
  unsupportedChunking: string
  decodeRequiredForChunking: string
  missingChunkPlan: string
  chunkFailed: string
  streamingUnsupported: string
  directChunkDurationHint: (seconds: number) => string
  chunkedChunkDurationHint: (seconds: number) => string
  providerGenericDurationHint: string
  providerMaxDurationHint: (seconds: number) => string
}

const DEFAULT_MESSAGES: AudioFileTranscriptionMessages = {
  noProvider:
    'No ASR provider is configured. Add one under Models -> Voice recognition.',
  longAudioNotImplemented:
    'Long-audio ASR provider adapters are not implemented yet.',
  unsupportedLocalFile:
    'The selected ASR provider cannot transcribe local files.',
  unsupportedChunking:
    'The selected ASR provider cannot split this audio file.',
  decodeRequiredForChunking:
    'This file is too large for one request and cannot be decoded locally for chunking.',
  missingChunkPlan: 'Missing chunk plan for audio file transcription.',
  chunkFailed: 'Chunk failed.',
  streamingUnsupported: 'The selected ASR provider does not support streaming.',
  directChunkDurationHint: (seconds) =>
    `If this is a provider upload-size limit, choose a shorter Audio file chunk duration (currently ${seconds}s) so the file is split before upload.`,
  chunkedChunkDurationHint: (seconds) =>
    `If this is a provider upload-size limit, lower Audio file chunk duration (currently ${seconds}s).`,
  providerGenericDurationHint: 'Some providers need shorter WAV chunks.',
  providerMaxDurationHint: (seconds) =>
    `This provider may need WAV chunks at ${seconds}s or less.`,
}

export async function inspectAndPlanAudioFileTranscription(input: {
  file: File
  options: ContextVoiceInputOptions
  messages?: AudioFileTranscriptionMessages
}): Promise<AudioFileTranscriptionPlan> {
  const messages = input.messages ?? DEFAULT_MESSAGES
  const providerConfig = resolveActiveAudioFileAsrConfig(input.options)
  if (!providerConfig) {
    throw new Error(messages.noProvider)
  }
  if (providerConfig.asrCategory === 'http-long-audio') {
    throw new Error(messages.longAudioNotImplemented)
  }

  const inspection = await inspectAudioFile(input.file)
  const capability = getAudioFileAsrCapability(providerConfig)
  if (!capability.supportsLocalFile) {
    throw new Error(messages.unsupportedLocalFile)
  }

  const targetChunkDurationSec = clampInt(
    input.options.audioFileChunkTargetDurationSec,
    15,
    600,
  )
  const chunkOverlapMs = clampInt(
    input.options.audioFileChunkOverlapMs,
    0,
    1500,
  )
  const maxConcurrentChunks = clampInt(
    input.options.audioFileMaxConcurrentChunks,
    1,
    5,
  )
  const chunkStartStaggerMs = clampInt(
    input.options.audioFileChunkStartStaggerMs,
    1000,
    3000,
  )

  if (capability.supportsFileStreaming) {
    return {
      mode: 'websocket-stream',
      fileName: input.file.name,
      fileSizeBytes: input.file.size,
      mimeType: inspection.mimeType || input.file.type || 'audio/*',
      durationMs: inspection.durationMs,
      providerConfig,
      schedule: null,
      maxConcurrentChunks: 1,
      chunkStartStaggerMs,
      chunkOverlapMs: 0,
      targetChunkDurationSec,
      inspection,
    }
  }

  const maxBytes = capability.maxRequestBytes
  const maxDurationMs = capability.maxDurationMs
  const effectiveSingleRequestBytes = estimateSingleRequestBytes({
    file: input.file,
    inspection,
    providerConfig,
  })
  const exceedsSingleRequest =
    maxBytes !== null && effectiveSingleRequestBytes > maxBytes
  const exceedsProviderDuration =
    maxDurationMs !== null &&
    inspection.durationMs !== null &&
    inspection.durationMs > maxDurationMs
  const exceedsTargetDuration =
    inspection.durationMs !== null &&
    inspection.durationMs > targetChunkDurationSec * 1000

  if (
    !exceedsSingleRequest &&
    !exceedsProviderDuration &&
    !exceedsTargetDuration
  ) {
    return {
      mode: 'direct-upload',
      fileName: input.file.name,
      fileSizeBytes: input.file.size,
      mimeType: inspection.mimeType || input.file.type || 'audio/*',
      durationMs: inspection.durationMs,
      providerConfig,
      schedule: null,
      maxConcurrentChunks: 1,
      chunkStartStaggerMs,
      chunkOverlapMs,
      targetChunkDurationSec,
      inspection,
    }
  }

  if (!capability.supportsChunkedUpload) {
    throw new Error(messages.unsupportedChunking)
  }
  if (!inspection.decodedAudio) {
    throw new Error(messages.decodeRequiredForChunking)
  }

  const schedule = buildAudioFileChunkSchedule({
    audioBuffer: inspection.decodedAudio,
    targetDurationSec: targetChunkDurationSec,
    overlapMs: chunkOverlapMs,
    maxChunkDurationMs: maxDurationMs,
  })

  return {
    mode: 'chunked-upload',
    fileName: input.file.name,
    fileSizeBytes: input.file.size,
    mimeType: inspection.mimeType || input.file.type || 'audio/*',
    durationMs: inspection.durationMs,
    providerConfig,
    schedule,
    maxConcurrentChunks,
    chunkStartStaggerMs,
    chunkOverlapMs,
    targetChunkDurationSec,
    inspection,
  }
}

export async function executeAudioFileTranscriptionPlan(input: {
  plan: AudioFileTranscriptionPlan
  signal: AbortSignal
  onProgress: (progress: AudioFileTranscriptionProgress) => void
  onText: (result: OrderedAudioFileText) => Promise<void>
  messages?: AudioFileTranscriptionMessages
}): Promise<void> {
  switch (input.plan.mode) {
    case 'direct-upload':
      await executeDirectUpload(input)
      return
    case 'chunked-upload':
      await executeChunkedUpload(input)
      return
    case 'websocket-stream':
      await executeWebSocketStream(input)
      return
    default: {
      const exhaustive: never = input.plan.mode
      return exhaustive
    }
  }
}

export function trimDuplicateChunkBoundary(
  previousText: string,
  nextText: string,
): string {
  const previous = previousText.trim()
  const next = nextText.trim()
  if (!previous || !next) return nextText
  const previousWords = previous.split(/\s+/)
  const nextWords = next.split(/\s+/)
  const maxWords = Math.min(8, previousWords.length, nextWords.length)
  for (let count = maxWords; count >= 2; count--) {
    const prevTail = previousWords.slice(previousWords.length - count).join(' ')
    const nextHead = nextWords.slice(0, count).join(' ')
    if (prevTail === nextHead) {
      return nextWords.slice(count).join(' ')
    }
  }
  return nextText
}

async function executeDirectUpload(input: {
  plan: AudioFileTranscriptionPlan
  signal: AbortSignal
  onProgress: (progress: AudioFileTranscriptionProgress) => void
  onText: (result: OrderedAudioFileText) => Promise<void>
  messages?: AudioFileTranscriptionMessages
}): Promise<void> {
  const provider = buildAsrProviderForConfig(input.plan.providerConfig)
  input.onProgress({ phase: 'uploading', completedChunks: 0, totalChunks: 1 })
  let result: Awaited<ReturnType<typeof provider.transcribe>>
  try {
    result = await provider.transcribe(
      {
        blob: input.plan.inspection.file,
        mimeType: input.plan.mimeType || input.plan.inspection.file.type,
        durationMs: input.plan.durationMs ?? undefined,
      },
      {
        language: input.plan.providerConfig.language,
        signal: input.signal,
      },
    )
  } catch (error) {
    throw withChunkDurationHint(error, input.plan, {
      requestMode: 'direct',
      messages: input.messages,
    })
  }
  throwIfAborted(input.signal)
  input.onProgress({ phase: 'inserting', completedChunks: 1, totalChunks: 1 })
  await input.onText({
    text: result.text,
    chunkIndex: null,
    chunkStartMs: null,
  })
}

async function executeChunkedUpload(input: {
  plan: AudioFileTranscriptionPlan
  signal: AbortSignal
  onProgress: (progress: AudioFileTranscriptionProgress) => void
  onText: (result: OrderedAudioFileText) => Promise<void>
  messages?: AudioFileTranscriptionMessages
}): Promise<void> {
  const { plan, signal, onProgress, onText } = input
  const messages = input.messages ?? DEFAULT_MESSAGES
  if (!plan.schedule || !plan.inspection.decodedAudio) {
    throw new Error(messages.missingChunkPlan)
  }
  const decodedAudio = plan.inspection.decodedAudio

  onProgress({
    phase: 'preparing',
    completedChunks: 0,
    totalChunks: plan.schedule.chunks.length,
  })
  await yieldToBrowser(signal)
  const entries = plan.schedule.chunks
  const provider = buildAsrProviderForConfig(plan.providerConfig)
  const results = new Map<number, OrderedAudioFileText>()
  let nextChunkIndex = 0
  let completedChunks = 0
  let launchCount = 0
  let launchGate = Promise.resolve()

  const queue = entries.slice()
  const workers = Array.from(
    { length: Math.min(plan.maxConcurrentChunks, entries.length) },
    async () => {
      while (queue.length > 0) {
        throwIfAborted(signal)
        const entry = queue.shift()
        if (!entry) return
        launchGate = launchGate.then(async () => {
          if (launchCount > 0) {
            await delay(plan.chunkStartStaggerMs, signal)
          }
          launchCount += 1
        })
        await launchGate
        throwIfAborted(signal)

        onProgress({
          phase: 'uploading',
          completedChunks,
          totalChunks: entries.length,
        })
        await yieldToBrowser(signal)
        const chunk = createAudioFileChunk(decodedAudio, entry)
        const text = await transcribeChunkWithRetry({
          provider,
          chunk,
          plan,
          signal,
          messages,
        })
        completedChunks += 1
        results.set(chunk.index, {
          text,
          chunkIndex: chunk.index,
          chunkStartMs: chunk.startMs,
        })
        while (results.has(nextChunkIndex)) {
          const ordered = results.get(nextChunkIndex)!
          results.delete(nextChunkIndex)
          onProgress({
            phase: 'inserting',
            completedChunks,
            totalChunks: entries.length,
          })
          await onText(ordered)
          nextChunkIndex += 1
        }
        onProgress({
          phase: 'uploading',
          completedChunks,
          totalChunks: entries.length,
        })
      }
    },
  )

  await Promise.all(workers)
}

async function transcribeChunkWithRetry(input: {
  provider: ReturnType<typeof buildAsrProviderForConfig>
  chunk: AudioFileChunk
  plan: AudioFileTranscriptionPlan
  signal: AbortSignal
  messages: AudioFileTranscriptionMessages
}): Promise<string> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await input.provider.transcribe(
        {
          blob: input.chunk.blob,
          mimeType: input.chunk.mimeType,
          durationMs: input.chunk.actualEndMs - input.chunk.actualStartMs,
        },
        {
          language: input.plan.providerConfig.language,
          signal: input.signal,
        },
      )
      throwIfAborted(input.signal)
      return result.text
    } catch (error) {
      if (input.signal.aborted) throw error
      lastError = error
      if (attempt === 0) await delay(1000, input.signal)
    }
  }
  throw withChunkDurationHint(
    lastError instanceof Error
      ? lastError
      : new Error(input.messages.chunkFailed),
    input.plan,
    { messages: input.messages },
  )
}

async function executeWebSocketStream(input: {
  plan: AudioFileTranscriptionPlan
  signal: AbortSignal
  onProgress: (progress: AudioFileTranscriptionProgress) => void
  onText: (result: OrderedAudioFileText) => Promise<void>
  messages?: AudioFileTranscriptionMessages
}): Promise<void> {
  const messages = input.messages ?? DEFAULT_MESSAGES
  const provider = buildAsrProviderForConfig(input.plan.providerConfig)
  if (typeof provider.startStreaming !== 'function') {
    throw new Error(messages.streamingUnsupported)
  }

  let emittedFinalText = ''
  let latestText = ''
  let pendingFlush = Promise.resolve()
  const emitFinal = (combined: string) => {
    const delta = diffAppendedText(emittedFinalText, combined)
    latestText = combined
    if (!delta.trim()) return
    emittedFinalText = combined
    pendingFlush = pendingFlush.then(() =>
      input.onText({
        text: delta,
        chunkIndex: null,
        chunkStartMs: null,
      }),
    )
    void pendingFlush.catch(() => {
      // The final await below owns surfacing insertion failures; this handler
      // only prevents an early unhandled-rejection report while streaming.
    })
  }

  const session = await provider.startStreaming(
    {
      language: input.plan.providerConfig.language,
      purpose: 'audio-file-transcription',
      signal: input.signal,
    },
    {
      onPartial: (text) => {
        latestText = text
        input.onProgress({
          phase: 'transcribing',
          finalTextChars: emittedFinalText.length,
        })
      },
      onFinal: emitFinal,
    },
  )

  try {
    await sendFileThroughStreamingSession({
      plan: input.plan,
      session,
      signal: input.signal,
      onProgress: input.onProgress,
    })
    const result = await session.finish()
    emitFinal(result.text || latestText)
    await pendingFlush
  } catch (error) {
    try {
      session.cancel()
    } catch {
      // Best-effort; the original error is more useful.
    }
    throw error
  }
}

async function sendFileThroughStreamingSession(input: {
  plan: AudioFileTranscriptionPlan
  session: {
    sendAudioChunk(chunk: Blob | ArrayBuffer): void
  }
  signal: AbortSignal
  onProgress: (progress: AudioFileTranscriptionProgress) => void
}): Promise<void> {
  const { plan, session, signal, onProgress } = input
  let lastProgressPct = -1
  const reportProgress = (sentBytes: number, totalBytes: number) => {
    const pct =
      totalBytes > 0 ? Math.round((sentBytes / totalBytes) * 100) : 100
    if (pct === lastProgressPct && sentBytes < totalBytes) return
    lastProgressPct = pct
    onProgress({
      phase: 'uploading',
      sentBytes,
      totalBytes,
    })
  }
  if (plan.providerConfig.audioFormat === 'wav') {
    const pcm = await transcodeToPcm16({
      blob: plan.inspection.file,
      mimeType: plan.mimeType,
      durationMs: plan.durationMs ?? undefined,
    })
    const frameMs = 250
    const bytesPerMs = (pcm.sampleRate * 2) / 1000
    const frameBytes = Math.max(2, Math.floor(frameMs * bytesPerMs))
    for (let offset = 0; offset < pcm.audio.byteLength; offset += frameBytes) {
      throwIfAborted(signal)
      const end = Math.min(pcm.audio.byteLength, offset + frameBytes)
      session.sendAudioChunk(pcm.audio.slice(offset, end))
      reportProgress(end, pcm.audio.byteLength)
      await delay(40, signal)
    }
    return
  }

  const bytes = await plan.inspection.file.arrayBuffer()
  const frameBytes = 64 * 1024
  for (let offset = 0; offset < bytes.byteLength; offset += frameBytes) {
    throwIfAborted(signal)
    const end = Math.min(bytes.byteLength, offset + frameBytes)
    session.sendAudioChunk(bytes.slice(offset, end))
    reportProgress(end, bytes.byteLength)
    await delay(100, signal)
  }
}

function diffAppendedText(previous: string, next: string): string {
  if (!previous) return next
  if (next.startsWith(previous)) return next.slice(previous.length)
  if (previous.startsWith(next)) return ''
  return next
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal.aborted)
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(timeout)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function yieldToBrowser(signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const done = () => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      resolve()
    }
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => done())
    } else {
      globalThis.setTimeout(done, 0)
    }
  })
}

function estimateSingleRequestBytes(input: {
  file: File
  inspection: AudioFileInspection
  providerConfig: AsrConfig
}): number {
  if (
    input.providerConfig.audioFormat === 'wav' &&
    input.inspection.decodedAudio &&
    input.inspection.durationMs !== null
  ) {
    return estimatePcm16WavByteLength(
      input.inspection.decodedAudio,
      input.inspection.durationMs,
    )
  }
  return input.file.size
}

function withChunkDurationHint(
  error: unknown,
  plan: AudioFileTranscriptionPlan,
  options: {
    requestMode?: 'direct' | 'chunked'
    messages?: AudioFileTranscriptionMessages
  } = {},
): Error {
  if (isAbortError(error)) return error
  const messages = options.messages ?? DEFAULT_MESSAGES
  const message = error instanceof Error ? error.message : String(error)
  const providerMaxMs = getAudioFileAsrCapability(
    plan.providerConfig,
  ).maxDurationMs
  const providerMaxSec =
    providerMaxMs === null ? null : Math.floor(providerMaxMs / 1000)
  const providerHint =
    providerMaxSec === null
      ? messages.providerGenericDurationHint
      : messages.providerMaxDurationHint(providerMaxSec)
  const chunkHint =
    options.requestMode === 'direct'
      ? messages.directChunkDurationHint(plan.targetChunkDurationSec)
      : messages.chunkedChunkDurationHint(plan.targetChunkDurationSec)
  return new Error(`${message}\n\n${chunkHint} ${providerHint}`)
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError'
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}
