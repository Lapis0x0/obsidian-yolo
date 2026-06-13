import { DashScopeCosyVoiceProvider } from './dashscopeCosyVoice'
import { sendTtsHttpRequest } from './httpTransport'
import { MimoChatAudioTtsProvider } from './mimoChatAudioTts'
import { OpenAiCompatibleSpeechProvider } from './openAiCompatibleSpeech'
import type { TtsProviderProfile } from './types'
import {
  VolcengineTtsHttpProvider,
  buildVolcengineTtsRequestBody,
} from './volcengineTtsHttp'

jest.mock('./httpTransport', () => ({
  sendTtsHttpRequest: jest.fn(),
}))

const mockedSendTtsHttpRequest = jest.mocked(sendTtsHttpRequest)

const makeProfile = (
  patch: Partial<TtsProviderProfile> = {},
): TtsProviderProfile => ({
  baseURL: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'model-from-config',
  voice: 'voice-from-config',
  outputFormat: 'mp3',
  sampleRate: null,
  speed: null,
  pitch: null,
  volume: null,
  language: '',
  styleInstruction: '',
  transportMode: 'node',
  requestPath: '',
  ...patch,
})

const bytes = (value: string): ArrayBuffer =>
  new TextEncoder().encode(value).buffer

const getJsonBody = (body: unknown): unknown => {
  if (typeof body !== 'string') {
    throw new Error('Expected JSON string request body.')
  }
  return JSON.parse(body)
}

