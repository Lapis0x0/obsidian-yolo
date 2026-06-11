import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../../../settings/schema/setting.types'

import {
  type AudioFileSource,
  createBlobAudioFileSource,
} from './audioFileSource'
import {
  calculateDeepgramStreamingPaceDelayMs,
  calculateStreamingPaceDelayMs,
  formatLongAudioResultForInsertion,
  inspectAndPlanAudioFileTranscription,
  resolveWebSocketStreamingRealtimeRateLimit,
  trimDuplicateChunkBoundary,
} from './audioFileTranscriptionService'

const baseConfig: AsrConfig = {
  id: 'asr',
  name: 'ASR',
  asrCategory: 'http-short-audio',
  asrProvider: 'openai-compatible-transcription',
  format: 'openai-compatible-transcription',
  baseURL: 'https://example.com/v1',
  apiKey: '',
  apiSecret: '',
  appId: '',
  model: 'whisper-1',
  transcriptionPath: '/audio/transcriptions',
  jobPath: '',
  resultPath: '',
  chatCompletionsPath: '/chat/completions',
  audioContentFormat: 'input_audio',
  webSocketProtocol: 'deepgram-compatible',
  webSocketPunctuate: true,
  webSocketDiarizeMode: 'off',
  webSocketDictation: false,
  webSocketFileStreamingRate: 2,
  audioFormat: 'auto',
  transportMode: 'node',
  language: 'auto',
  longAudioPunctuation: true,
  longAudioDiarization: true,
  longAudioSpeakerCount: 0,
  longAudioTimestamps: true,
}

const options = (
  overrides: Partial<ContextVoiceInputOptions> = {},
): ContextVoiceInputOptions =>
  ({
    asrConfigs: [],
    activeAsrConfigId: '',
    activeAudioFileAsrConfigId: '',
    audioFileChunkTargetDurationSec: 120,
    audioFileOutputMetadataMode: 'metadata-timestamps',
    audioFileWavMaxDurationSec: 600,
    audioFileChunkOverlapMs: 500,
    audioFileMaxConcurrentChunks: 5,
    audioFileChunkStartStaggerMs: 1500,
    ...overrides,
  }) as ContextVoiceInputOptions

const source = (overrides: Partial<AudioFileSource> = {}): AudioFileSource => ({
  kind: 'blob',
  name: 'meeting.m4a',
  size: 100 * 1024 * 1024,
  type: 'audio/mp4',
  lastModified: 0,
  getFile: jest.fn(async () => {
    throw new Error('should not materialize')
  }),
  readSlice: jest.fn(async () => new Blob(['audio'], { type: 'audio/mp4' })),
  createObjectUrl: jest.fn(async () => null),
  ...overrides,
})

describe('trimDuplicateChunkBoundary', () => {
  it('removes an exact short phrase repeated across chunk overlap', () => {
    expect(
      trimDuplicateChunkBoundary(
        'We should ship the audio plan after review',
        'after review and then update the checklist',
      ),
    ).toBe('and then update the checklist')
  })

  it('leaves non-identical overlap candidates untouched', () => {
    expect(
      trimDuplicateChunkBoundary(
        'We should ship the audio plan after review',
        'after reviewing the checklist',
      ),
    ).toBe('after reviewing the checklist')
  })
})

describe('formatLongAudioResultForInsertion', () => {
  it('renders cloud long-audio timestamps from provider segments', () => {
    expect(
      formatLongAudioResultForInsertion(
        {
          text: 'Speaker 1: 你好。\n\nSpeaker 2: 请继续。',
          segments: [
            {
              startMs: 9100,
              endMs: 36975,
              text: '你好。',
              speakerId: '0',
              speakerLabel: 'Speaker 1',
            },
            {
              startMs: 36975,
              endMs: 38265,
              text: '请继续。',
              speakerId: '1',
              speakerLabel: 'Speaker 2',
            },
          ],
        },
        'metadata-timestamps',
      ),
    ).toBe(
      '[00:09-00:37] Speaker 1: 你好。\n\n[00:37-00:39] Speaker 2: 请继续。',
    )
  })

  it('keeps plain provider text when timestamp output is disabled', () => {
    expect(
      formatLongAudioResultForInsertion(
        {
          text: 'Speaker 1: 你好。',
          segments: [
            {
              startMs: 9100,
              endMs: 36975,
              text: '你好。',
              speakerId: '0',
              speakerLabel: 'Speaker 1',
            },
          ],
        },
        'metadata',
      ),
    ).toBe('Speaker 1: 你好。')
  })

  it('does not synthesize timestamps when the provider returns no segments', () => {
    expect(
      formatLongAudioResultForInsertion(
        { text: '普通转写正文' },
        'metadata-timestamps',
      ),
    ).toBe('普通转写正文')
  })
})

