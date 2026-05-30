/**
 * Shared utilities for the WebSocket ASR adapters.
 *
 * Two adapters live alongside this module (Deepgram-compatible and
 * WhisperLiveKit native). Both share URL building, transcript-frame parsing,
 * WebSocket construction, and small error / aggregation helpers. The
 * protocol-specific framing and finalize semantics stay in each adapter.
 */
import type { AsrAudioFormat } from '../../../settings/schema/setting.types'

export type WebSocketAsrProfile = {
  baseURL: string
  apiKey: string
  model: string
  listenPath: string
  webSocketProtocol: import('../../../settings/schema/setting.types').AsrWebSocketProtocol
  webSocketPunctuate: boolean
  webSocketDiarizeMode: import('../../../settings/schema/setting.types').AsrWebSocketFeatureMode
  webSocketDictation: boolean
  audioFormat: AsrAudioFormat
  language: string
}

export type DeepgramWord = {
  word?: unknown
  punctuated_word?: unknown
  speaker?: unknown
}

export type DeepgramResultsMessage = {
  type?: unknown
  is_final?: unknown
  speech_final?: unknown
  from_finalize?: unknown
  channel?: {
    alternatives?: Array<{
      transcript?: unknown
      words?: DeepgramWord[]
    }>
  }
}

export type TranscriptSpeakerState = {
  lastSpeakerLabel: string
}

export type WhisperLiveKitNativeMessage = {
  type?: unknown
  status?: unknown
  lines?: Array<{
    speaker?: unknown
    text?: unknown
  }>
  buffer_transcription?: unknown
}

export const DEFAULT_LISTEN_PATH = '/listen'
export const CONNECT_TIMEOUT_MS = 15_000
export const FINALIZE_TIMEOUT_MS = 30_000
export const FINALIZE_SETTLE_MS = 2_000
export const LINEAR16_SAMPLE_RATE = 16_000

const toWebSocketBase = (baseURL: string): string => {
  const trimmed = baseURL.trim().replace(/\/+$/, '')
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed
  }
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}`
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}`
  }
  return trimmed
}

export const joinUrl = (baseURL: string, path: string): string => {
  const trimmedBase = toWebSocketBase(baseURL)
  const trimmedPath = path.replace(/^\/+/, '')
  return `${trimmedBase}/${trimmedPath}`
}

export const appendQuery = (
  url: string,
  params: Record<string, string | undefined>,
): string => {
  const u = new URL(url)
  for (const [key, value] of Object.entries(params)) {
    const v = value?.trim()
    if (v) u.searchParams.set(key, v)
  }
  return u.toString()
}

export const readTranscript = (
  payload: DeepgramResultsMessage,
  options: {
    includeSpeakerLabels?: boolean
    speakerState?: TranscriptSpeakerState
  } = {},
): string => {
  const alternative = payload.channel?.alternatives?.[0]
  if (options.includeSpeakerLabels) {
    const speakerTranscript = readDeepgramSpeakerTranscript(
      alternative?.words,
      options.speakerState,
    )
    if (speakerTranscript) return speakerTranscript
  }
  const transcript = alternative?.transcript
  return typeof transcript === 'string' ? transcript : ''
}

const readDeepgramSpeakerTranscript = (
  words: DeepgramWord[] | undefined,
  state?: TranscriptSpeakerState,
): string => {
  if (!Array.isArray(words) || words.length === 0) return ''
  const lines: string[] = []
  let current = ''
  let lastSpeakerLabel = state?.lastSpeakerLabel ?? ''

  for (const word of words) {
    const text = readDeepgramWordText(word)
    if (!text) continue
    const label = formatSpeakerLabel(word.speaker)
    if (label && label !== lastSpeakerLabel) {
      if (current.trim()) lines.push(current.trim())
      current = `${label}: ${text}`
      lastSpeakerLabel = label
      continue
    }
    current = appendTranscriptWord(current, text)
  }

  if (current.trim()) lines.push(current.trim())
  if (state) state.lastSpeakerLabel = lastSpeakerLabel
  return lines.join('\n').trim()
}

