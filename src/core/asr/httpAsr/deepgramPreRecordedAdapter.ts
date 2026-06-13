import type {
  AsrTransportMode,
  AsrWebSocketFeatureMode,
} from '../../../settings/schema/setting.types'
import { BaseAsrProvider } from '../base'
import {
  resolveAsrFeatureMode,
  shouldIncludeAsrSpeakerLabels,
} from '../featureMode'
import { sendAsrRawRequest } from '../httpTransport'
import type { AsrAudioInput, AsrOptions, AsrResult, AsrSegment } from '../types'

import {
  formatSpeakerAwareTranscript,
  joinUrl,
  truncateResponseBody,
} from './common'

export type DeepgramPreRecordedProviderProfile = {
  baseURL: string
  apiKey: string
  model: string
  transcriptionPath: string
  transportMode: AsrTransportMode
  language: string
  punctuation: boolean
  diarizeMode: AsrWebSocketFeatureMode
  timestamps: boolean
}

export const DEFAULT_DEEPGRAM_PRERECORDED_PATH = '/v1/listen'
const DEFAULT_DEEPGRAM_MODEL = 'nova-3'

export class DeepgramPreRecordedProvider extends BaseAsrProvider {
  readonly format = 'deepgram-prerecorded'
  private readonly profile: DeepgramPreRecordedProviderProfile

  constructor(profile: DeepgramPreRecordedProviderProfile) {
    super()
    this.profile = profile
  }