describe('calculateDeepgramStreamingPaceDelayMs', () => {
  it('paces Deepgram streaming at no faster than 1.25x realtime', () => {
    expect(
      calculateDeepgramStreamingPaceDelayMs({
        durationMs: 10_000,
        totalBytes: 1_000,
        sentBytes: 250,
        startedAt: 1_000,
        now: 1_000,
      }),
    ).toBe(2_000)
    expect(
      calculateDeepgramStreamingPaceDelayMs({
        durationMs: 10_000,
        totalBytes: 1_000,
        sentBytes: 250,
        startedAt: 1_000,
        now: 2_500,
      }),
    ).toBe(500)
  })

  it('does not pace when duration or byte totals are unavailable', () => {
    expect(
      calculateDeepgramStreamingPaceDelayMs({
        durationMs: null,
        totalBytes: 1_000,
        sentBytes: 250,
        startedAt: 1_000,
        now: 1_000,
      }),
    ).toBe(0)
    expect(
      calculateDeepgramStreamingPaceDelayMs({
        durationMs: 10_000,
        totalBytes: 0,
        sentBytes: 250,
        startedAt: 1_000,
        now: 1_000,
      }),
    ).toBe(0)
  })
})

describe('calculateStreamingPaceDelayMs', () => {
  it('uses the configured realtime multiplier for WhisperLiveKit pacing', () => {
    expect(
      calculateStreamingPaceDelayMs({
        durationMs: 10_000,
        totalBytes: 1_000,
        sentBytes: 500,
        startedAt: 1_000,
        now: 1_000,
        realtimeRateLimit: 2,
      }),
    ).toBe(2_500)
    expect(
      calculateStreamingPaceDelayMs({
        durationMs: 10_000,
        totalBytes: 1_000,
        sentBytes: 500,
        startedAt: 1_000,
        now: 1_250,
        realtimeRateLimit: 20,
      }),
    ).toBe(0)
  })
})

describe('resolveWebSocketStreamingRealtimeRateLimit', () => {
  it('paces Deepgram-compatible WebSocket configs by protocol, not provider id', () => {
    expect(
      resolveWebSocketStreamingRealtimeRateLimit({
        ...baseConfig,
        asrProvider: 'custom-compatible-service',
        format: 'deepgram-compatible-websocket',
        webSocketProtocol: 'deepgram-compatible',
      }),
    ).toBe(1.25)
  })
})

