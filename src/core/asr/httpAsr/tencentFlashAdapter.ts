import type { AsrTransportMode } from '../../../settings/schema/setting.types'
import { BaseAsrProvider } from '../base'
import { sendAsrRawRequest } from '../httpTransport'
import type { AsrAudioInput, AsrOptions, AsrResult, AsrSegment } from '../types'

import {
  formatSpeakerAwareTranscript,
  guessAudioExtensionFromMime,
  joinUrl,
  truncateResponseBody,
} from './common'
import { hmacBase64 } from './signing'

export type TencentFlashProviderProfile = {
  baseURL: string
  appId: string
  secretId: string
  secretKey: string
  engineType: string
  transcriptionPath: string
  transportMode: AsrTransportMode
  diarization: boolean
  timestamps: boolean
}

export const DEFAULT_TENCENT_FLASH_BASE_URL = 'https://asr.cloud.tencent.com'
export const DEFAULT_TENCENT_FLASH_PATH = '/asr/flash/v1'
const DEFAULT_TENCENT_ENGINE = '16k_zh'

export class TencentFlashProvider extends BaseAsrProvider {
  readonly format = 'tencent-flash'
  private readonly profile: TencentFlashProviderProfile

  constructor(profile: TencentFlashProviderProfile) {
    super()
    this.profile = profile
  }

  async transcribe(
    input: AsrAudioInput,
    options?: AsrOptions,
  ): Promise<AsrResult> {
    validateTencentProfile(this.profile)
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const body = await input.blob.arrayBuffer()
    const request = await buildTencentFlashRequest({
      profile: this.profile,
      input,
      body,
    })
    const startedAt = Date.now()
    const response = await sendAsrRawRequest({
      url: request.url,
      headers: request.headers,
      body,
      transportMode: this.profile.transportMode,
      signal: options?.signal,
      onUploadProgress: options?.onUploadProgress,
    })

    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    if (response.status < 200 || response.status >= 300) {
      const truncated = truncateResponseBody(response.text)
      throw new Error(
        `ASR transcription failed: ${response.status}${truncated ? ` — ${truncated}` : ''}`,
      )
    }

    const parsed = parseTencentFlashResponse(response.json)
    return {
      text: parsed.text,
      segments: parsed.segments.length > 0 ? parsed.segments : undefined,
      requestDurationMs: Date.now() - startedAt,
    }
  }
}

export async function buildTencentFlashRequest(input: {
  profile: TencentFlashProviderProfile
  input: AsrAudioInput
  body: ArrayBuffer
}): Promise<{ url: string; headers: Record<string, string> }> {
  const { profile } = input
  const baseURL = profile.baseURL.trim() || DEFAULT_TENCENT_FLASH_BASE_URL
  const path = buildTencentFlashPath(profile.transcriptionPath, profile.appId)
  const host = new URL(baseURL).host
  const params = buildTencentFlashParams(profile, input.input)
  const query = serializeTencentQuery(params)
  const signature = await hmacBase64(
    'SHA-1',
    profile.secretKey.trim(),
    `POST${host}${path}?${query}`,
  )
  return {
    url: `${joinUrl(baseURL, path)}?${query}`,
    headers: {
      Authorization: signature,
      'Content-Type': 'application/octet-stream',
    },
  }
}

export function parseTencentFlashResponse(payload: unknown): {
  text: string
  segments: AsrSegment[]
} {
  const root =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {}
  const code = typeof root.code === 'number' ? root.code : 0
  if (code !== 0) {
    const message =
      typeof root.message === 'string' && root.message.trim()
        ? root.message.trim()
        : `Tencent Flash ASR failed with code ${code}.`
    throw new Error(message)
  }

  const segments = readArray(root.flash_result).flatMap((channel) =>
    extractTencentChannelSegments(channel),
  )
  if (segments.length > 0) {
    return {
      text: segments.some((segment) => segment.speakerId)
        ? formatSpeakerAwareTranscript(segments)
        : segments.map((segment) => segment.text).join('\n'),
      segments,
    }
  }

  const channelTexts = readArray(root.flash_result)
    .map((channel) =>
      channel && typeof channel === 'object'
        ? readString((channel as Record<string, unknown>).text)
        : '',
    )
    .filter(Boolean)
  return { text: channelTexts.join('\n'), segments: [] }
}

function validateTencentProfile(profile: TencentFlashProviderProfile): void {
  if (!profile.baseURL.trim())
    throw new Error('ASR provider is missing baseURL.')
  if (!profile.appId.trim()) throw new Error('ASR provider is missing AppID.')
  if (!profile.secretId.trim()) {
    throw new Error('ASR provider is missing API key.')
  }
  if (!profile.secretKey.trim()) {
    throw new Error('ASR provider is missing API secret.')
  }
}

function buildTencentFlashPath(path: string, appId: string): string {
  const base = (path.trim() || DEFAULT_TENCENT_FLASH_PATH).replace(/\/+$/, '')
  if (base.includes('{{appId}}')) {
    return base.replace(/\{\{appId\}\}/g, encodeURIComponent(appId.trim()))
  }
  if (new RegExp(`/${escapeRegExp(appId.trim())}$`).test(base)) return base
  return `${base}/${encodeURIComponent(appId.trim())}`
}

function buildTencentFlashParams(
  profile: TencentFlashProviderProfile,
  input: AsrAudioInput,
): Record<string, string> {
  return {
    engine_type: profile.engineType.trim() || DEFAULT_TENCENT_ENGINE,
    secretid: profile.secretId.trim(),
    timestamp: String(Math.floor(Date.now() / 1000)),
    voice_format: detectTencentVoiceFormat(input),
    speaker_diarization: profile.diarization ? '1' : '0',
    word_info: profile.timestamps ? '1' : '0',
    filter_dirty: '0',
    filter_modal: '0',
    filter_punc: '0',
    convert_num_mode: '1',
    first_channel_only: '1',
  }
}

function serializeTencentQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map(
      (key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`,
    )
    .join('&')
}

function detectTencentVoiceFormat(input: AsrAudioInput): string {
  const ext = guessAudioExtensionFromMime(input.mimeType || input.blob.type)
  if (ext === 'webm') {
    throw new Error(
      'Tencent Flash supports wav, pcm, ogg-opus, speex, silk, mp3, m4a, aac, or amr audio files.',
    )
  }
  return ext === 'ogg' ? 'ogg-opus' : ext
}

function extractTencentChannelSegments(channel: unknown): AsrSegment[] {
  if (!channel || typeof channel !== 'object') return []
  const record = channel as Record<string, unknown>
  return readArray(record.sentence_list).flatMap((sentence) => {
    if (!sentence || typeof sentence !== 'object') return []
    const item = sentence as Record<string, unknown>
    const text = readString(item.text).trim()
    if (!text) return []
    const speakerId = readSpeakerId(item.speaker_id)
    return [
      {
        startMs: readMs(item.start_time),
        endMs: readMs(item.end_time),
        text,
        ...(speakerId
          ? {
              speakerId,
              speakerLabel: formatZeroBasedSpeakerLabel(speakerId),
            }
          : {}),
      },
    ]
  })
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : 0
}

function readSpeakerId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function formatZeroBasedSpeakerLabel(speakerId: string): string {
  const numeric = Number(speakerId)
  if (Number.isInteger(numeric) && numeric >= 0) {
    return `Speaker ${numeric + 1}`
  }
  return /^speaker\b/i.test(speakerId) ? speakerId : `Speaker ${speakerId}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
