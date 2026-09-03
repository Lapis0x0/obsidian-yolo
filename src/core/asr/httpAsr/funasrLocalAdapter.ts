import type { AsrTransportMode } from '../../../settings/schema/setting.types'
import { BaseAsrProvider } from '../base'
import { sendAsrMultipartRequest } from '../httpTransport'
import type { AsrAudioInput, AsrOptions, AsrResult, AsrSegment } from '../types'

import {
  type MultipartField,
  buildMultipartBody,
  formatSpeakerAwareTranscript,
  generateMultipartBoundary,
  guessAudioExtensionFromMime,
  joinUrl,
  truncateResponseBody,
} from './common'

export type FunAsrLocalProviderProfile = {
  baseURL: string
  apiKey: string
  model: string
  transcriptionPath: string
  transportMode: AsrTransportMode
  language: string
}

type ParsedFunAsrSegment = AsrSegment & {
  speakerId?: string
  speakerLabel?: string
}

type FunAsrSegmentSource =
  | 'segments'
  | 'sentence_info'
  | 'sentenceInfo'
  | 'sentences'

type RawFunAsrSegments = {
  source: FunAsrSegmentSource
  items: unknown[]
}

type PlainStartEndUnit = 'seconds' | 'milliseconds'

export const DEFAULT_FUNASR_TRANSCRIPTION_PATH = '/audio/transcriptions'
const DEFAULT_FUNASR_MODEL = 'paraformer'

/**
 * FunASR local adapter.
 *
 * FunASR can serve short recordings and long files through the same local
 * OpenAI-compatible transcription API. Audio-file transcription keeps speaker
 * labels when the local pipeline returns `sentence_info`; context voice input
 * receives plain text so ordinary dictation is not polluted by speaker labels.
 */
export class FunAsrLocalProvider extends BaseAsrProvider {
  readonly format = 'funasr-local'
  private readonly profile: FunAsrLocalProviderProfile

  constructor(profile: FunAsrLocalProviderProfile) {
    super()
    this.profile = profile
  }