describe('inspectAndPlanAudioFileTranscription', () => {
  it('plans implemented long-audio providers as native uploads', async () => {
    const longConfig: AsrConfig = {
      ...baseConfig,
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'funasr-local',
      baseURL: 'http://127.0.0.1:8001/v1',
      model: 'paraformer',
    }

    const plan = await inspectAndPlanAudioFileTranscription({
      source: createBlobAudioFileSource(
        new File(['audio'], 'meeting.wav', { type: 'audio/wav' }),
      ),
      options: options({
        asrConfigs: [longConfig],
        activeAudioFileAsrConfigId: 'long',
      }),
    })

    expect(plan.mode).toBe('long-audio-upload')
    expect(plan.schedule).toBeNull()
  })

  it('rejects unknown long-audio providers before local short-audio planning', async () => {
    const longConfig: AsrConfig = {
      ...baseConfig,
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'speechmatics-batch',
      model: '',
    }

    await expect(
      inspectAndPlanAudioFileTranscription({
        source: createBlobAudioFileSource(
          new File(['audio'], 'meeting.wav', { type: 'audio/wav' }),
        ),
        options: options({
          asrConfigs: [longConfig],
          activeAudioFileAsrConfigId: 'long',
        }),
      }),
    ).rejects.toThrow('Long-audio ASR provider adapters are not implemented')
  })

  it('reports provider upload limits separately from local-file support', async () => {
    const longConfig: AsrConfig = {
      ...baseConfig,
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'tencent-flash',
      model: '',
    }

    await expect(
      inspectAndPlanAudioFileTranscription({
        source: source({ size: 101 * 1024 * 1024 }),
        options: options({
          asrConfigs: [longConfig],
          activeAudioFileAsrConfigId: 'long',
        }),
      }),
    ).rejects.toThrow(
      "This audio file exceeds the selected ASR provider's upload limits.",
    )
  })

  it('plans WebSocket auto streaming for large files without materializing them', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'auto',
    }

    const plan = await inspectAndPlanAudioFileTranscription({
      source: source({ getFile }),
      options: options({
        asrConfigs: [wsConfig],
        activeAudioFileAsrConfigId: 'ws',
      }),
    })

    expect(plan.mode).toBe('websocket-stream')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('rejects WebSocket container streaming for m4a/mp4 files with tail metadata', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws-tail-moov',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'auto',
    }

    await expect(
      inspectAndPlanAudioFileTranscription({
        source: mp4Source({
          getFile,
          moovBeforeMdat: false,
        }),
        options: options({
          asrConfigs: [wsConfig],
          activeAudioFileAsrConfigId: 'ws-tail-moov',
        }),
      }),
    ).rejects.toThrow('This m4a/mp4 file cannot be streamed directly')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('rejects large short-HTTP files before local decode is attempted', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })

    await expect(
      inspectAndPlanAudioFileTranscription({
        source: source({ getFile }),
        options: options({
          asrConfigs: [baseConfig],
          activeAudioFileAsrConfigId: baseConfig.id,
        }),
      }),
    ).rejects.toThrow('too large for local processing')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('does not apply the WAV/PCM duration gate to WebSocket PCM streams', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws-wav',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'wav',
    }

    const plan = await inspectAndPlanAudioFileTranscription({
      source: source({ getFile }),
      options: options({
        asrConfigs: [wsConfig],
        activeAudioFileAsrConfigId: 'ws-wav',
        audioFileWavMaxDurationSec: 600,
      }),
    })

    expect(plan.mode).toBe('websocket-stream')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('allows WebSocket PCM streams for m4a/mp4 files with tail metadata', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws-pcm-tail-moov',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'wav',
    }

    const plan = await inspectAndPlanAudioFileTranscription({
      source: mp4Source({
        getFile,
        moovBeforeMdat: false,
      }),
      options: options({
        asrConfigs: [wsConfig],
        activeAudioFileAsrConfigId: 'ws-pcm-tail-moov',
      }),
    })

    expect(plan.mode).toBe('websocket-stream')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('allows WebSocket auto streaming for fast-start m4a/mp4 files', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws-faststart',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'auto',
    }

    const plan = await inspectAndPlanAudioFileTranscription({
      source: mp4Source({
        getFile,
        moovBeforeMdat: true,
      }),
      options: options({
        asrConfigs: [wsConfig],
        activeAudioFileAsrConfigId: 'ws-faststart',
      }),
    })

    expect(plan.mode).toBe('websocket-stream')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('does not apply the WAV-like duration gate to WebSocket auto sources', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws-auto',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'auto',
    }

    const plan = await inspectAndPlanAudioFileTranscription({
      source: source({
        getFile,
        name: 'meeting.wav',
        type: 'audio/wav',
        size: 200 * 1024 * 1024,
      }),
      options: options({
        asrConfigs: [wsConfig],
        activeAudioFileAsrConfigId: 'ws-auto',
        audioFileWavMaxDurationSec: 600,
      }),
    })

    expect(plan.mode).toBe('websocket-stream')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('still rejects WAV-like short-HTTP sources using the upload-size-derived duration limit', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })

    await expect(
      inspectAndPlanAudioFileTranscription({
        source: source({
          getFile,
          name: 'meeting.wav',
          type: 'audio/wav',
          size: 200 * 1024 * 1024,
        }),
        options: options({
          asrConfigs: [baseConfig],
          activeAudioFileAsrConfigId: baseConfig.id,
          audioFileWavMaxDurationSec: 600,
        }),
      }),
    ).rejects.toThrow('WAV/PCM upload is limited to 10 minutes')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('estimates WebSocket auto upload size for WAV-like sources without reading them', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws-auto-wav',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'auto',
    }
    const wavSize = 50 * 1024 * 1024

    const plan = await inspectAndPlanAudioFileTranscription({
      source: source({
        getFile,
        name: 'meeting.wav',
        type: 'audio/wav',
        size: wavSize,
      }),
      options: options({
        asrConfigs: [wsConfig],
        activeAudioFileAsrConfigId: 'ws-auto-wav',
        audioFileWavMaxDurationSec: 60 * 60,
      }),
    })

    expect(plan.mode).toBe('websocket-stream')
    expect(plan.wavPcmUploadEstimateBytes).toBe(wavSize)
    expect(getFile).not.toHaveBeenCalled()
  })
})

function mp4Source(input: {
  getFile: AudioFileSource['getFile']
  moovBeforeMdat: boolean
}): AudioFileSource {
  const bytes = buildMp4Fixture({
    durationMs: 123_456,
    moovBeforeMdat: input.moovBeforeMdat,
  })
  return source({
    name: 'meeting.m4a',
    type: 'audio/mp4',
    size: bytes.byteLength,
    getFile: input.getFile,
    readSlice: jest.fn(async (start, end) => {
      return new Blob([bytes.slice(start, end)], { type: 'audio/mp4' })
    }),
  })
}

function buildMp4Fixture(input: {
  durationMs: number
  moovBeforeMdat: boolean
}): Uint8Array {
  const timescale = 1000
  const mvhdPayload = new Uint8Array(20)
  writeUint32Be(mvhdPayload, 12, timescale)
  writeUint32Be(mvhdPayload, 16, input.durationMs)
  const mediaData = box('mdat', new Uint8Array([1, 2, 3, 4]))
  const metadata = box('moov', box('mvhd', mvhdPayload))
  return concatBytes(
    box('ftyp', new Uint8Array([0x4d, 0x34, 0x41, 0x20])),
    ...(input.moovBeforeMdat ? [metadata, mediaData] : [mediaData, metadata]),
  )
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength)
  writeUint32Be(bytes, 0, bytes.byteLength)
  for (let i = 0; i < type.length; i++) {
    bytes[4 + i] = type.charCodeAt(i)
  }
  bytes.set(payload, 8)
  return bytes
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function writeUint32Be(bytes: Uint8Array, offset: number, value: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
  view.setUint32(0, value, false)
}
