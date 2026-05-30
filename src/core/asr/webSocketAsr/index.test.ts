import type { AsrStreamingSession } from '../types'

import type { WebSocketAsrProfile } from './common'
import {
  openDeepgramCompatibleStream,
  sendDeepgramCompatibleClip,
} from './deepgramAdapter'
import { openWhisperLiveKitNativeStream } from './whisperLiveKitAdapter'

import { WebSocketAsrProvider } from './index'

jest.mock('./deepgramAdapter', () => ({
  openDeepgramCompatibleStream: jest.fn(),
  sendDeepgramCompatibleClip: jest.fn(),
}))

jest.mock('./whisperLiveKitAdapter', () => ({
  openWhisperLiveKitNativeStream: jest.fn(),
}))

const mockedOpenDeepgramCompatibleStream = jest.mocked(
  openDeepgramCompatibleStream,
)
const mockedSendDeepgramCompatibleClip = jest.mocked(sendDeepgramCompatibleClip)
const mockedOpenWhisperLiveKitNativeStream = jest.mocked(
  openWhisperLiveKitNativeStream,
)

const makeSession = (): AsrStreamingSession => ({
  sendAudioChunk: jest.fn(),
  finish: jest.fn(async () => ({ text: '' })),
  cancel: jest.fn(),
})

const makeProfile = (
  overrides: Partial<WebSocketAsrProfile> = {},
): WebSocketAsrProfile => ({
  baseURL: 'wss://api.deepgram.com/v1',
  apiKey: 'dg-key',
  model: 'nova-3',
  listenPath: '/listen',
  webSocketProtocol: 'deepgram-compatible',
  webSocketPunctuate: true,
  webSocketDiarizeMode: 'off',
  webSocketDictation: false,
  audioFormat: 'auto',
  language: 'auto',
  ...overrides,
})

describe('WebSocketAsrProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedOpenDeepgramCompatibleStream.mockResolvedValue(makeSession())
    mockedOpenWhisperLiveKitNativeStream.mockResolvedValue(makeSession())
    mockedSendDeepgramCompatibleClip.mockResolvedValue('transcript')
  })

  it('passes Deepgram-compatible WS feature options to streaming URLs', async () => {
    const provider = new WebSocketAsrProvider(
      makeProfile({
        webSocketDiarizeMode: 'on',
        webSocketDictation: true,
      }),
    )

    await provider.startStreaming({}, {})

    const url = new URL(
      mockedOpenDeepgramCompatibleStream.mock.calls[0]?.[0].url ?? '',
    )
    expect(url.searchParams.get('smart_format')).toBe('true')
    expect(url.searchParams.get('punctuate')).toBe('true')
    expect(url.searchParams.get('diarize')).toBe('true')
    expect(url.searchParams.get('dictation')).toBe('true')
  })

  it('can disable Deepgram-compatible punctuation without smart_format', async () => {
    const provider = new WebSocketAsrProvider(
      makeProfile({
        webSocketPunctuate: false,
        webSocketDiarizeMode: 'off',
        webSocketDictation: true,
      }),
    )

    await provider.startStreaming({}, {})

    const url = new URL(
      mockedOpenDeepgramCompatibleStream.mock.calls[0]?.[0].url ?? '',
    )
    expect(url.searchParams.get('smart_format')).toBeNull()
    expect(url.searchParams.get('punctuate')).toBe('false')
    expect(url.searchParams.get('dictation')).toBeNull()
  })

  it('does not send Deepgram feature params to WhisperLiveKit native streams', async () => {
    const provider = new WebSocketAsrProvider(
      makeProfile({
        baseURL: 'ws://127.0.0.1:8000',
        listenPath: '/asr',
        webSocketProtocol: 'whisperlivekit-native',
        webSocketDiarizeMode: 'on',
        webSocketDictation: true,
      }),
    )

    await provider.startStreaming({}, {})

    const url = new URL(
      mockedOpenWhisperLiveKitNativeStream.mock.calls[0]?.[0].url ?? '',
    )
    expect(url.searchParams.get('smart_format')).toBeNull()
    expect(url.searchParams.get('punctuate')).toBeNull()
    expect(url.searchParams.get('diarize')).toBeNull()
    expect(url.searchParams.get('dictation')).toBeNull()
    expect(url.searchParams.get('interim_results')).toBeNull()
    expect(
      mockedOpenWhisperLiveKitNativeStream.mock.calls[0]?.[0]
        .includeSpeakerLabels,
    ).toBe(false)
  })

  it('uses the same Deepgram-compatible options for settings test clips', async () => {
    const provider = new WebSocketAsrProvider(
      makeProfile({
        webSocketDiarizeMode: 'on',
        webSocketDictation: true,
      }),
    )

    await provider.transcribe({
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      mimeType: 'audio/webm',
    })

    const url = new URL(
      mockedSendDeepgramCompatibleClip.mock.calls[0]?.[0].url ?? '',
    )
    expect(url.searchParams.get('smart_format')).toBe('true')
    expect(url.searchParams.get('punctuate')).toBe('true')
    expect(url.searchParams.get('diarize')).toBe('true')
    expect(url.searchParams.get('dictation')).toBe('true')
  })

  it('resolves auto speaker options by streaming purpose', async () => {
    const provider = new WebSocketAsrProvider(
      makeProfile({
        webSocketDiarizeMode: 'auto',
      }),
    )

    await provider.startStreaming({ purpose: 'context-voice-input' }, {})
    await provider.startStreaming({ purpose: 'audio-file-transcription' }, {})

    const contextUrl = new URL(
      mockedOpenDeepgramCompatibleStream.mock.calls[0]?.[0].url ?? '',
    )
    const transcriptionUrl = new URL(
      mockedOpenDeepgramCompatibleStream.mock.calls[1]?.[0].url ?? '',
    )
    expect(contextUrl.searchParams.get('diarize')).toBeNull()
    expect(transcriptionUrl.searchParams.get('diarize')).toBe('true')
    expect(
      mockedOpenDeepgramCompatibleStream.mock.calls[0]?.[0]
        .includeSpeakerLabels,
    ).toBe(false)
    expect(
      mockedOpenDeepgramCompatibleStream.mock.calls[1]?.[0]
        .includeSpeakerLabels,
    ).toBe(true)
  })
})
