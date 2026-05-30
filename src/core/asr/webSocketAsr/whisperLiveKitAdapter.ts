/**
 * WhisperLiveKit native (/asr) WebSocket adapter.
 *
 * Different framing than Deepgram-compatible: no `Finalize` JSON envelope,
 * no `KeepAlive` frame, finalisation is signalled by a `ready_to_stop`
 * message after we send an empty binary frame. Transcript frames carry
 * `lines` (committed) plus an optional `buffer_transcription` (in-flight).
 */
import type {
  AsrResult,
  AsrStreamingCallbacks,
  AsrStreamingSession,
} from '../types'

import {
  FINALIZE_SETTLE_MS,
  FINALIZE_TIMEOUT_MS,
  type WhisperLiveKitNativeMessage,
  armWebSocketConnectTimeout,
  asError,
  createAsrWebSocket,
  createWhisperLiveKitNativeTranscriptState,
  errorMessage,
  readWhisperLiveKitNativeTranscript,
} from './common'

export const openWhisperLiveKitNativeStream = async (args: {
  url: string
  signal?: AbortSignal
  callbacks: AsrStreamingCallbacks
  includeSpeakerLabels?: boolean
}): Promise<AsrStreamingSession> => {
  const { url, signal, callbacks, includeSpeakerLabels } = args
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
    const transcriptState = createWhisperLiveKitNativeTranscriptState()
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
        text: latestText.trim(),
        requestDurationMs: Date.now() - startedAt,
      })
    }

    const armSettleTimeout = () => {
      if (settleTimeoutId !== null) window.clearTimeout(settleTimeoutId)
      settleTimeoutId = window.setTimeout(() => {
        if (!settled && latestText.trim().length > 0) complete()
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

      const { text, buffer } = readWhisperLiveKitNativeTranscript(payload, {
        includeSpeakerLabels,
        state: transcriptState,
      })
      const combined = [text, buffer]
        .filter(Boolean)
        .join(includeSpeakerLabels ? '\n' : ' ')
        .trim()
      if (!combined) return
      if (text) {
        latestText = text
      }
      callbacks.onPartial?.(combined)
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