const readDeepgramWordText = (word: {
  word?: unknown
  punctuated_word?: unknown
}): string => {
  const punctuated =
    typeof word.punctuated_word === 'string' ? word.punctuated_word.trim() : ''
  if (punctuated) return punctuated
  return typeof word.word === 'string' ? word.word.trim() : ''
}

const appendTranscriptWord = (current: string, word: string): string => {
  if (!current) return word
  if (/^[,.;:!?，。！？；：）\])}]/.test(word)) return `${current}${word}`
  return `${current} ${word}`
}

export const readWhisperLiveKitNativeTranscript = (
  payload: WhisperLiveKitNativeMessage,
  options: { includeSpeakerLabels?: boolean } = {},
): { text: string; buffer: string } => {
  let lastSpeakerLabel = ''
  const lineText =
    payload.lines
      ?.filter((line) => line.speaker !== -2)
      .map((line) => {
        const text = typeof line.text === 'string' ? line.text.trim() : ''
        if (!text || !options.includeSpeakerLabels) return text
        const label = formatSpeakerLabel(line.speaker)
        if (!label) return text
        if (label === lastSpeakerLabel) return text
        lastSpeakerLabel = label
        return `${label}: ${text}`
      })
      .filter((text) => text.length > 0)
      .join(options.includeSpeakerLabels ? '\n' : ' ')
      .trim() ?? ''
  const buffer =
    typeof payload.buffer_transcription === 'string'
      ? payload.buffer_transcription.trim()
      : ''
  return { text: lineText, buffer }
}

const formatSpeakerLabel = (speaker: unknown): string => {
  if (typeof speaker === 'number' && Number.isFinite(speaker) && speaker >= 0) {
    return `Speaker ${speaker + 1}`
  }
  if (typeof speaker === 'string' && speaker.trim().length > 0) {
    return `Speaker ${speaker.trim()}`
  }
  return ''
}

export const createAsrWebSocket = async (args: {
  url: string
  protocols?: string[]
}): Promise<WebSocket> => {
  const { url, protocols } = args
  return protocols && protocols.length > 0
    ? new WebSocket(url, protocols)
    : new WebSocket(url)
}

export const armWebSocketConnectTimeout = (args: {
  socket: WebSocket
  isSettled: () => boolean
  onTimeout: (error: Error) => void
}): (() => void) => {
  const { socket, isSettled, onTimeout } = args
  let timeoutId: number | null = window.setTimeout(() => {
    timeoutId = null
    if (isSettled() || socket.readyState !== WebSocket.CONNECTING) return
    onTimeout(new Error('ASR WebSocket timed out while connecting.'))
  }, CONNECT_TIMEOUT_MS)

  const clear = () => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
      timeoutId = null
    }
    socket.removeEventListener('open', clear)
    socket.removeEventListener('error', clear)
    socket.removeEventListener('close', clear)
  }

  socket.addEventListener('open', clear, { once: true })
  socket.addEventListener('error', clear, { once: true })
  socket.addEventListener('close', clear, { once: true })
  return clear
}

const errorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return 'Unknown error'
  }
}

export { errorMessage }

export const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(errorMessage(error))

export const pushFinalPart = (parts: string[], transcript: string): void => {
  const trimmed = transcript.trim()
  if (!trimmed) return
  if (parts[parts.length - 1] === trimmed) return
  parts.push(trimmed)
}

export const combineTranscript = (
  finalParts: string[],
  partial = '',
): string => {
  const parts = [...finalParts]
  const trimmedPartial = partial.trim()
  if (trimmedPartial) parts.push(trimmedPartial)
  const separator = parts.some((part) => part.includes('\n')) ? '\n' : ' '
  return parts.join(separator).trim()
}