  async transcribe(
    input: AsrAudioInput,
    options?: AsrOptions,
  ): Promise<AsrResult> {
    const { baseURL, apiKey, transcriptionPath, transportMode, language } =
      this.profile
    if (!baseURL.trim()) {
      throw new Error('ASR provider is missing baseURL.')
    }
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const path =
      transcriptionPath && transcriptionPath.trim().length > 0
        ? transcriptionPath
        : DEFAULT_FUNASR_TRANSCRIPTION_PATH
    const url = joinUrl(baseURL, path)
    const model = this.profile.model.trim() || DEFAULT_FUNASR_MODEL
    const ext = guessAudioExtensionFromMime(
      input.mimeType || input.blob.type || '',
    )
    const fileContentType = input.blob.type || input.mimeType || 'audio/*'
    const langCandidate = (options?.language ?? language ?? '').trim()

    const fields: MultipartField[] = [
      {
        name: 'file',
        filename: `audio.${ext}`,
        contentType: fileContentType,
        blob: input.blob,
      },
      { name: 'model', value: model },
      { name: 'response_format', value: 'verbose_json' },
    ]
    if (langCandidate && langCandidate !== 'auto') {
      fields.push({ name: 'language', value: langCandidate })
    }

    const boundary = generateMultipartBoundary()
    const body = await buildMultipartBody(boundary, fields)
    const headers: Record<string, string> = {}
    if (apiKey && apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${apiKey.trim()}`
    }

    const startedAt = Date.now()
    const response = await sendAsrMultipartRequest({
      url,
      body,
      boundary,
      headers,
      transportMode,
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

    const parsed = parseFunAsrResponse(response.json, {
      speakerLabels: options?.purpose === 'audio-file-transcription',
    })
    return {
      text: parsed.text,
      segments: parsed.segments.length > 0 ? parsed.segments : undefined,
      requestDurationMs: Date.now() - startedAt,
    }
  }
}

export function parseFunAsrResponse(
  payload: unknown,
  options: { speakerLabels?: boolean } = {},
): {
  text: string
  segments: ParsedFunAsrSegment[]
} {
  const root = unwrapFunAsrRoot(payload)
  const segments = extractFunAsrSegments(root)
  if (
    options.speakerLabels &&
    segments.length > 0 &&
    segments.some((segment) => segment.speakerId)
  ) {
    return {
      text: formatSpeakerAwareTranscript(segments),
      segments,
    }
  }

  const text = extractText(root) || segments.map((s) => s.text).join('\n')
  return { text, segments }
}

function unwrapFunAsrRoot(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload[0] ?? null
  if (!payload || typeof payload !== 'object') return payload
  const record = payload as Record<string, unknown>
  const nested =
    record.result ?? record.results ?? record.data ?? record.output ?? null
  if (Array.isArray(nested)) return nested[0] ?? record
  if (nested && typeof nested === 'object') return nested
  return record
}

function extractFunAsrSegments(payload: unknown): ParsedFunAsrSegment[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const rawSegments = findRawFunAsrSegments(record)
  const plainStartEndUnit = inferPlainStartEndUnit(rawSegments)

  return (rawSegments?.items ?? []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const text = extractText(item).trim()
    if (!text) return []
    const speakerId = extractSpeakerId(item)
    return [
      {
        startMs: extractTimeMs(
          item,
          ['startMs', 'beginMs', 'begin_time', 'start'],
          plainStartEndUnit,
        ),
        endMs: extractTimeMs(
          item,
          ['endMs', 'end_time', 'end'],
          plainStartEndUnit,
        ),
        text,
        ...(speakerId
          ? {
              speakerId,
              speakerLabel: formatSpeakerLabel(speakerId),
            }
          : {}),
      },
    ]
  })
}

function findRawFunAsrSegments(
  record: Record<string, unknown>,
): RawFunAsrSegments | null {
  for (const source of [
    'segments',
    'sentence_info',
    'sentenceInfo',
    'sentences',
  ] as const) {
    const value = record[source]
    if (Array.isArray(value)) return { source, items: value }
  }
  return null
}

function inferPlainStartEndUnit(
  rawSegments: RawFunAsrSegments | null,
): PlainStartEndUnit | null {
  if (!rawSegments) return null

  if (rawSegments.source === 'segments') {
    return 'seconds'
  }

  for (const entry of rawSegments.items) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    for (const key of ['start', 'end']) {
      const value = record[key]
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        !Number.isInteger(value)
      ) {
        return 'seconds'
      }
    }
  }

  // FunASR's native sentence_info-style payloads conventionally report
  // integer start/end offsets in milliseconds.
  return 'milliseconds'
}

function extractText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of ['text', 'transcript', 'sentence']) {
    if (typeof record[key] === 'string') return record[key]
  }
  return ''
}

function extractSpeakerId(record: Record<string, unknown>): string | undefined {
  for (const key of ['speaker', 'speaker_id', 'speakerId', 'spk']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function extractTimeMs(
  record: Record<string, unknown>,
  keys: string[],
  plainStartEndUnit: PlainStartEndUnit | null,
): number {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (/_?ms$/i.test(key) || /_time$/i.test(key)) {
        return Math.round(value)
      }
      if (key === 'start' || key === 'end') {
        if (plainStartEndUnit === 'milliseconds') return Math.round(value)
        if (plainStartEndUnit === 'seconds') return Math.round(value * 1000)
      }
      if (!Number.isInteger(value)) return Math.round(value * 1000)
      if (value >= 1000) return Math.round(value)
      return Math.round(value * 1000)
    }
  }
  return 0
}

function formatSpeakerLabel(speakerId: string): string {
  const trimmed = speakerId.trim()
  if (/^speaker\b/i.test(trimmed)) return trimmed
  const numeric = Number(trimmed)
  if (Number.isInteger(numeric) && numeric >= 0) {
    return `Speaker ${numeric + 1}`
  }
  return `Speaker ${trimmed}`
}
