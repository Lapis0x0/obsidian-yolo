import type {
  AsrApiFormat,
  AsrAudioFormat,
  AsrWebSocketProtocol,
} from '../../settings/schema/setting.types'

import { transcodeToPcm16 } from './audioTranscode'
import { BaseAsrProvider } from './base'
import type {
  AsrAudioInput,
  AsrOptions,
  AsrResult,
  AsrStreamingCallbacks,
  AsrStreamingOptions,
  AsrStreamingSession,
} from './types'

export type WebSocketAsrProfile = {
  baseURL: string
  apiKey: string
  model: string
  listenPath: string
  webSocketProtocol: AsrWebSocketProtocol
  audioFormat: AsrAudioFormat
  language: string
}

type DeepgramResultsMessage = {
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

type WhisperLiveKitNativeMessage = {
  type?: unknown
  status?: unknown
  lines?: Array<{
    speaker?: unknown
    text?: unknown
  }>
  buffer_transcription?: unknown
}

const DEFAULT_LISTEN_PATH = '/listen'
const FINALIZE_TIMEOUT_MS = 30_000
const FINALIZE_SETTLE_MS = 2_000
const LINEAR16_SAMPLE_RATE = 16_000

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

const joinUrl = (baseURL: string, path: string): string => {
  const trimmedBase = toWebSocketBase(baseURL)
  const trimmedPath = path.replace(/^\/+/, '')
  return `${trimmedBase}/${trimmedPath}`
}

const appendQuery = (
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

const readTranscript = (payload: DeepgramResultsMessage): string => {
  const transcript = payload.channel?.alternatives?.[0]?.transcript
  return typeof transcript === 'string' ? transcript : ''
}

const readWhisperLiveKitNativeTranscript = (
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

type WebSocketLike = WebSocket

const createAsrWebSocket = async (args: {
  url: string
  protocols?: string[]
}): Promise<WebSocketLike> => {
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

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(errorMessage(error))

const pushFinalPart = (parts: string[], transcript: string): void => {
  const trimmed = transcript.trim()
  if (!trimmed) return
  if (parts[parts.length - 1] === trimmed) return
  parts.push(trimmed)
}

const combineTranscript = (finalParts: string[], partial = ''): string => {
  const parts = [...finalParts]
  const trimmedPartial = partial.trim()
  if (trimmedPartial) parts.push(trimmedPartial)
  return parts.join(' ').trim()
}

/**
 * Live WebSocket ASR adapters.
 *
 * Audio chunks are sent as binary frames while recording. `transcribe` is
 * kept for settings tests and one-shot callers by opening a short streaming
 * session under the hood.
 */
export class WebSocketAsrProvider extends BaseAsrProvider {
  readonly format: AsrApiFormat = 'deepgram-compatible-websocket'
  private readonly profile: WebSocketAsrProfile

  constructor(profile: WebSocketAsrProfile) {
    super()
    this.profile = profile
  }

  async transcribe(
    input: AsrAudioInput,
    options?: AsrOptions,
  ): Promise<AsrResult> {
    const { baseURL, apiKey, model, listenPath, audioFormat, language } =
      this.profile
    if (!baseURL.trim()) {
      throw new Error('ASR provider is missing baseURL.')
    }
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const path =
      listenPath && listenPath.trim().length > 0
        ? listenPath
        : DEFAULT_LISTEN_PATH
    const langCandidate = (options?.language ?? language ?? '').trim()
    const url = appendQuery(joinUrl(baseURL, path), {
      model,
      language:
        langCandidate && langCandidate !== 'auto' ? langCandidate : undefined,
      smart_format: 'true',
      ...(audioFormat === 'wav'
        ? {
            encoding: 'linear16',
            sample_rate: String(LINEAR16_SAMPLE_RATE),
            channels: '1',
          }
        : {}),
    })

    const audioBytes =
      audioFormat === 'wav'
        ? (await transcodeToPcm16(input, LINEAR16_SAMPLE_RATE)).audio
        : await input.blob.arrayBuffer()
    const startedAt = Date.now()
    const text = await sendDeepgramCompatibleClip({
      url,
      apiKey,
      audioBytes,
      signal: options?.signal,
    })

    return {
      text,
      requestDurationMs: Date.now() - startedAt,
    }
  }

  async startStreaming(
    options: AsrStreamingOptions,
    callbacks: AsrStreamingCallbacks,
  ): Promise<AsrStreamingSession> {
    const {
      baseURL,
      apiKey,
      model,
      listenPath,
      language,
      audioFormat,
      webSocketProtocol,
    } = this.profile
    if (!baseURL.trim()) {
      throw new Error('ASR provider is missing baseURL.')
    }
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const path =
      listenPath && listenPath.trim().length > 0
        ? listenPath
        : DEFAULT_LISTEN_PATH
    const langCandidate = (options.language ?? language ?? '').trim()
    const languageParam =
      langCandidate && langCandidate !== 'auto' ? langCandidate : undefined
    const baseWsUrl = joinUrl(baseURL, path)
    const url = appendQuery(baseWsUrl, {
      model,
      language: languageParam,
      smart_format: 'true',
      interim_results: 'true',
      ...(audioFormat === 'wav'
        ? {
            encoding: 'linear16',
            sample_rate: String(LINEAR16_SAMPLE_RATE),
            channels: '1',
          }
        : {}),
    })

    const streamArgs = {
      url,
      apiKey,
      signal: options.signal,
      callbacks,
    }
    if (webSocketProtocol === 'whisperlivekit-native') {
      return openWhisperLiveKitNativeStream(streamArgs)
    }
    return openDeepgramCompatibleStream(streamArgs)
  }
}

const sendDeepgramCompatibleClip = async (args: {
  url: string
  apiKey: string
  audioBytes: ArrayBuffer
  signal?: AbortSignal
}): Promise<string> => {
  const { url, apiKey, audioBytes, signal } = args
  const protocols =
    apiKey.trim().length > 0 ? ['token', apiKey.trim()] : undefined
  const socket = await createAsrWebSocket({
    url,
    protocols,
  })
  socket.binaryType = 'arraybuffer'
  return new Promise((resolve, reject) => {
    let settled = false
    let finalized = false
    let lastTranscript = ''
    const finalParts: string[] = []
    let timeoutId: number | null = null

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(asError(error))
    }

    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(finalParts.join(' ').trim() || lastTranscript.trim())
    }

    const cleanup = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
      signal?.removeEventListener('abort', onAbort)
      try {
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close()
        }
      } catch {
        // best-effort close
      }
    }

    const onAbort = () => fail(new DOMException('Aborted', 'AbortError'))

    signal?.addEventListener('abort', onAbort, { once: true })

    timeoutId = window.setTimeout(() => {
      fail(new Error('ASR WebSocket timed out waiting for final transcript.'))
    }, FINALIZE_TIMEOUT_MS)

    socket.addEventListener('open', () => {
      if (signal?.aborted) {
        onAbort()
        return
      }
      socket.send(audioBytes)
      finalized = true
      socket.send(JSON.stringify({ type: 'Finalize' }))
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      let payload: DeepgramResultsMessage & {
        error?: unknown
        message?: unknown
      }
      try {
        payload = JSON.parse(event.data) as DeepgramResultsMessage
      } catch {
        return
      }

      if ('error' in payload && payload.error) {
        fail(new Error(errorMessage(payload.error)))
        return
      }
      if ('message' in payload && payload.message && !('channel' in payload)) {
        fail(new Error(errorMessage(payload.message)))
        return
      }

      const result = payload
      if (result.type && result.type !== 'Results') return

      const transcript = readTranscript(result).trim()
      if (transcript) {
        lastTranscript = transcript
        if (result.is_final === true) {
          pushFinalPart(finalParts, transcript)
        }
      }
      if (finalized && result.is_final === true) {
        try {
          socket.send(JSON.stringify({ type: 'CloseStream' }))
        } catch {
          // Closing locally is enough if the server already finalized.
        }
        succeed()
      }
    })

    socket.addEventListener('close', (event) => {
      if (settled) return
      if (event.code === 1000 || event.code === 1005) {
        succeed()
        return
      }
      fail(
        new Error(
          `ASR WebSocket closed unexpectedly: ${event.code}${event.reason ? ` — ${event.reason}` : ''}`,
        ),
      )
    })

    socket.addEventListener('error', () => {
      fail(new Error('ASR WebSocket connection failed.'))
    })
  })
}