  async transcribe(
    input: AsrAudioInput,
    options?: AsrOptions,
  ): Promise<AsrResult> {
    const { baseURL, apiKey, transportMode } = this.profile
    if (!baseURL.trim()) throw new Error('ASR provider is missing baseURL.')
    if (!apiKey.trim()) throw new Error('ASR provider is missing API key.')
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const url = buildDeepgramPreRecordedUrl(this.profile, options)
    const body = await input.blob.arrayBuffer()
    const startedAt = Date.now()
    const response = await sendAsrRawRequest({
      url,
      headers: {
        Authorization: `Token ${apiKey.trim()}`,
        'Content-Type': input.blob.type || input.mimeType || 'audio/*',
      },
      body,
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

    const parsed = parseDeepgramPreRecordedResponse(response.json, {
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

export function buildDeepgramPreRecordedUrl(
  profile: DeepgramPreRecordedProviderProfile,
  options?: AsrOptions,
): string {
  const path =
    profile.transcriptionPath.trim() || DEFAULT_DEEPGRAM_PRERECORDED_PATH
  const url = new URL(joinUrl(profile.baseURL, path))
  const model = profile.model.trim() || DEFAULT_DEEPGRAM_MODEL
  const language = (options?.language ?? profile.language ?? '').trim()

  url.searchParams.set('model', model)
  if (language && language !== 'auto')
    url.searchParams.set('language', language)
  if (profile.punctuation) {
    url.searchParams.set('smart_format', 'true')
    url.searchParams.set('punctuate', 'true')
  }
  if (resolveAsrFeatureMode(profile.diarizeMode, options?.purpose)) {
    // Deepgram recommends `diarize_model` for new pre-recorded integrations;
    // it both enables diarization and pins the batch diarizer selection. Keep
    // the default auto mode file-transcription only so regular dictation is
    // not speaker-prefixed.
    url.searchParams.set('diarize_model', 'latest')
    url.searchParams.set('utterances', 'true')
  }
  return url.toString()
}

export function parseDeepgramPreRecordedResponse(
  payload: unknown,
  options: { speakerLabels?: boolean } = { speakerLabels: true },
): {
  text: string
  segments: AsrSegment[]
} {
  const includeSpeakerLabels = options.speakerLabels ?? true
  const channelTranscript = normalizeCjkTranscriptSpacing(
    extractTranscript(payload).trim(),
  )
  const utteranceSegments = extractUtteranceSegments(payload)
  if (utteranceSegments.length > 0) {
    if (!includeSpeakerLabels) {
      return {
        text:
          channelTranscript ||
          normalizeCjkTranscriptSpacing(
            utteranceSegments.map((segment) => segment.text).join('\n'),
          ),
        segments: utteranceSegments,
      }
    }
    const speakerLabel = readOnlySpeakerLabel(utteranceSegments)
    if (speakerLabel && channelTranscript) {
      return {
        text: `${speakerLabel}: ${channelTranscript}`,
        segments: utteranceSegments,
      }
    }
    return {
      text: utteranceSegments.some((segment) => segment.speakerId)
        ? normalizeCjkTranscriptSpacing(
            formatSpeakerAwareTranscript(utteranceSegments),
          )
        : channelTranscript ||
          normalizeCjkTranscriptSpacing(
            utteranceSegments.map((segment) => segment.text).join('\n'),
          ),
      segments: utteranceSegments,
    }
  }

  const wordSegments = extractWordSpeakerSegments(payload)
  if (wordSegments.length > 0) {
    if (!includeSpeakerLabels) {
      return {
        text:
          channelTranscript ||
          normalizeCjkTranscriptSpacing(
            wordSegments.map((segment) => segment.text).join(' '),
          ),
        segments: wordSegments,
      }
    }
    const speakerLabel = readOnlySpeakerLabel(wordSegments)
    if (speakerLabel && channelTranscript) {
      return {
        text: `${speakerLabel}: ${channelTranscript}`,
        segments: wordSegments,
      }
    }
    return {
      text: wordSegments.some((segment) => segment.speakerId)
        ? normalizeCjkTranscriptSpacing(
            formatSpeakerAwareTranscript(wordSegments),
          )
        : channelTranscript ||
          normalizeCjkTranscriptSpacing(
            wordSegments.map((segment) => segment.text).join(' '),
          ),
      segments: wordSegments,
    }
  }

  return { text: channelTranscript, segments: [] }
}

function extractUtteranceSegments(payload: unknown): AsrSegment[] {
  const utterances = readArray(readPath(payload, ['results', 'utterances']))
  return utterances.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const text = normalizeCjkTranscriptSpacing(
      readString(record.transcript ?? record.text).trim(),
    )
    if (!text) return []
    const speakerId = readSpeakerId(record.speaker)
    return [
      {
        startMs: secondsToMs(record.start),
        endMs: secondsToMs(record.end),
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

function extractWordSpeakerSegments(payload: unknown): AsrSegment[] {
  const words = readArray(
    readPath(payload, ['results', 'channels', 0, 'alternatives', 0, 'words']),
  )
  const segments: AsrSegment[] = []
  for (const word of words) {
    if (!word || typeof word !== 'object') continue
    const record = word as Record<string, unknown>
    const text = normalizeCjkTranscriptSpacing(
      readString(record.punctuated_word ?? record.word).trim(),
    )
    if (!text) continue
    const speakerId = readSpeakerId(record.speaker)
    const last = segments[segments.length - 1]
    if (last && last.speakerId === speakerId) {
      last.text = appendWord(last.text, text)
      last.endMs = secondsToMs(record.end) || last.endMs
      continue
    }
    segments.push({
      startMs: secondsToMs(record.start),
      endMs: secondsToMs(record.end),
      text,
      ...(speakerId
        ? { speakerId, speakerLabel: formatZeroBasedSpeakerLabel(speakerId) }
        : {}),
    })
  }
  return segments
}

function extractTranscript(payload: unknown): string {
  return readString(
    readPath(payload, [
      'results',
      'channels',
      0,
      'alternatives',
      0,
      'transcript',
    ]),
  )
}

function readPath(root: unknown, path: Array<string | number>): unknown {
  let value = root
  for (const key of path) {
    if (Array.isArray(value) && typeof key === 'number') {
      value = value[key]
      continue
    }
    if (!value || typeof value !== 'object' || typeof key !== 'string') {
      return undefined
    }
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readSpeakerId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function secondsToMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000)
    : 0
}

function appendWord(current: string, word: string): string {
  if (!current) return word
  if (/^[.,!?;:，。！？；：]/.test(word)) return `${current}${word}`
  return shouldJoinCjkWithoutSpace(current, word)
    ? `${current}${word}`
    : `${current} ${word}`
}

function normalizeCjkTranscriptSpacing(text: string): string {
  // Deepgram can emit whitespace-delimited CJK characters even when the
  // readable transcript should be adjacent. Keep Latin word spacing intact.
  let normalized = text
  let previous = ''
  while (normalized !== previous) {
    previous = normalized
    normalized = normalized
      .replace(
        /([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af])\s+([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af])/g,
        '$1$2',
      )
      .replace(
        /([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af])\s+([，。！？；：、])/g,
        '$1$2',
      )
      .replace(
        /([，。！？；：、])\s+([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af])/g,
        '$1$2',
      )
  }
  return normalized
}

function shouldJoinCjkWithoutSpace(current: string, word: string): boolean {
  const previous = current.trimEnd().at(-1) ?? ''
  const next = word.trimStart().at(0) ?? ''
  return (
    (isCjkTranscriptChar(previous) || isCjkTranscriptPunctuation(previous)) &&
    isCjkTranscriptChar(next)
  )
}

function isCjkTranscriptChar(char: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(char)
}

function isCjkTranscriptPunctuation(char: string): boolean {
  return /[，。！？；：、]/.test(char)
}

function readOnlySpeakerLabel(segments: AsrSegment[]): string | undefined {
  const labels = new Set(
    segments
      .map((segment) => segment.speakerLabel)
      .filter((label): label is string => Boolean(label)),
  )
  return labels.size === 1 ? [...labels][0] : undefined
}

function formatZeroBasedSpeakerLabel(speakerId: string): string {
  const numeric = Number(speakerId)
  if (Number.isInteger(numeric) && numeric >= 0) {
    return `Speaker ${numeric + 1}`
  }
  return /^speaker\b/i.test(speakerId) ? speakerId : `Speaker ${speakerId}`
}
