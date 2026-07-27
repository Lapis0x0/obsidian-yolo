import type {
  AsrTransportMode,
  AsrWebSocketFeatureMode,
} from '../../../settings/schema/setting.types'
import { BaseAsrProvider } from '../base'
import {
  resolveAsrFeatureMode,
  shouldIncludeAsrSpeakerLabels,
} from '../featureMode'
import { sendAsrJsonRequest } from '../httpTransport'
import type { AsrAudioInput, AsrOptions, AsrResult, AsrSegment } from '../types'

import {
  blobToBase64,
  formatSpeakerAwareTranscript,
  guessAudioExtensionFromMime,
  joinUrl,
  truncateResponseBody,
} from './common'

export type VolcengineAucProviderProfile = {
  baseURL: string
  apiKey: string
  appId: string
  resourceId: string
  transcriptionPath: string
  transportMode: AsrTransportMode
  punctuation: boolean
  diarizeMode: AsrWebSocketFeatureMode
}

export const DEFAULT_VOLCENGINE_AUC_BASE_URL =
  'https://openspeech.bytedance.com'
export const DEFAULT_VOLCENGINE_AUC_FLASH_PATH =
  '/api/v3/auc/bigmodel/recognize/flash'
export const DEFAULT_VOLCENGINE_AUC_FLASH_RESOURCE = 'volc.bigasr.auc_turbo'

const VOLCENGINE_SUCCESS_CODE = '20000000'
const SUPPORTED_FLASH_EXTENSIONS = new Set(['wav', 'mp3', 'ogg'])

export class VolcengineAucFlashProvider extends BaseAsrProvider {
  readonly format = 'volcengine-auc-flash'
  private readonly profile: VolcengineAucProviderProfile

  constructor(profile: VolcengineAucProviderProfile) {
    super()
    this.profile = profile
  }

  async transcribe(
    input: AsrAudioInput,
    options?: AsrOptions,
  ): Promise<AsrResult> {
    validateVolcengineProfile(this.profile)
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const audioFormat = detectVolcengineAudioFormat(input)
    assertFlashAudioFormatSupported(audioFormat)
    const requestId = createRequestId()
    const body = await buildVolcengineAucRequestBody({
      profile: this.profile,
      audio: { data: await blobToBase64(input.blob) },
      options,
    })
    const startedAt = Date.now()
    const response = await sendAsrJsonRequest({
      url: joinUrl(
        this.profile.baseURL || DEFAULT_VOLCENGINE_AUC_BASE_URL,
        this.profile.transcriptionPath.trim() ||
          DEFAULT_VOLCENGINE_AUC_FLASH_PATH,
      ),
      headers: buildVolcengineAucHeaders({
        profile: this.profile,
        requestId,
        resourceId:
          this.profile.resourceId.trim() ||
          DEFAULT_VOLCENGINE_AUC_FLASH_RESOURCE,
        includeSequence: true,
      }),
      body,
      transportMode: this.profile.transportMode,
      signal: options?.signal,
      onUploadProgress: options?.onUploadProgress,
    })

    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    assertVolcengineResponseOk(response)
    const parsed = parseVolcengineAucResponse(response.json, {
      speakerLabels: shouldIncludeAsrSpeakerLabels(
        this.profile.diarizeMode,
        options?.purpose,
      ),
    })
    return {
      text: parsed.text,
      segments: parsed.segments.length > 0 ? parsed.segments : undefined,
      requestDurationMs: Date.now() - startedAt,
    }
  }
}

export function buildVolcengineAucHeaders(input: {
  profile: VolcengineAucProviderProfile
  requestId: string
  resourceId: string
  includeSequence: boolean
}): Record<string, string> {
  const headers: Record<string, string> = {}
  headers['X-Api-Key'] = input.profile.apiKey.trim()
  headers['X-Api-Resource-Id'] = input.resourceId
  headers['X-Api-Request-Id'] = input.requestId
  if (input.includeSequence) headers['X-Api-Sequence'] = '-1'
  return headers
}

export async function buildVolcengineAucRequestBody(input: {
  profile: VolcengineAucProviderProfile
  audio: { data: string }
  options?: AsrOptions
}): Promise<Record<string, unknown>> {
  // The standard URL-based route is intentionally not supported here; flash
  // keeps audio local until this direct base64 upload request.
  const audio: Record<string, unknown> = {
    data: input.audio.data,
  }

  const includeSpeakerInfo = resolveAsrFeatureMode(
    input.profile.diarizeMode,
    input.options?.purpose,
  )
  const request: Record<string, unknown> = {
    model_name: 'bigmodel',
    enable_itn: true,
    enable_punc: input.profile.punctuation,
    // The flash API only documents this speaker toggle for diarization; do not
    // add standard-version or guessed fields to this request body.
    enable_speaker_info: includeSpeakerInfo,
  }

  return {
    user: {
      uid:
        input.profile.appId.trim() ||
        input.profile.apiKey.trim() ||
        'obsidian-yolo',
    },
    audio,
    request,
  }
}