const openDeepgramCompatibleStream = async (args: {
  url: string
  apiKey: string
  signal?: AbortSignal
  callbacks: AsrStreamingCallbacks
}): Promise<AsrStreamingSession> => {
  const { url, apiKey, signal, callbacks } = args
  const protocols =
    apiKey.trim().length > 0 ? ['token', apiKey.trim()] : undefined
  const socket = await createAsrWebSocket({
    url,
    protocols,
  })
  socket.binaryType = 'arraybuffer'
  return new Promise((resolve, reject) => {
    let settled = false
    let opened = false
    let finished = false
    let finishResolve: ((result: AsrResult) => void) | null = null
    let finishReject: ((error: Error) => void) | null = null
    let sendChain = Promise.resolve()
    let lastTranscript = ''
    const finalParts: string[] = []
    const startedAt = Date.now()
    let timeoutId: number | null = null
    let settleTimeoutId: number | null = null

    const cleanup = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
      if (settleTimeoutId !== null) {
        window.clearTimeout(settleTimeoutId)
        settleTimeoutId = null
      }
      signal?.removeEventListener('abort', onAbort)
      try {
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close()
        }
      } catch {
        // best-effort close
      }
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      const err = asError(error)
      if (!opened) reject(err)
      finishReject?.(err)
    }

    const complete = () => {
      if (settled) return
      settled = true
      cleanup()
      finishResolve?.({
        text: combineTranscript(finalParts) || lastTranscript.trim(),
        requestDurationMs: Date.now() - startedAt,
      })
    }

    const armSettleTimeout = () => {
      if (settleTimeoutId !== null) window.clearTimeout(settleTimeoutId)
      settleTimeoutId = window.setTimeout(() => {
        if (settled) return
        if (combineTranscript(finalParts) || lastTranscript.trim()) {
          complete()
        }
      }, FINALIZE_SETTLE_MS)
    }

    const onAbort = () => fail(new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', onAbort, { once: true })

    const session: AsrStreamingSession = {
      sendAudioChunk(chunk: Blob | ArrayBuffer): void {
        if (settled || finished) return
        sendChain = sendChain.then(async () => {
          if (settled || finished || socket.readyState !== WebSocket.OPEN) {
            return
          }
          const bytes =
            chunk instanceof Blob ? await chunk.arrayBuffer() : chunk
          if (bytes.byteLength > 0) socket.send(bytes)
        })
        void sendChain.catch(fail)
      },
      keepAlive(): void {
        if (settled || finished || socket.readyState !== WebSocket.OPEN) return
        try {
          socket.send(JSON.stringify({ type: 'KeepAlive' }))
        } catch (error) {
          fail(error)
        }
      },
      async finish(): Promise<AsrResult> {
        if (finished) {
          return {
            text: combineTranscript(finalParts) || lastTranscript.trim(),
            requestDurationMs: Date.now() - startedAt,
          }
        }
        finished = true
        await sendChain
        return new Promise<AsrResult>((res, rej) => {
          finishResolve = res
          finishReject = rej
          try {
            socket.send(JSON.stringify({ type: 'Finalize' }))
            armSettleTimeout()
          } catch (error) {
            fail(error)
          }
          timeoutId = window.setTimeout(() => {
            if (!settled) {
              fail(
                new Error(
                  'ASR WebSocket timed out waiting for final transcript.',
                ),
              )
            }
          }, FINALIZE_TIMEOUT_MS)
        })
      },
      cancel(): void {
        fail(new DOMException('Aborted', 'AbortError'))
      },
    }

    socket.addEventListener('open', () => {
      if (signal?.aborted) {
        onAbort()
        return
      }
      opened = true
      resolve(session)
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      let payload: DeepgramResultsMessage & {
        error?: unknown
        message?: unknown
      }
      try {
        payload = JSON.parse(event.data) as DeepgramResultsMessage
      } catch {
        return
      }

      if ('error' in payload && payload.error) {
        fail(new Error(errorMessage(payload.error)))
        return
      }
      if ('message' in payload && payload.message && !('channel' in payload)) {
        fail(new Error(errorMessage(payload.message)))
        return
      }

      const result = payload
      if (result.type && result.type !== 'Results') return
      const transcript = readTranscript(result).trim()
      if (!transcript) return

      lastTranscript = transcript
      if (result.is_final === true || result.speech_final === true) {
        pushFinalPart(finalParts, transcript)
        callbacks.onFinal?.(combineTranscript(finalParts))
      } else {
        callbacks.onPartial?.(combineTranscript(finalParts, transcript))
      }

      if (finished && result.is_final === true) {
        try {
          socket.send(JSON.stringify({ type: 'CloseStream' }))
        } catch {
          // best-effort
        }
        complete()
      } else if (finished) {
        armSettleTimeout()
      }
    })

    socket.addEventListener('close', (event) => {
      if (settled) return
      if (finished && (event.code === 1000 || event.code === 1005)) {
        complete()
        return
      }
      fail(
        new Error(
          `ASR WebSocket closed unexpectedly: ${event.code}${event.reason ? ` — ${event.reason}` : ''}`,
        ),
      )
    })

    socket.addEventListener('error', () => {
      fail(new Error('ASR WebSocket connection failed.'))
    })
  })
}

