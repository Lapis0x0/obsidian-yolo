import {
  estimatePcm16WavByteLength,
  transcodeToPcm16,
} from '../../../core/asr/audioTranscode'
import { getAudioFileAsrCapability } from '../../../core/asr/capabilities'
import {
  buildAsrProviderForConfig,
  resolveActiveAudioFileAsrConfig,
} from '../../../core/asr/manager'
import {
  ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
  ASR_WEBSOCKET_FILE_STREAMING_RATE_MAX,
  ASR_WEBSOCKET_FILE_STREAMING_RATE_MIN,
  type AsrConfig,
  type ContextVoiceInputOptions,
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
import type { AudioFileSource } from './audioFileSource'

export type AudioFileSubmissionMode =
  | 'direct-upload'
  | 'chunked-upload'
  | 'websocket-stream'

export type AudioFileTranscriptionPlan = {
  mode: AudioFileSubmissionMode
  source: AudioFileSource
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
  wavPcmUploadEstimateBytes: number | null
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
  replacePrevious?: boolean
  isFinal?: boolean
}

export const DEEPGRAM_MAX_STREAMING_REALTIME_RATE = 1.25

export type AudioFileTranscriptionMessages = {
  noProvider: string
  longAudioNotImplemented: string
  unsupportedLocalFile: string
  unsupportedChunking: string
  decodeRequiredForChunking: string
  localDecodeTooLarge: string
  webSocketPcmLargeUnsupported: string
  webSocketMp4TailMoovUnsupported: string
  wavPcmDurationLimitExceeded: (seconds: number) => string
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
  localDecodeTooLarge:
    'This audio file is too large for local processing. Use a long-audio provider.',
  webSocketPcmLargeUnsupported:
    'Large files cannot be streamed as WAV/PCM. Use a long-audio provider.',
  webSocketMp4TailMoovUnsupported:
    'This m4a/mp4 file cannot be streamed directly. Use a long-audio provider, or choose PCM 16k in the WebSocket provider.',
  wavPcmDurationLimitExceeded: (seconds) =>
    `WAV/PCM upload is limited to ${formatLimitMinutes(seconds)} minutes to avoid freezes and excessive upload traffic. Use a long-audio provider for longer files.`,
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
  source: AudioFileSource
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

  const capability = getAudioFileAsrCapability(providerConfig)
  const inspection = await inspectAudioFile(input.source, { decode: false })
  if (!capability.supportsLocalFile) {
    throw new Error(messages.unsupportedLocalFile)
  }
  const wavMaxDurationSec = clampInt(
    input.options.audioFileWavMaxDurationSec ?? 60 * 60,
    30,
    2 * 60 * 60,
  )

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
    if (
      providerConfig.audioFormat !== 'wav' &&
      inspection.mp4MoovPosition === 'after-mdat'
    ) {
      throw new Error(messages.webSocketMp4TailMoovUnsupported)
    }
    return {
      mode: 'websocket-stream',
      source: input.source,
      fileName: input.source.name,
      fileSizeBytes: input.source.size,
      mimeType: inspection.mimeType || input.source.type || 'audio/*',
      durationMs: inspection.durationMs,
      providerConfig,
      schedule: null,
      maxConcurrentChunks: 1,
      chunkStartStaggerMs,
      chunkOverlapMs: 0,
      targetChunkDurationSec,
      inspection,
      wavPcmUploadEstimateBytes: estimateWavPcmUploadBytes({
        mode: 'websocket-stream',
        providerConfig,
        inspection,
      }),
    }
  }

  const maxBytes = capability.maxRequestBytes
  const maxDurationMs = capability.maxDurationMs
  const effectiveSingleRequestBytes = estimateSingleRequestBytes({
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
  const requiresLocalTranscode = providerConfig.audioFormat === 'wav'

  assertWavPcmSendWithinDurationLimit({
    inspection,
    providerConfig,
    wavMaxDurationSec,
    messages,
  })

  if (
    requiresLocalTranscode &&
    !canDecodeLocallyWithinDurationLimit(inspection, wavMaxDurationSec)
  ) {
    throw new Error(messages.localDecodeTooLarge)
  }

  if (
    !exceedsSingleRequest &&
    !exceedsProviderDuration &&
    !exceedsTargetDuration
  ) {
    return {
      mode: 'direct-upload',
      source: input.source,
      fileName: input.source.name,
      fileSizeBytes: input.source.size,
      mimeType: inspection.mimeType || input.source.type || 'audio/*',
      durationMs: inspection.durationMs,
      providerConfig,
      schedule: null,
      maxConcurrentChunks: 1,
      chunkStartStaggerMs,
      chunkOverlapMs,
      targetChunkDurationSec,
      inspection,
      wavPcmUploadEstimateBytes: estimateWavPcmUploadBytes({
        mode: 'direct-upload',
        providerConfig,
        inspection,
      }),
    }
  }

  if (!capability.supportsChunkedUpload) {
    throw new Error(messages.unsupportedChunking)
  }
  assertWavPcmSendWithinDurationLimit({
    inspection,
    providerConfig,
    wavMaxDurationSec,
    messages,
    forceWavPcm: true,
  })
  if (!canDecodeLocallyWithinDurationLimit(inspection, wavMaxDurationSec)) {
    throw new Error(messages.localDecodeTooLarge)
  }

  const decodedInspection = await inspectAudioFile(input.source, {
    decode: true,
  })
  if (!decodedInspection.decodedAudio) {
    throw new Error(messages.decodeRequiredForChunking)
  }

  const schedule = buildAudioFileChunkSchedule({
    audioBuffer: decodedInspection.decodedAudio,
    targetDurationSec: targetChunkDurationSec,
    overlapMs: chunkOverlapMs,
    maxChunkDurationMs: maxDurationMs,
  })

  return {
    mode: 'chunked-upload',
    source: input.source,
    fileName: input.source.name,
    fileSizeBytes: input.source.size,
    mimeType: decodedInspection.mimeType || input.source.type || 'audio/*',
    durationMs: decodedInspection.durationMs,
    providerConfig,
    schedule,
    maxConcurrentChunks,
    chunkStartStaggerMs,
    chunkOverlapMs,
    targetChunkDurationSec,
    inspection: decodedInspection,
    wavPcmUploadEstimateBytes: estimateWavPcmUploadBytes({
      mode: 'chunked-upload',
      providerConfig,
      inspection: decodedInspection,
      schedule,
    }),
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
    const file = await input.plan.inspection.source.getFile()
    result = await provider.transcribe(
      {
        blob: file,
        mimeType: input.plan.mimeType || file.type,
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
  let emittedRevisionText = ''
  let pendingFlush = Promise.resolve()
  const useRevisionStreaming =
    input.plan.providerConfig.webSocketProtocol === 'whisperlivekit-native'
  const emitRevision = (text: string, isFinal: boolean) => {
    const combined = text.trim()
    if (!combined || (!isFinal && combined === emittedRevisionText)) return
    latestText = combined
    emittedRevisionText = combined
    pendingFlush = pendingFlush.then(() =>
      input.onText({
        text: combined,
        chunkIndex: null,
        chunkStartMs: null,
        replacePrevious: true,
        isFinal,
      }),
    )
    void pendingFlush.catch(() => {
      // The final await below owns surfacing insertion failures; this handler
      // only prevents an early unhandled-rejection report while streaming.
    })
  }
  const emitFinal = (combined: string) => {
    if (useRevisionStreaming) {
      emitRevision(combined, true)
      return
    }
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
        if (useRevisionStreaming) emitRevision(text, false)
        input.onProgress({
          phase: 'transcribing',
          finalTextChars: useRevisionStreaming
            ? emittedRevisionText.length
            : emittedFinalText.length,
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
    const file = await plan.inspection.source.getFile()
    const pcm = await transcodeToPcm16({
      blob: file,
      mimeType: plan.mimeType,
      durationMs: plan.durationMs ?? undefined,
    })
    const frameMs = 250
    const bytesPerMs = (pcm.sampleRate * 2) / 1000
    const frameBytes = Math.max(2, Math.floor(frameMs * bytesPerMs))
    const startedAt = Date.now()
    const realtimeRateLimit = resolveWebSocketStreamingRealtimeRateLimit(
      plan.providerConfig,
    )
    for (let offset = 0; offset < pcm.audio.byteLength; offset += frameBytes) {
      throwIfAborted(signal)
      const end = Math.min(pcm.audio.byteLength, offset + frameBytes)
      session.sendAudioChunk(pcm.audio.slice(offset, end))
      reportProgress(end, pcm.audio.byteLength)
      if (realtimeRateLimit !== null && pcm.durationMs > 0) {
        await paceStreaming({
          durationMs: pcm.durationMs,
          totalBytes: pcm.audio.byteLength,
          sentBytes: end,
          startedAt,
          realtimeRateLimit,
          signal,
        })
      } else {
        await delay(40, signal)
      }
    }
    return
  }

  const frameBytes = 64 * 1024
  const startedAt = Date.now()
  const realtimeRateLimit = resolveWebSocketStreamingRealtimeRateLimit(
    plan.providerConfig,
  )
  for (
    let offset = 0;
    offset < plan.inspection.source.size;
    offset += frameBytes
  ) {
    throwIfAborted(signal)
    const end = Math.min(plan.inspection.source.size, offset + frameBytes)
    session.sendAudioChunk(await plan.inspection.source.readSlice(offset, end))
    reportProgress(end, plan.inspection.source.size)
    if (realtimeRateLimit !== null && plan.durationMs && plan.durationMs > 0) {
      await paceStreaming({
        durationMs: plan.durationMs,
        totalBytes: plan.inspection.source.size,
        sentBytes: end,
        startedAt,
        realtimeRateLimit,
        signal,
      })
    } else {
      await delay(100, signal)
    }
  }
}

function resolveWebSocketStreamingRealtimeRateLimit(
  config: AsrConfig,
): number | null {
  if (config.format !== 'deepgram-compatible-websocket') {
    return null
  }
  if (
    config.webSocketProtocol === 'deepgram-compatible' &&
    config.asrProvider === 'deepgram'
  ) {
    return DEEPGRAM_MAX_STREAMING_REALTIME_RATE
  }
  if (config.webSocketProtocol === 'whisperlivekit-native') {
    return clampWebSocketFileStreamingRate(config.webSocketFileStreamingRate)
  }
  return null
}

async function paceStreaming(input: {
  durationMs: number | null | undefined
  totalBytes: number
  sentBytes: number
  startedAt: number
  realtimeRateLimit: number
  signal: AbortSignal
}): Promise<void> {
  const delayMs = calculateStreamingPaceDelayMs({
    durationMs: input.durationMs,
    totalBytes: input.totalBytes,
    sentBytes: input.sentBytes,
    startedAt: input.startedAt,
    now: Date.now(),
    realtimeRateLimit: input.realtimeRateLimit,
  })
  if (delayMs > 0) {
    await delay(delayMs, input.signal)
  }
}

export function calculateDeepgramStreamingPaceDelayMs(input: {
  durationMs: number | null | undefined
  totalBytes: number
  sentBytes: number
  startedAt: number
  now: number
}): number {
  return calculateStreamingPaceDelayMs({
    ...input,
    realtimeRateLimit: DEEPGRAM_MAX_STREAMING_REALTIME_RATE,
  })
}

export function calculateStreamingPaceDelayMs(input: {
  durationMs: number | null | undefined
  totalBytes: number
  sentBytes: number
  startedAt: number
  now: number
  realtimeRateLimit: number
}): number {
  if (
    !input.durationMs ||
    input.durationMs <= 0 ||
    input.totalBytes <= 0 ||
    input.sentBytes <= 0 ||
    input.realtimeRateLimit <= 0
  ) {
    return 0
  }
  const sentRatio = Math.min(1, input.sentBytes / input.totalBytes)
  const minimumElapsedMs =
    (input.durationMs * sentRatio) / input.realtimeRateLimit
  return Math.max(
    0,
    Math.ceil(minimumElapsedMs - (input.now - input.startedAt)),
  )
}

function clampWebSocketFileStreamingRate(value: number | undefined): number {
  const candidate =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT
  return Math.min(
    ASR_WEBSOCKET_FILE_STREAMING_RATE_MAX,
    Math.max(ASR_WEBSOCKET_FILE_STREAMING_RATE_MIN, candidate),
  )
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
  inspection: AudioFileInspection
  providerConfig: AsrConfig
}): number {
  if (
    input.providerConfig.audioFormat === 'wav' &&
    input.inspection.durationMs !== null
  ) {
    return estimatePcm16WavByteLength(input.inspection.durationMs)
  }
  return input.inspection.fileSizeBytes
}

function estimateWavPcmUploadBytes(input: {
  mode: AudioFileSubmissionMode
  providerConfig: AsrConfig
  inspection: AudioFileInspection
  schedule?: AudioFileChunkSchedule | null
}): number | null {
  if (!willSendWavPcmAudio(input.providerConfig, input.inspection)) {
    if (input.mode !== 'chunked-upload') return null
  }

  if (input.mode === 'websocket-stream') {
    if (input.providerConfig.audioFormat === 'wav') {
      return input.inspection.durationMs === null
        ? null
        : estimateLinear16MonoByteLength(input.inspection.durationMs)
    }
    return isWavLikeSource(input.inspection)
      ? input.inspection.fileSizeBytes
      : null
  }

  if (input.mode === 'chunked-upload') {
    const chunks = input.schedule?.chunks ?? []
    if (chunks.length === 0) return null
    return chunks.reduce(
      (sum, chunk) =>
        sum +
        estimatePcm16WavByteLength(chunk.actualEndMs - chunk.actualStartMs),
      0,
    )
  }

  if (input.providerConfig.audioFormat === 'wav') {
    return input.inspection.durationMs === null
      ? null
      : estimatePcm16WavByteLength(input.inspection.durationMs)
  }

  return isWavLikeSource(input.inspection)
    ? input.inspection.fileSizeBytes
    : null
}

function assertWavPcmSendWithinDurationLimit(input: {
  inspection: AudioFileInspection
  providerConfig: AsrConfig
  wavMaxDurationSec: number
  messages: AudioFileTranscriptionMessages
  forceWavPcm?: boolean
}): void {
  if (
    !input.forceWavPcm &&
    !willSendWavPcmAudio(input.providerConfig, input.inspection)
  ) {
    return
  }

  const limitMs = input.wavMaxDurationSec * 1000
  if (
    input.inspection.durationMs !== null &&
    input.inspection.durationMs > limitMs
  ) {
    throw new Error(
      input.messages.wavPcmDurationLimitExceeded(input.wavMaxDurationSec),
    )
  }

  if (
    input.inspection.durationMs === null &&
    isWavLikeSource(input.inspection) &&
    input.inspection.fileSizeBytes > estimatePcm16WavByteLength(limitMs)
  ) {
    throw new Error(
      input.messages.wavPcmDurationLimitExceeded(input.wavMaxDurationSec),
    )
  }
}

function willSendWavPcmAudio(
  providerConfig: AsrConfig,
  inspection: AudioFileInspection,
): boolean {
  return providerConfig.audioFormat === 'wav' || isWavLikeSource(inspection)
}

function isWavLikeSource(inspection: AudioFileInspection): boolean {
  const mimeType = inspection.mimeType.toLowerCase()
  return (
    inspection.extension === 'wav' ||
    inspection.extension === 'pcm' ||
    mimeType.includes('wav') ||
    mimeType.includes('wave') ||
    mimeType.includes('pcm')
  )
}

function canDecodeLocallyWithinDurationLimit(
  inspection: AudioFileInspection,
  wavMaxDurationSec: number,
): boolean {
  return (
    inspection.durationMs !== null &&
    inspection.durationMs <= wavMaxDurationSec * 1000
  )
}

function estimateLinear16MonoByteLength(durationMs: number): number {
  const sampleRate = 16_000
  const channels = 1
  const pcm16BytesPerSample = 2
  return Math.ceil(
    (durationMs / 1000) * sampleRate * channels * pcm16BytesPerSample,
  )
}

function formatLimitMinutes(seconds: number): string {
  const minutes = seconds / 60
  if (Number.isInteger(minutes)) return String(minutes)
  return minutes.toFixed(1)
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
