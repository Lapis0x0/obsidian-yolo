import type { TtsOutputFormat } from '../../settings/schema/setting.types'

import { sendTtsHttpRequest } from './httpTransport'
import type {
  TtsProvider,
  TtsProviderProfile,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from './types'
import {
  base64ToArrayBuffer,
  joinUrl,
  mimeTypeForAudioFormat,
  truncateResponseBody,
  wrapPcm16AsWav,
} from './utils'

const DEFAULT_VOLCENGINE_TTS_PATH = '/api/v3/tts/unidirectional'
const DEFAULT_SAMPLE_RATE = 24000

export class VolcengineTtsHttpProvider implements TtsProvider {
  readonly format = 'volcengine-tts-http' as const
  readonly capabilities = { maxInputChars: 2000 }

  constructor(private readonly profile: TtsProviderProfile) {}

  async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    const { baseURL, apiKey } = this.profile
    const model = request.model.trim()
    const voice = request.voice.trim()
    if (!baseURL.trim() || !model || !voice) {
      throw new Error('TTS config needs baseURL, model, and voice.')
    }
    if (!apiKey.trim()) {
      throw new Error('Volcengine TTS provider needs an API key.')
    }

    const response = await sendVolcengineV3Request({
      profile: this.profile,
      request,
      path: resolveVolcengineTtsPath(this.profile.requestPath),
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Volcengine TTS request failed: ${response.status}${response.text ? ` - ${truncateResponseBody(response.text)}` : ''}`,
      )
    }

    const outputFormat = normalizeVolcengineOutputFormat(request.format)
    const audioBytes = readVolcengineChunkedAudio(response)
    if (!audioBytes) {
      throw new Error('Volcengine TTS response did not include audio data.')
    }

    return normalizeVolcengineAudioBytes({
      bytes: audioBytes,
      providerFormat: outputFormat,
      request,
    })
  }
}

export function buildVolcengineTtsRequestBody(input: {
  request: TtsSynthesisRequest
}): Record<string, unknown> {
  const outputFormat = normalizeVolcengineOutputFormat(input.request.format)
  const audioParams: Record<string, unknown> = {
    format: outputFormat === 'opus' ? 'ogg_opus' : outputFormat,
  }
  if (typeof input.request.sampleRate === 'number') {
    audioParams.sample_rate = input.request.sampleRate
  }
  const speechRate = toVolcengineRate(input.request.speed)
  if (typeof speechRate === 'number') {
    audioParams.speech_rate = speechRate
  }
  const loudnessRate = toVolcengineRate(input.request.volume)
  if (typeof loudnessRate === 'number') {
    audioParams.loudness_rate = loudnessRate
  }

  const reqParams: Record<string, unknown> = {
    text: input.request.text,
    speaker: input.request.voice,
    audio_params: audioParams,
  }
  const additions = buildVolcengineAdditions(input.request)
  if (Object.keys(additions).length > 0) {
    reqParams.additions = JSON.stringify(additions)
  }
  if (typeof input.request.pitch === 'number') {
    reqParams.post_process = {
      pitch: clampInteger(input.request.pitch, -12, 12),
    }
  }
  if (input.request.styleInstruction?.trim()) {
    reqParams.context_texts = [input.request.styleInstruction.trim()]
  }

  return {
    req_params: reqParams,
  }
}

async function sendVolcengineV3Request(input: {
  profile: TtsProviderProfile
  request: TtsSynthesisRequest
  path: string
}) {
  const requestId = createRequestId()
  const resourceId = input.request.model.trim()
  return sendTtsHttpRequest({
    url: joinUrl(input.profile.baseURL, input.path),
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': input.profile.apiKey.trim(),
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
    },
    body: JSON.stringify(
      buildVolcengineTtsRequestBody({
        request: input.request,
      }),
    ),
    transportMode: input.profile.transportMode,
    signal: input.request.signal,
  })
}

function resolveVolcengineTtsPath(path: string): string {
  return path.trim() || DEFAULT_VOLCENGINE_TTS_PATH
}

function normalizeVolcengineAudioBytes(input: {
  bytes: ArrayBuffer
  providerFormat: Exclude<TtsOutputFormat, 'pcm16' | 'aac' | 'flac'>
  request: TtsSynthesisRequest
}): TtsSynthesisResult {
  if (input.providerFormat === 'wav') {
    return {
      kind: 'file',
      bytes: input.bytes,
      mimeType: mimeTypeForAudioFormat('wav'),
      format: 'wav',
    }
  }
  if (
    input.providerFormat === 'pcm' ||
    input.request.format === 'pcm' ||
    input.request.format === 'pcm16'
  ) {
    return {
      kind: 'file',
      bytes: wrapPcm16AsWav({
        pcm: input.bytes,
        sampleRate: input.request.sampleRate ?? DEFAULT_SAMPLE_RATE,
        channels: 1,
      }),
      mimeType: mimeTypeForAudioFormat('wav'),
      format: 'wav',
    }
  }
  return {
    kind: 'file',
    bytes: input.bytes,
    mimeType: mimeTypeForAudioFormat(input.providerFormat),
    format: input.providerFormat,
  }
}

function normalizeVolcengineOutputFormat(
  format: TtsOutputFormat,
): Exclude<TtsOutputFormat, 'pcm16' | 'aac' | 'flac'> {
  switch (format) {
    case 'pcm16':
      return 'pcm'
    case 'aac':
    case 'flac':
      throw new Error('Volcengine TTS supports mp3, wav, pcm, or opus output.')
    default:
      return format
  }
}

function readVolcengineChunkedAudio(response: {
  json: unknown
  text: string
}): ArrayBuffer | null {
  const chunks: ArrayBuffer[] = []
  const messages =
    response.json && typeof response.json === 'object'
      ? [response.json]
      : parseVolcengineChunkedJsonLines(response.text)

  for (const message of messages) {
    const code = readNumericField(message, 'code')
    if (typeof code === 'number' && code > 0 && code !== 20000000) {
      const statusText = readStringField(message, 'message')
      throw new Error(
        `Volcengine TTS request failed: ${code}${statusText ? ` - ${statusText}` : ''}`,
      )
    }
    const audioData = readStringField(message, 'data').trim()
    if (audioData) chunks.push(base64ToArrayBuffer(audioData))
  }

  return chunks.length > 0 ? concatArrayBuffers(chunks) : null
}

function parseVolcengineChunkedJsonLines(text: string): unknown[] {
  if (!text.trim()) return []
  const messages: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    const data = line.trim()
    if (!data || data === '[DONE]') continue
    if (!data.startsWith('{') && !data.startsWith('[')) continue
    try {
      messages.push(JSON.parse(data))
    } catch {
      // Chunked keepalive lines can be plain text; ignore them.
    }
  }
  return messages
}

function readNumericField(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readStringField(payload: unknown, key: string): string {
  if (!payload || typeof payload !== 'object') return ''
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `yolo-${Date.now()}`
}

function buildVolcengineAdditions(
  request: TtsSynthesisRequest,
): Record<string, unknown> {
  const additions: Record<string, unknown> = {}
  const language = request.language?.trim()
  if (language && language.toLowerCase() !== 'auto') {
    additions.explicit_language = language
  }
  return additions
}

function toVolcengineRate(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return clampInteger((value - 1) * 100, -50, 100)
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function concatArrayBuffers(chunks: ArrayBuffer[]): ArrayBuffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  chunks.forEach((chunk) => {
    output.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  })
  return output.buffer
}
