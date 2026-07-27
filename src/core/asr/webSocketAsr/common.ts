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

export type WhisperLiveKitNativeLine = {
  speaker?: unknown
  text?: unknown
  start?: unknown
  end?: unknown
}

export type WhisperLiveKitNativeMessage = {
  type?: unknown
  status?: unknown
  lines?: WhisperLiveKitNativeLine[]
  new_lines?: WhisperLiveKitNativeLine[]
  lines_pruned?: unknown
  n_lines?: unknown
  buffer_transcription?: unknown
}

export type WhisperLiveKitNativeTranscriptState = {
  lines: WhisperLiveKitNativeLine[]
  committedText: string
}

export const DEFAULT_LISTEN_PATH = '/listen'
export const CONNECT_TIMEOUT_MS = 15_000
export const FINALIZE_TIMEOUT_MS = 30_000
export const FINALIZE_SETTLE_MS = 2_000
export const LINEAR16_SAMPLE_RATE = 16_000
const SPEAKER_LABEL_START_RE = /^Speaker\s+[^:\n]+:\s/
const SPEAKER_BLOCK_SEPARATOR = '\n\n'

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
  const transcript =
    typeof alternative?.transcript === 'string' ? alternative.transcript : ''
  if (options.includeSpeakerLabels) {
    const speakerTranscript = readDeepgramSpeakerTranscript(
      alternative?.words,
      transcript,
      options.speakerState,
    )
    if (speakerTranscript) return speakerTranscript
  }
  return transcript
}

const readDeepgramSpeakerTranscript = (
  words: DeepgramWord[] | undefined,
  transcript: string,
  state?: TranscriptSpeakerState,
): string => {
  if (!Array.isArray(words) || words.length === 0) return ''
  const labels = words
    .map((word) => formatSpeakerLabel(word.speaker))
    .filter((label) => label.length > 0)
  const uniqueLabels = [...new Set(labels)]
  const trimmedTranscript = transcript.trim()
  if (uniqueLabels.length === 1 && trimmedTranscript) {
    const label = uniqueLabels[0]
    const prefix = label === state?.lastSpeakerLabel ? '' : `${label}: `
    if (state) state.lastSpeakerLabel = label
    return `${prefix}${trimmedTranscript}`
  }

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
  return lines.join(SPEAKER_BLOCK_SEPARATOR).trim()
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
  if (/^[.,!?;:，。！？；：]/.test(word)) return `${current}${word}`
  // Deepgram `words` are token-like: English tokens need spaces, while CJK
  // tokens should stay adjacent when reconstructing a speaker-labeled line.
  return shouldJoinTranscriptWordWithoutSpace(current, word)
    ? `${current}${word}`
    : `${current} ${word}`
}

const shouldJoinTranscriptWordWithoutSpace = (
  current: string,
  word: string,
): boolean => {
  const previous = current.trimEnd().at(-1) ?? ''
  const next = word.trimStart().at(0) ?? ''
  return (
    (isCjkTranscriptChar(previous) || isCjkTranscriptPunctuation(previous)) &&
    isCjkTranscriptChar(next)
  )
}

const isCjkTranscriptChar = (char: string): boolean =>
  /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(char)

const isCjkTranscriptPunctuation = (char: string): boolean =>
  /[，。！？；：、]/.test(char)

export const readWhisperLiveKitNativeTranscript = (
  payload: WhisperLiveKitNativeMessage,
  options: {
    includeSpeakerLabels?: boolean
    state?: WhisperLiveKitNativeTranscriptState
  } = {},
): { text: string; buffer: string; committedChanged: boolean } => {
  const state = options.state
  let lineText = ''
  let committedChanged = false

  if (state && payload.type === 'snapshot') {
    const previousText = formatWhisperLiveKitStateText(state, {
      includeSpeakerLabels: options.includeSpeakerLabels,
    })
    state.lines = [...(payload.lines ?? [])]
    state.committedText = ''
    lineText = formatWhisperLiveKitStateText(state, {
      includeSpeakerLabels: options.includeSpeakerLabels,
    })
    committedChanged = lineText !== previousText
  } else if (state && payload.type === 'diff') {
    const previousText = formatWhisperLiveKitStateText(state, {
      includeSpeakerLabels: options.includeSpeakerLabels,
    })
    applyWhisperLiveKitDiff(state, payload, {
      includeSpeakerLabels: options.includeSpeakerLabels,
    })
    lineText = formatWhisperLiveKitStateText(state, {
      includeSpeakerLabels: options.includeSpeakerLabels,
    })
    committedChanged = lineText !== previousText
  } else {
    lineText = formatWhisperLiveKitLines(payload.lines ?? [], {
      includeSpeakerLabels: options.includeSpeakerLabels,
    })
    committedChanged = lineText.length > 0
  }

  const buffer =
    typeof payload.buffer_transcription === 'string'
      ? payload.buffer_transcription.trim()
      : ''
  return { text: lineText, buffer, committedChanged }
}

export const createWhisperLiveKitNativeTranscriptState =
  (): WhisperLiveKitNativeTranscriptState => ({
    lines: [],
    committedText: '',
  })

const formatWhisperLiveKitLines = (
  lines: WhisperLiveKitNativeLine[],
  options: {
    includeSpeakerLabels?: boolean
  },
): string => {
  const speakerState = { lastSpeakerLabel: '' }
  const textLines = lines
    .map((line) => {
      const text = typeof line.text === 'string' ? line.text.trim() : ''
      if (!text || !options.includeSpeakerLabels) return text
      const label = formatWhisperLiveKitSpeakerLabel(line.speaker)
      if (!label) return text
      if (label === speakerState.lastSpeakerLabel) return text
      speakerState.lastSpeakerLabel = label
      return `${label}: ${text}`
    })
    .filter((text) => text.length > 0)
  if (!options.includeSpeakerLabels) return textLines.join(' ').trim()
  return joinSpeakerAwareLines(textLines)
}

