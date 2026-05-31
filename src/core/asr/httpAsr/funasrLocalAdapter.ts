import type { AsrTransportMode } from '../../../settings/schema/setting.types'
import { BaseAsrProvider } from '../base'
import { sendAsrMultipartRequest } from '../httpTransport'
import type { AsrAudioInput, AsrOptions, AsrResult, AsrSegment } from '../types'

import {
  type MultipartField,
  buildMultipartBody,
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
  const rawSegments =
    firstArray(record.segments) ??
    firstArray(record.sentence_info) ??
    firstArray(record.sentenceInfo) ??
    firstArray(record.sentences) ??
    []

  return rawSegments.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const text = extractText(item).trim()
    if (!text) return []
    const speakerId = extractSpeakerId(item)
    return [
      {
        startMs: extractTimeMs(item, [
          'startMs',
          'beginMs',
          'begin_time',
          'start',
        ]),
        endMs: extractTimeMs(item, ['endMs', 'end_time', 'end']),
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

function formatSpeakerAwareTranscript(segments: ParsedFunAsrSegment[]): string {
  const blocks: Array<{ label: string | null; text: string[] }> = []
  for (const segment of segments) {
    const label = segment.speakerLabel ?? null
    const last = blocks[blocks.length - 1]
    if (last && last.label === label) {
      last.text.push(segment.text)
      continue
    }
    blocks.push({ label, text: [segment.text] })
  }

  return blocks
    .map((block) => {
      const text = block.text.join(' ').trim()
      return block.label ? `${block.label}: ${text}` : text
    })
    .filter(Boolean)
    .join('\n\n')
}

function firstArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function extractText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of ['text', 'transcript', 'sentence']) {
    if (typeof record[key] === 'string') return record[key] as string
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
): number {
  const looksFunAsrSegment =
    'spk' in record || 'speaker_id' in record || 'sentence' in record
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      // OpenAI-compatible `segments[]` usually use seconds, while FunASR
      // `sentence_info` commonly uses millisecond offsets. Prefer ms for
      // FunASR-shaped keys and for large raw offsets; otherwise treat as sec.
      if (
        looksFunAsrSegment ||
        /ms$/i.test(key) ||
        /_time$/i.test(key) ||
        value >= 1000
      ) {
        return Math.round(value)
      }
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
