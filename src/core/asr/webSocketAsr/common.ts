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
  audioFormat: AsrAudioFormat
  language: string
}

export type DeepgramResultsMessage = {
  type?: unknown
  is_final?: unknown
  speech_final?: unknown
  from_finalize?: unknown
  channel?: {
    alternatives?: Array<{
      transcript?: unknown
    }>
  }
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

export const readTranscript = (payload: DeepgramResultsMessage): string => {
  const transcript = payload.channel?.alternatives?.[0]?.transcript
  return typeof transcript === 'string' ? transcript : ''
}

export const readWhisperLiveKitNativeTranscript = (
  payload: WhisperLiveKitNativeMessage,
): { text: string; buffer: string } => {
  const lineText =
    payload.lines
      ?.filter((line) => line.speaker !== -2)
      .map((line) => (typeof line.text === 'string' ? line.text.trim() : ''))
      .filter((text) => text.length > 0)
      .join(' ')
      .trim() ?? ''
  const buffer =
    typeof payload.buffer_transcription === 'string'
      ? payload.buffer_transcription.trim()
      : ''
  return { text: lineText, buffer }
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
  return parts.join(' ').trim()
}