describe('TTS provider adapters', () => {
  beforeEach(() => {
    mockedSendTtsHttpRequest.mockReset()
  })

  it('builds OpenAI-compatible speech requests', async () => {
    mockedSendTtsHttpRequest.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      body: bytes('mp3-bytes'),
      text: '',
      json: null,
    })

    const provider = new OpenAiCompatibleSpeechProvider(makeProfile())
    const result = await provider.synthesize({
      text: 'Hello world',
      voice: 'alloy',
      model: 'gpt-4o-mini-tts',
      format: 'mp3',
      speed: 1.1,
      styleInstruction: 'Speak warmly.',
    })

    const call = mockedSendTtsHttpRequest.mock.calls[0]?.[0]
    expect(call).toMatchObject({
      url: 'https://api.example.com/v1/audio/speech',
      transportMode: 'node',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-key',
      },
    })
    expect(getJsonBody(call?.body)).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: 'Hello world',
      response_format: 'mp3',
      speed: 1.1,
      instructions: 'Speak warmly.',
    })
    expect(result).toMatchObject({
      kind: 'file',
      mimeType: 'audio/mpeg',
      format: 'mp3',
    })
  })

  it('requests OpenAI-compatible pcm and wraps it as playable wav', async () => {
    mockedSendTtsHttpRequest.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      body: bytes('pcm-bytes'),
      text: '',
      json: null,
    })

    const provider = new OpenAiCompatibleSpeechProvider(makeProfile())
    const result = await provider.synthesize({
      text: 'Hello world',
      voice: 'Kore',
      model: 'google/gemini-3.1-flash-tts-preview',
      format: 'pcm',
      sampleRate: 24000,
    })

    const call = mockedSendTtsHttpRequest.mock.calls[0]?.[0]
    expect(getJsonBody(call?.body)).toMatchObject({
      response_format: 'pcm',
    })
    expect(result).toMatchObject({
      kind: 'file',
      mimeType: 'audio/wav',
      format: 'wav',
    })
  })

  it('builds MiMo chat-audio requests and decodes message.audio.data', async () => {
    mockedSendTtsHttpRequest.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: bytes('{}'),
      text: '{}',
      json: {
        choices: [
          {
            message: {
              audio: { data: 'SGVsbG8sIE1pTW8=' },
            },
          },
        ],
      },
    })

    const provider = new MimoChatAudioTtsProvider(makeProfile())
    const result = await provider.synthesize({
      text: '你好',
      voice: 'xiaoming',
      model: 'mimo-v2.5-tts',
      format: 'mp3',
      styleInstruction: '自然、清晰。',
    })

    const call = mockedSendTtsHttpRequest.mock.calls[0]?.[0]
    const body = getJsonBody(call?.body)
    expect(call?.url).toBe('https://api.example.com/v1/chat/completions')
    expect(body).toEqual({
      model: 'mimo-v2.5-tts',
      modalities: ['audio'],
      audio: {
        voice: 'xiaoming',
        format: 'mp3',
      },
      messages: [
        { role: 'user', content: '自然、清晰。' },
        { role: 'assistant', content: '你好' },
      ],
    })
    expect(new TextDecoder().decode(result.bytes)).toBe('Hello, MiMo')
  })

  it('builds DashScope CosyVoice requests and decodes JSON audio data', async () => {
    mockedSendTtsHttpRequest.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: bytes('{}'),
      text: '{}',
      json: {
        output: {
          audio: {
            data: 'SGVsbG8sIERhc2hTY29wZQ==',
          },
        },
      },
    })

    const provider = new DashScopeCosyVoiceProvider(
      makeProfile({ baseURL: 'https://dashscope.aliyuncs.com' }),
    )
    const result = await provider.synthesize({
      text: '早上好',
      voice: 'longxiaochun_v2',
      model: 'cosyvoice-v2',
      format: 'wav',
      sampleRate: 24000,
      speed: 1.05,
      language: 'zh',
      styleInstruction: '自然、温暖。',
    })

    const call = mockedSendTtsHttpRequest.mock.calls[0]?.[0]
    expect(call?.url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    )
    expect(getJsonBody(call?.body)).toEqual({
      model: 'cosyvoice-v2',
      input: {
        text: '早上好',
        voice: 'longxiaochun_v2',
        format: 'wav',
        sample_rate: 24000,
        rate: 1.05,
        language_hints: ['zh'],
        instruction: '自然、温暖。',
      },
    })
    expect(new TextDecoder().decode(result.bytes)).toBe('Hello, DashScope')
    expect(result.format).toBe('wav')
  })

  it('downloads DashScope CosyVoice audio.url responses', async () => {
    mockedSendTtsHttpRequest
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: bytes('{}'),
        text: '{}',
        json: {
          output: {
            audio: {
              data: '',
              url: 'https://dashscope-result.example.com/audio.mp3?sig=1',
            },
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        body: bytes('mp3-from-url'),
        text: '',
        json: null,
      })

    const provider = new DashScopeCosyVoiceProvider(
      makeProfile({ baseURL: 'https://dashscope.aliyuncs.com' }),
    )
    const result = await provider.synthesize({
      text: '早上好',
      voice: 'longxiaochun_v2',
      model: 'cosyvoice-v2',
      format: 'mp3',
    })

    expect(mockedSendTtsHttpRequest.mock.calls[1]?.[0]).toMatchObject({
      url: 'https://dashscope-result.example.com/audio.mp3?sig=1',
      method: 'GET',
      transportMode: 'node',
    })
    expect(new TextDecoder().decode(result.bytes)).toBe('mp3-from-url')
    expect(result).toMatchObject({
      mimeType: 'audio/mpeg',
      format: 'mp3',
    })
  })

  it('builds Volcengine v3 TTS requests and decodes chunked JSON audio', async () => {
    mockedSendTtsHttpRequest.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: bytes('{}'),
      text: [
        JSON.stringify({ code: 0, data: 'SGVsbG8sIA==' }),
        JSON.stringify({ code: 0, data: 'Vm9sY2VuZ2luZQ==' }),
        JSON.stringify({ code: 20000000, message: 'OK' }),
      ].join('\n'),
      json: null,
    })

    const provider = new VolcengineTtsHttpProvider(
      makeProfile({
        baseURL: 'https://openspeech.bytedance.com',
        model: 'seed-tts-2.0',
        voice: 'zh_female_vv_uranus_bigtts',
        requestPath: '/api/v3/tts/unidirectional',
      }),
    )
    const result = await provider.synthesize({
      text: '欢迎使用文本转语音服务。',
      voice: 'zh_female_vv_uranus_bigtts',
      model: 'seed-tts-2.0',
      format: 'mp3',
      sampleRate: 24000,
      speed: 1.2,
    })

    const call = mockedSendTtsHttpRequest.mock.calls[0]?.[0]
    expect(call?.url).toBe(
      'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    )
    expect(call?.headers).toMatchObject({
      'X-Api-Key': 'test-key',
      'X-Api-Resource-Id': 'seed-tts-2.0',
      'X-Api-Request-Id': expect.any(String),
    })
    expect(call?.headers).not.toHaveProperty('X-Api-Connect-Id')
    expect(getJsonBody(call?.body)).toEqual({
      req_params: {
        text: '欢迎使用文本转语音服务。',
        speaker: 'zh_female_vv_uranus_bigtts',
        audio_params: {
          format: 'mp3',
          sample_rate: 24000,
          speech_rate: 20,
        },
      },
    })
    expect(new TextDecoder().decode(result.bytes)).toBe('Hello, Volcengine')
  })

  it('throws Volcengine chunked JSON errors', async () => {
    mockedSendTtsHttpRequest.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: bytes('{}'),
      text: JSON.stringify({ code: 3001, message: 'invalid speaker' }),
      json: null,
    })

    const provider = new VolcengineTtsHttpProvider(
      makeProfile({
        baseURL: 'https://openspeech.bytedance.com',
        model: 'seed-tts-2.0',
        voice: 'zh_female_vv_uranus_bigtts',
      }),
    )
    await expect(
      provider.synthesize({
        text: '欢迎使用文本转语音服务。',
        voice: 'zh_female_vv_uranus_bigtts',
        model: 'seed-tts-2.0',
        format: 'mp3',
      }),
    ).rejects.toThrow('Volcengine TTS request failed: 3001 - invalid speaker')
  })

  it('builds Volcengine v3 payloads with opus mapping', () => {
    const body = buildVolcengineTtsRequestBody({
      request: {
        text: '你好',
        voice: 'voice-id',
        model: 'seed-tts-2.0',
        format: 'opus',
        language: 'zh-cn',
      },
    })

    expect(body).toMatchObject({
      req_params: {
        text: '你好',
        speaker: 'voice-id',
        audio_params: {
          format: 'ogg_opus',
        },
      },
    })
    expect(
      JSON.parse(
        (body.req_params as Record<string, unknown>).additions as string,
      ),
    ).toEqual({
      explicit_language: 'zh-cn',
    })
  })

  it('maps Volcengine speed, volume, pitch, and style fields', () => {
    expect(
      buildVolcengineTtsRequestBody({
        request: {
          text: '你好',
          voice: 'voice-id',
          model: 'seed-tts-2.0',
          format: 'mp3',
          speed: 1.5,
          volume: 0.8,
          pitch: 3.4,
          styleInstruction: '你可以用特别痛心的语气说话吗?',
        },
      }),
    ).toMatchObject({
      req_params: {
        audio_params: {
          speech_rate: 50,
          loudness_rate: -20,
        },
        post_process: {
          pitch: 3,
        },
        context_texts: ['你可以用特别痛心的语气说话吗?'],
      },
    })
  })
})