export function parseVolcengineAucResponse(
  payload: unknown,
  options: { speakerLabels?: boolean } = { speakerLabels: true },
): {
  text: string
  segments: AsrSegment[]
} {
  const includeSpeakerLabels = options.speakerLabels ?? true
  const resultRoots = readResultRoots(payload)
  const texts: string[] = []
  const segments: AsrSegment[] = []

  for (const root of resultRoots) {
    const text = readString(root.text).trim()
    if (text) texts.push(text)
    segments.push(...extractVolcengineUtterances(root.utterances))
  }

  if (segments.length > 0) {
    const segmentText =
      includeSpeakerLabels && segments.some((segment) => segment.speakerId)
        ? formatSpeakerAwareTranscript(segments)
        : segments.map((segment) => segment.text).join('\n')
    return {
      text: texts.join('\n').trim() || segmentText,
      segments,
    }
  }

  return {
    text: texts.join('\n').trim(),
    segments: [],
  }
}

function validateVolcengineProfile(
  profile: VolcengineAucProviderProfile,
): void {
  if (!profile.baseURL.trim()) {
    throw new Error('ASR provider is missing baseURL.')
  }
  if (!profile.apiKey.trim()) {
    throw new Error('ASR provider is missing API key.')
  }
}

function assertFlashAudioFormatSupported(format: string): void {
  if (SUPPORTED_FLASH_EXTENSIONS.has(format)) return
  throw new Error(
    'Volcengine flash ASR supports wav, mp3, or ogg-opus audio files.',
  )
}

function detectVolcengineAudioFormat(input: AsrAudioInput): string {
  const ext = guessAudioExtensionFromMime(input.mimeType || input.blob.type)
  return ext === 'ogg' ? 'ogg' : ext
}

function assertVolcengineResponseOk(response: {
  status: number
  headers: Headers
  text: string
}): void {
  if (response.status < 200 || response.status >= 300) {
    const truncated = truncateResponseBody(response.text)
    throw new Error(
      `ASR transcription failed: ${response.status}${truncated ? ` — ${truncated}` : ''}`,
    )
  }
  const statusCode = readVolcengineStatusCode(response.headers)
  if (!statusCode || statusCode === VOLCENGINE_SUCCESS_CODE) return
  const message = response.headers.get('X-Api-Message')?.trim()
  const logid = response.headers.get('X-Tt-Logid')?.trim()
  throw new Error(
    `ASR transcription failed: ${statusCode}${message ? ` — ${message}` : ''}${logid ? ` (logid: ${logid})` : ''}`,
  )
}

function readVolcengineStatusCode(headers: Headers): string | null {
  return headers.get('X-Api-Status-Code')?.trim() || null
}

function readResultRoots(payload: unknown): Array<Record<string, unknown>> {
  const root = isRecord(payload) ? payload : {}
  const result = root.result
  if (Array.isArray(result)) {
    return result.filter(isRecord)
  }
  if (isRecord(result)) return [result]
  return isRecord(root) ? [root] : []
}

function extractVolcengineUtterances(value: unknown): AsrSegment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const text = readString(item.text).trim()
    if (!text) return []
    const speakerId = readSpeakerId(
      item.speaker_id ??
        item.speaker ??
        (isRecord(item.additions) ? item.additions.speaker : undefined),
    )
    return [
      {
        startMs: readMs(item.start_time),
        endMs: readMs(item.end_time),
        text,
        ...(speakerId
          ? { speakerId, speakerLabel: formatSpeakerLabel(speakerId) }
          : {}),
      },
    ]
  })
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `yolo-${Date.now()}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.round(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.round(parsed) : 0
  }
  return 0
}

function readSpeakerId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function formatSpeakerLabel(speakerId: string): string {
  const numeric = Number(speakerId)
  if (Number.isInteger(numeric) && numeric > 0) return `Speaker ${numeric}`
  if (Number.isInteger(numeric) && numeric >= 0) return `Speaker ${numeric + 1}`
  return /^speaker\b/i.test(speakerId) ? speakerId : `Speaker ${speakerId}`
}