const openWhisperLiveKitNativeStream = async (args: {
  url: string
  signal?: AbortSignal
  callbacks: AsrStreamingCallbacks
}): Promise<AsrStreamingSession> => {
  const { url, signal, callbacks } = args
  const socket = await createAsrWebSocket({
    url,
  })
  socket.binaryType = 'arraybuffer'
  return new Promise((resolve, reject) => {
    let settled = false
    let opened = false
    let finished = false
    let finishResolve: ((result: AsrResult) => void) | null = null
    let finishReject: ((error: Error) => void) | null = null
    let sendChain = Promise.resolve()
    let latestText = ''
    const startedAt = Date.now()
    let timeoutId: number | null = null
    let settleTimeoutId: number | null = null

    const cleanup = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
      if (settleTimeoutId !== null) {
        window.clearTimeout(settleTimeoutId)
        settleTimeoutId = null
      }
      signal?.removeEventListener('abort', onAbort)
      try {
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close()
        }
      } catch {
        // best-effort close
      }
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      const err = asError(error)
      if (!opened) reject(err)
      finishReject?.(err)
    }

    const complete = () => {
      if (settled) return
      settled = true
      cleanup()
      finishResolve?.({
        text: latestText.trim(),
        requestDurationMs: Date.now() - startedAt,
      })
    }

    const armSettleTimeout = () => {
      if (settleTimeoutId !== null) window.clearTimeout(settleTimeoutId)
      settleTimeoutId = window.setTimeout(() => {
        if (!settled) complete()
      }, FINALIZE_SETTLE_MS)
    }

    const onAbort = () => fail(new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', onAbort, { once: true })

    const session: AsrStreamingSession = {
      sendAudioChunk(chunk: Blob | ArrayBuffer): void {
        if (settled || finished) return
        sendChain = sendChain.then(async () => {
          if (settled || finished || socket.readyState !== WebSocket.OPEN) {
            return
          }
          const bytes =
            chunk instanceof Blob ? await chunk.arrayBuffer() : chunk
          if (bytes.byteLength > 0) socket.send(bytes)
        })
        void sendChain.catch(fail)
      },
      keepAlive(): void {
        // Native WhisperLiveKit /asr has no JSON keepalive; keeping the socket
        // open is enough while the next recorder segment starts.
      },
      async finish(): Promise<AsrResult> {
        if (finished) {
          return {
            text: latestText.trim(),
            requestDurationMs: Date.now() - startedAt,
          }
        }
        finished = true
        await sendChain
        return new Promise<AsrResult>((res, rej) => {
          finishResolve = res
          finishReject = rej
          try {
            socket.send(new ArrayBuffer(0))
          } catch {
            // Some WebSocket implementations refuse empty binary frames; the
            // native endpoint also flushes useful text before close, so fall
            // through to the settle timer.
          }
          armSettleTimeout()
          timeoutId = window.setTimeout(() => {
            if (!settled) {
              fail(
                new Error(
                  'ASR WebSocket timed out waiting for final transcript.',
                ),
              )
            }
          }, FINALIZE_TIMEOUT_MS)
        })
      },
      cancel(): void {
        fail(new DOMException('Aborted', 'AbortError'))
      },
    }

    socket.addEventListener('open', () => {
      if (signal?.aborted) {
        onAbort()
        return
      }
      opened = true
      resolve(session)
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      let payload: WhisperLiveKitNativeMessage & {
        error?: unknown
        message?: unknown
      }
      try {
        payload = JSON.parse(event.data) as WhisperLiveKitNativeMessage
      } catch {
        return
      }

      if ('error' in payload && payload.error) {
        fail(new Error(errorMessage(payload.error)))
        return
      }
      if ('message' in payload && payload.message && !('lines' in payload)) {
        fail(new Error(errorMessage(payload.message)))
        return
      }
      if (payload.type === 'config') return
      if (payload.type === 'ready_to_stop') {
        complete()
        return
      }

      const { text, buffer } = readWhisperLiveKitNativeTranscript(payload)
      const combined = [text, buffer].filter(Boolean).join(' ').trim()
      if (!combined) return
      if (text) {
        latestText = text
        callbacks.onFinal?.(combined)
      } else {
        callbacks.onPartial?.(combined)
      }
      if (finished) armSettleTimeout()
    })

    socket.addEventListener('close', (event) => {
      if (settled) return
      if (finished || event.code === 1000 || event.code === 1005) {
        complete()
        return
      }
      fail(
        new Error(
          `ASR WebSocket closed unexpectedly: ${event.code}${event.reason ? ` — ${event.reason}` : ''}`,
        ),
      )
    })

    socket.addEventListener('error', () => {
      fail(new Error('ASR WebSocket connection failed.'))
    })
  })
}
