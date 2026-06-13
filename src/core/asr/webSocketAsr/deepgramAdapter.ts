/**
 * Deepgram-compatible WebSocket ASR adapter.
 *
 * Two entry points share the same protocol framing:
 *   - `sendDeepgramCompatibleClip`: one-shot upload + immediate `Finalize`,
 *     used by the settings-page test button and any caller that has the
 *     full clip up front.
 *   - `openDeepgramCompatibleStream`: long-lived streaming session that
 *     accepts audio chunks while the user is still talking, supports
 *     KeepAlive frames, and finalises via `Finalize` + `CloseStream`.
 */
import type {
  AsrResult,
  AsrStreamingCallbacks,
  AsrStreamingSession,
} from '../types'

import {
  type DeepgramResultsMessage,
  FINALIZE_SETTLE_MS,
  FINALIZE_TIMEOUT_MS,
  armWebSocketConnectTimeout,
  asError,
  combineTranscript,
  createAsrWebSocket,
  errorMessage,
  pushFinalPart,
  readTranscript,
} from './common'

export const sendDeepgramCompatibleClip = async (args: {
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
    let clearConnectTimeout: (() => void) | null = null

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
      clearConnectTimeout?.()
      clearConnectTimeout = null
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
    clearConnectTimeout = armWebSocketConnectTimeout({
      socket,
      isSettled: () => settled,
      onTimeout: fail,
    })

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

export const openDeepgramCompatibleStream = async (args: {
  url: string
  apiKey: string
  signal?: AbortSignal
  callbacks: AsrStreamingCallbacks
  includeSpeakerLabels?: boolean
}): Promise<AsrStreamingSession> => {
  const { url, apiKey, signal, callbacks, includeSpeakerLabels } = args
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
    const speakerState = { lastSpeakerLabel: '' }
    const startedAt = Date.now()
    let timeoutId: number | null = null
    let settleTimeoutId: number | null = null
    let clearConnectTimeout: (() => void) | null = null

    const cleanup = () => {
      clearConnectTimeout?.()
      clearConnectTimeout = null
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
    clearConnectTimeout = armWebSocketConnectTimeout({
      socket,
      isSettled: () => settled || opened,
      onTimeout: fail,
    })

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
      const isFinal = result.is_final === true || result.speech_final === true
      const transcript = readTranscript(result, {
        includeSpeakerLabels: !!includeSpeakerLabels && isFinal,
        speakerState,
      }).trim()
      if (!transcript) return

      lastTranscript = transcript
      if (isFinal) {
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