const joinSpeakerAwareLines = (lines: string[]): string => {
  return lines
    .reduce((combined, line) => {
      if (!combined) return line
      // New speaker blocks should be visually separated, while continuation
      // lines from the same speaker stay compact.
      const separator = isSpeakerLabelStart(line)
        ? SPEAKER_BLOCK_SEPARATOR
        : '\n'
      return `${combined}${separator}${line}`
    }, '')
    .trim()
}

const appendWhisperLiveKitText = (previous: string, next: string): string => {
  const trimmedPrevious = previous.trim()
  const trimmedNext = next.trim()
  if (!trimmedNext) return trimmedPrevious
  if (!trimmedPrevious) return trimmedNext
  if (/^\s/.test(next)) return `${trimmedPrevious}${next}`
  if (isSpeakerLabelStart(trimmedNext)) {
    return `${trimmedPrevious}${SPEAKER_BLOCK_SEPARATOR}${trimmedNext}`
  }
  return `${trimmedPrevious} ${trimmedNext}`
}

const readNonNegativeInteger = (value: unknown): number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : 0
}

const readExpectedLineCount = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null
}

const applyWhisperLiveKitDiff = (
  state: WhisperLiveKitNativeTranscriptState,
  payload: WhisperLiveKitNativeMessage,
  options: {
    includeSpeakerLabels?: boolean
  },
): void => {
  const prunedCount = readNonNegativeInteger(payload.lines_pruned)
  const prunedLines = prunedCount > 0 ? state.lines.splice(0, prunedCount) : []
  if (shouldCommitWhisperLiveKitPrunedLines(prunedLines, payload.new_lines)) {
    const prunedText = formatWhisperLiveKitLines(prunedLines, options)
    state.committedText = appendWhisperLiveKitText(
      state.committedText,
      prunedText,
    )
  }
  applyWhisperLiveKitDiffLines(state.lines, payload)
}

const applyWhisperLiveKitDiffLines = (
  lines: WhisperLiveKitNativeLine[],
  payload: WhisperLiveKitNativeMessage,
): void => {
  const newLines = payload.new_lines ?? []
  const expected = readExpectedLineCount(payload.n_lines)
  if (expected !== null) {
    // Some WLK diff streams refresh the currently growing tail while keeping
    // n_lines stable. Keep the stable prefix and let new_lines replace the tail.
    const stablePrefixLength = Math.max(0, expected - newLines.length)
    if (lines.length > stablePrefixLength) {
      lines.splice(stablePrefixLength)
    }
  }
  lines.push(...newLines)
}

const shouldCommitWhisperLiveKitPrunedLines = (
  prunedLines: WhisperLiveKitNativeLine[],
  newLines: WhisperLiveKitNativeLine[] | undefined,
): boolean => {
  const prunedTextLines = prunedLines.filter((line) => readLineText(line))
  if (prunedTextLines.length === 0) return false
  const replacements = newLines ?? []
  if (replacements.length === 0) return true
  return !prunedTextLines.some((pruned) =>
    replacements.some((replacement) =>
      isWhisperLiveKitLineReplacement(pruned, replacement),
    ),
  )
}

const isWhisperLiveKitLineReplacement = (
  previous: WhisperLiveKitNativeLine,
  next: WhisperLiveKitNativeLine,
): boolean => {
  const previousStart = readLineStart(previous)
  const nextStart = readLineStart(next)
  if (previousStart && nextStart && previousStart === nextStart) return true

  const previousText = readLineText(previous)
  const nextText = readLineText(next)
  return !!previousText && !!nextText && nextText.startsWith(previousText)
}

const readLineText = (line: WhisperLiveKitNativeLine): string =>
  typeof line.text === 'string' ? line.text.trim() : ''

const readLineStart = (line: WhisperLiveKitNativeLine): string =>
  typeof line.start === 'string' ? line.start.trim() : ''

const formatWhisperLiveKitStateText = (
  state: WhisperLiveKitNativeTranscriptState,
  options: {
    includeSpeakerLabels?: boolean
  },
): string => {
  const currentText = formatWhisperLiveKitLines(state.lines, options)
  return appendWhisperLiveKitText(state.committedText, currentText)
}

const formatSpeakerLabel = (speaker: unknown): string => {
  if (typeof speaker === 'number' && Number.isFinite(speaker)) {
    return speaker >= 0 ? `Speaker ${speaker + 1}` : `Speaker ${speaker}`
  }
  if (typeof speaker === 'string' && speaker.trim().length > 0) {
    return `Speaker ${speaker.trim()}`
  }
  return ''
}

const formatWhisperLiveKitSpeakerLabel = (speaker: unknown): string => {
  if (typeof speaker === 'number' && Number.isFinite(speaker)) {
    // WhisperLiveKit emits speaker ids that are already user-facing; keep
    // them as-is so the transcript matches the provider output.
    return `Speaker ${speaker}`
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
  return parts
    .reduce((combined, part) => {
      if (!combined) return part
      return `${combined}${getTranscriptPartSeparator(part)}${part}`
    }, '')
    .trim()
}

const getTranscriptPartSeparator = (nextPart: string): string =>
  isSpeakerLabelStart(nextPart) ? SPEAKER_BLOCK_SEPARATOR : ' '

const isSpeakerLabelStart = (text: string): boolean =>
  SPEAKER_LABEL_START_RE.test(text)
