import { migrateFrom64To65 } from './64_to_65'

describe('migrateFrom64To65', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('leaves list-shaped ASR config data intact and bumps version', () => {
    const voice = {
      enabled: true,
      asrConfigs: [{ id: 'existing', format: 'deepgram-compatible-websocket' }],
      activeAsrConfigId: 'existing',
    }

    const result = migrateFrom64To65({
      version: 64,
      contextVoiceInputOptions: voice,
    })

    expect(result.version).toBe(65)
    expect(result.contextVoiceInputOptions).toBe(voice)
  })

  it('converts legacy transcription/chat profiles into flat ASR configs', () => {
    const result = migrateFrom64To65({
      version: 64,
      contextVoiceInputOptions: {
        enabled: true,
        selectedAsrApiFormat: 'openai-compatible-chat-audio-asr',
        language: 'zh',
        asrProviderProfiles: {
          'openai-compatible-transcription': {
            baseURL: 'https://api.openai.com/v1',
            apiKey: 'sk-transcription',
            model: 'whisper-1',
            transcriptionPath: '/audio/transcriptions',
          },
          'openai-compatible-chat-audio-asr': {
            baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
            apiKey: 'sk-chat',
            model: 'gemini-3.1-flash-lite',
            chatCompletionsPath: '/chat/completions',
            audioContentFormat: 'input_audio',
          },
        },
      },
    })

    const voice = result.contextVoiceInputOptions as Record<string, unknown>
    const configs = voice.asrConfigs as Array<Record<string, unknown>>
    expect(result.version).toBe(65)
    expect(configs).toHaveLength(2)
    expect(configs[0]).toMatchObject({
      name: 'Transcription',
      format: 'openai-compatible-transcription',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-transcription',
      model: 'whisper-1',
      transcriptionPath: '/audio/transcriptions',
      language: 'zh',
      audioFormat: 'auto',
      transportMode: 'node',
      longAudioPunctuation: true,
      longAudioDiarization: true,
      longAudioTimestamps: true,
    })
    expect(configs[1]).toMatchObject({
      name: 'Chat Audio',
      format: 'openai-compatible-chat-audio-asr',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'sk-chat',
      model: 'gemini-3.1-flash-lite',
      chatCompletionsPath: '/chat/completions',
      audioContentFormat: 'input_audio',
      language: 'zh',
      audioFormat: 'wav',
      transportMode: 'node',
      longAudioPunctuation: true,
      longAudioDiarization: true,
      longAudioTimestamps: true,
    })
    expect(voice.activeAsrConfigId).toBe(configs[1].id)
    expect(voice.selectedAsrApiFormat).toBeUndefined()
    expect(voice.asrProviderProfiles).toBeUndefined()
    expect(voice.language).toBeUndefined()
  })

  it('keeps voice disabled with an empty config list when legacy profiles are empty', () => {
    const result = migrateFrom64To65({
      version: 64,
      contextVoiceInputOptions: {
        enabled: false,
        asrProviderProfiles: {
          'openai-compatible-transcription': { baseURL: '', model: '' },
        },
      },
    })

    expect(result.contextVoiceInputOptions).toMatchObject({
      enabled: false,
      asrConfigs: [],
      activeAsrConfigId: '',
    })
  })
})
