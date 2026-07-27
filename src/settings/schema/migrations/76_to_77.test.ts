import { migrateFrom76To77 } from './76_to_77'

describe('migrateFrom76To77', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('adds voice defaults when no voice settings exist', () => {
    const result = migrateFrom76To77({ version: 76 })

    expect(result.version).toBe(77)
    expect(result.mutedModuleUpdateVersions).toEqual({})
    expect(result.contextVoiceInputOptions).toMatchObject({
      floatingIslandEnabled: true,
      floatingIslandModeOrder: [
        'toggle-listen',
        'hold-to-talk',
        'audio-file',
        'read-aloud',
      ],
      floatingIslandHiddenModes: [],
      enabled: false,
      asrConfigs: [],
      activeAsrConfigId: '',
      ttsConfigs: [],
      activeTtsConfigId: '',
      polishModelId: '',
      polishTemperature: 0.2,
      systemPromptMode: 'default',
      customSystemPrompt: '',
      interactionMode: 'toggle-listen',
      audioFileTranscriptionEnabled: false,
      voiceReadAloudEnabled: false,
      readAloudSourceMode: 'selection-or-document',
      readAloudChunkTargetChars: 500,
      readAloudPreloadSegments: 1,
      readAloudCacheEnabled: true,
      readAloudGeneratedAudioAutoSaveEnabled: true,
      readAloudGeneratedAudioSaveDir: 'YOLO/read_aloud',
      readAloudMarkdownMode: 'readable',
      activeAudioFileAsrConfigId: '',
      audioFileChunkHeaderMode: 'none',
      audioFileOutputMetadataMode: 'metadata-timestamps',
      audioFileFallbackNotePathTemplate:
        'YOLO/transcriptions/{{date}} {{time}} {{basename}}.md',
      audioFileChunkTargetDurationSec: 120,
      audioFileWavMaxDurationSec: 3600,
      audioFileMaxConcurrentChunks: 5,
      audioFileChunkStartStaggerMs: 1500,
      audioFileChunkOverlapMs: 500,
      contextRangeChars: 2000,
      maxAfterContextChars: 600,
      maxRecordingSeconds: 120,
      vadSpeechStartDecibels: -40,
      vadSilenceDecibels: -36,
      vadSpeechRequiredMs: 200,
      vadSilenceHoldMs: 1200,
      floatingIslandBottomOffsetVh: 9,
      microphoneDeviceId: '',
      ttsOutputDeviceId: '',
      autoRestartAfterAccept: false,
      documentSummaryEnabled: true,
      documentSummaryRefreshMode: 'smart',
    })
  })

  it('does not replay older upstream migrations skipped by fork history', () => {
    const result = migrateFrom76To77({
      version: 76,
      browser: {
        injectActivePageContext: true,
      },
      assistants: [
        {
          id: 'a1',
          toolPreferences: {
            yolo_local__browser_read_page: {
              enabled: true,
              approvalMode: 'require_approval',
            },
            yolo_local__fs_read: {
              enabled: true,
              approvalMode: 'full_access',
            },
          },
        },
      ],
      contextVoiceInputOptions: {
        enabled: true,
        asrConfigs: [{ id: 'asr-1', name: 'Existing ASR' }],
        activeAsrConfigId: 'asr-1',
      },
    })

    expect(result.version).toBe(77)
    expect(result.browser).toEqual({
      injectActivePageContext: true,
    })
    expect(result.contextVoiceInputOptions).toMatchObject({
      enabled: true,
      asrConfigs: [{ id: 'asr-1', name: 'Existing ASR' }],
      activeAsrConfigId: 'asr-1',
    })
    expect(result.mutedModuleUpdateVersions).toEqual({})
    const assistants = result.assistants as Array<Record<string, unknown>>
    expect(assistants[0].includeCurrentFileContent).toBeUndefined()
    expect(assistants[0].timeContextEnabled).toBeUndefined()
    const preferences = assistants[0].toolPreferences as Record<string, unknown>
    expect(preferences.yolo_local__browser_read_page).toEqual({
      enabled: true,
      approvalMode: 'require_approval',
    })
    expect(preferences.yolo_local__fs_read).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
  })

  it('preserves upstream module update mutes while adding voice defaults', () => {
    const mutedModuleUpdateVersions = { learning: '0.1.1' }

    const result = migrateFrom76To77({
      version: 76,
      mutedModuleUpdateVersions,
    })

    expect(result.version).toBe(77)
    expect(result.mutedModuleUpdateVersions).toBe(mutedModuleUpdateVersions)
    expect(result.contextVoiceInputOptions).toMatchObject({
      enabled: false,
      asrConfigs: [],
      ttsConfigs: [],
    })
  })

  it('derives new voice output defaults from a custom YOLO root', () => {
    const result = migrateFrom76To77({
      version: 76,
      yolo: { baseDir: 'Config/YOLO' },
    })

    expect(result.contextVoiceInputOptions).toMatchObject({
      readAloudGeneratedAudioSaveDir: 'Config/YOLO/read_aloud',
      audioFileFallbackNotePathTemplate:
        'Config/YOLO/transcriptions/{{date}} {{time}} {{basename}}.md',
    })
  })

  it('moves historical fixed voice defaults beneath a custom YOLO root', () => {
    const result = migrateFrom76To77({
      version: 76,
      yolo: { baseDir: 'Config/YOLO' },
      contextVoiceInputOptions: {
        readAloudGeneratedAudioSaveDir: 'YOLO/read_aloud',
        audioFileFallbackNotePathTemplate:
          'YOLO/transcriptions/{{date}} {{time}} {{basename}}.md',
      },
    })

    expect(result.contextVoiceInputOptions).toMatchObject({
      readAloudGeneratedAudioSaveDir: 'Config/YOLO/read_aloud',
      audioFileFallbackNotePathTemplate:
        'Config/YOLO/transcriptions/{{date}} {{time}} {{basename}}.md',
    })
  })

  it('preserves custom voice destinations while using a custom YOLO root', () => {
    const result = migrateFrom76To77({
      version: 76,
      yolo: { baseDir: 'Config/YOLO' },
      contextVoiceInputOptions: {
        readAloudGeneratedAudioSaveDir: 'YOLO/custom-audio',
        audioFileFallbackNotePathTemplate: 'Transcripts/{{basename}}.md',
      },
    })

    expect(result.contextVoiceInputOptions).toMatchObject({
      readAloudGeneratedAudioSaveDir: 'YOLO/custom-audio',
      audioFileFallbackNotePathTemplate: 'Transcripts/{{basename}}.md',
    })
  })

  it('leaves unrelated assistant data untouched', () => {
    const result = migrateFrom76To77({
      version: 76,
      timeContextEnabled: false,
      chatOptions: { includeCurrentFileContent: false },
      assistants: [
        { id: 'a1', name: 'Writer' },
        { id: 'a2', name: 'Coder', includeCurrentFileContent: true },
      ],
      contextVoiceInputOptions: {
        asrConfigs: [],
      },
    })

    expect(result.assistants).toEqual([
      {
        id: 'a1',
        name: 'Writer',
      },
      {
        id: 'a2',
        name: 'Coder',
        includeCurrentFileContent: true,
      },
    ])
  })

  it('converts mappable legacy ASR profiles into final list-shaped configs', () => {
    const result = migrateFrom76To77({
      version: 76,
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

    expect(result.version).toBe(77)
    expect(configs).toHaveLength(2)
    expect(configs[0]).toMatchObject({
      name: 'Transcription',
      asrCategory: 'http-short-audio',
      asrProvider: 'openai-compatible-transcription',
      format: 'openai-compatible-transcription',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-transcription',
      model: 'whisper-1',
      transcriptionPath: '/audio/transcriptions',
      language: 'zh',
      audioFormat: 'auto',
      transportMode: 'node',
      webSocketFileStreamingRate: 2,
      longAudioPunctuation: true,
      longAudioDiarizeMode: 'auto',
      longAudioTimestamps: true,
    })
    expect(configs[1]).toMatchObject({
      name: 'Chat Audio',
      asrCategory: 'http-short-audio',
      asrProvider: 'openai-compatible-chat-audio-asr',
      format: 'openai-compatible-chat-audio-asr',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'sk-chat',
      model: 'gemini-3.1-flash-lite',
      chatCompletionsPath: '/chat/completions',
      audioContentFormat: 'input_audio',
      language: 'zh',
      audioFormat: 'wav',
      transportMode: 'node',
      webSocketFileStreamingRate: 2,
      longAudioPunctuation: true,
      longAudioDiarizeMode: 'auto',
      longAudioTimestamps: true,
    })
    expect(voice.activeAsrConfigId).toBe(configs[1].id)
    expect(voice.selectedAsrApiFormat).toBeUndefined()
    expect(voice.asrProviderProfiles).toBeUndefined()
    expect(voice.language).toBeUndefined()
  })

  it('preserves existing final voice settings instead of overwriting them', () => {
    const asrConfigs = [
      {
        id: 'asr-1',
        name: 'Existing ASR',
        format: 'deepgram-compatible-websocket',
      },
    ]
    const ttsConfigs = [
      {
        id: 'tts-1',
        name: 'Existing TTS',
        format: 'openai-compatible-speech',
      },
    ]

    const result = migrateFrom76To77({
      version: 76,
      contextVoiceInputOptions: {
        floatingIslandEnabled: false,
        floatingIslandModeOrder: ['read-aloud', 'audio-file'],
        floatingIslandHiddenModes: ['hold-to-talk'],
        enabled: true,
        asrConfigs,
        activeAsrConfigId: 'asr-1',
        ttsConfigs,
        activeTtsConfigId: 'tts-1',
        polishModelId: 'model-1',
        polishTemperature: null,
        systemPromptMode: 'custom',
        customSystemPrompt: 'Custom prompt',
        interactionMode: 'read-aloud',
        audioFileTranscriptionEnabled: true,
        voiceReadAloudEnabled: true,
        readAloudSourceMode: 'document',
        readAloudChunkTargetChars: 1200,
        readAloudPreloadSegments: 2,
        readAloudCacheEnabled: false,
        readAloudGeneratedAudioAutoSaveEnabled: false,
        readAloudGeneratedAudioSaveDir: 'Custom/audio',
        readAloudMarkdownMode: 'raw',
        activeAudioFileAsrConfigId: 'asr-file',
        audioFileChunkHeaderMode: 'local-start-time',
        audioFileOutputMetadataMode: 'metadata',
        audioFileFallbackNotePathTemplate: 'Transcripts/{{basename}}.md',
        audioFileChunkTargetDurationSec: 180,
        audioFileWavMaxDurationSec: 600,
        audioFileMaxConcurrentChunks: 3,
        audioFileChunkStartStaggerMs: 2000,
        audioFileChunkOverlapMs: 900,
        contextRangeChars: 4000,
        maxAfterContextChars: 900,
        maxRecordingSeconds: 240,
        vadSpeechStartDecibels: -35,
        vadSilenceDecibels: -30,
        vadSpeechRequiredMs: 300,
        vadSilenceHoldMs: 1500,
        floatingIslandBottomOffsetVh: 12,
        microphoneDeviceId: 'mic-1',
        ttsOutputDeviceId: 'speaker-1',
        autoRestartAfterAccept: true,
        documentSummaryEnabled: false,
        documentSummaryRefreshMode: 'session',
        selectedAsrApiFormat: 'openai-compatible-transcription',
        asrProviderProfiles: { cancelled: true },
        cancelledDevelopmentOnlyMode: true,
      },
    })

    const voice = result.contextVoiceInputOptions as Record<string, unknown>
    expect(voice).toMatchObject({
      floatingIslandEnabled: false,
      floatingIslandModeOrder: [
        'read-aloud',
        'audio-file',
        'toggle-listen',
        'hold-to-talk',
      ],
      floatingIslandHiddenModes: ['hold-to-talk'],
      enabled: true,
      activeAsrConfigId: 'asr-1',
      activeTtsConfigId: 'tts-1',
      polishModelId: 'model-1',
      polishTemperature: null,
      systemPromptMode: 'custom',
      customSystemPrompt: 'Custom prompt',
      interactionMode: 'read-aloud',
      audioFileTranscriptionEnabled: true,
      voiceReadAloudEnabled: true,
      readAloudSourceMode: 'document',
      readAloudChunkTargetChars: 1200,
      readAloudPreloadSegments: 2,
      readAloudCacheEnabled: false,
      readAloudGeneratedAudioAutoSaveEnabled: false,
      readAloudGeneratedAudioSaveDir: 'Custom/audio',
      readAloudMarkdownMode: 'raw',
      activeAudioFileAsrConfigId: 'asr-file',
      audioFileChunkHeaderMode: 'local-start-time',
      audioFileOutputMetadataMode: 'metadata',
      audioFileFallbackNotePathTemplate: 'Transcripts/{{basename}}.md',
      audioFileChunkTargetDurationSec: 180,
      audioFileWavMaxDurationSec: 600,
      audioFileMaxConcurrentChunks: 3,
      audioFileChunkStartStaggerMs: 2000,
      audioFileChunkOverlapMs: 900,
      contextRangeChars: 4000,
      maxAfterContextChars: 900,
      maxRecordingSeconds: 240,
      vadSpeechStartDecibels: -35,
      vadSilenceDecibels: -30,
      vadSpeechRequiredMs: 300,
      vadSilenceHoldMs: 1500,
      floatingIslandBottomOffsetVh: 12,
      microphoneDeviceId: 'mic-1',
      ttsOutputDeviceId: 'speaker-1',
      autoRestartAfterAccept: true,
      documentSummaryEnabled: false,
      documentSummaryRefreshMode: 'session',
    })
    expect(voice.asrConfigs).toBe(asrConfigs)
    expect(voice.ttsConfigs).toBe(ttsConfigs)
    expect(voice.selectedAsrApiFormat).toBeUndefined()
    expect(voice.asrProviderProfiles).toBeUndefined()
    expect(voice.cancelledDevelopmentOnlyMode).toBeUndefined()
  })

  it('normalizes invalid modes and clamps numeric settings', () => {
    const result = migrateFrom76To77({
      version: 76,
      contextVoiceInputOptions: {
        floatingIslandModeOrder: ['read-aloud', 'read-aloud', 'bogus'],
        floatingIslandHiddenModes: ['audio-file', 'bogus', 'audio-file'],
        interactionMode: 'hold-to-talk',
        systemPromptMode: 'cancelled-mode',
        polishTemperature: 99,
        readAloudSourceMode: 'cancelled-source',
        readAloudChunkTargetChars: 9999,
        readAloudPreloadSegments: -10,
        audioFileChunkHeaderMode: 'removed-header',
        audioFileOutputMetadataMode: 'full',
        audioFileFallbackNotePathTemplate: '   ',
        audioFileChunkTargetDurationSec: 5,
        audioFileWavMaxDurationSec: 99999,
        audioFileMaxConcurrentChunks: 99,
        audioFileChunkStartStaggerMs: 10,
        audioFileChunkOverlapMs: -1,
        contextRangeChars: -1,
        maxAfterContextChars: -10,
        maxRecordingSeconds: 9999,
        vadSpeechStartDecibels: -99,
        vadSilenceDecibels: 0,
        vadSpeechRequiredMs: 1,
        vadSilenceHoldMs: 99999,
        floatingIslandBottomOffsetVh: 99,
        documentSummaryRefreshMode: 'cancelled-refresh',
      },
    })

    expect(result.contextVoiceInputOptions).toMatchObject({
      floatingIslandModeOrder: [
        'hold-to-talk',
        'read-aloud',
        'toggle-listen',
        'audio-file',
      ],
      floatingIslandHiddenModes: ['audio-file'],
      interactionMode: 'hold-to-talk',
      systemPromptMode: 'default',
      polishTemperature: 2,
      readAloudSourceMode: 'selection-or-document',
      readAloudChunkTargetChars: 6000,
      readAloudPreloadSegments: 0,
      audioFileChunkHeaderMode: 'none',
      audioFileOutputMetadataMode: 'metadata',
      audioFileFallbackNotePathTemplate:
        'YOLO/transcriptions/{{date}} {{time}} {{basename}}.md',
      audioFileChunkTargetDurationSec: 15,
      audioFileWavMaxDurationSec: 7200,
      audioFileMaxConcurrentChunks: 5,
      audioFileChunkStartStaggerMs: 1000,
      audioFileChunkOverlapMs: 0,
      contextRangeChars: 0,
      maxAfterContextChars: 0,
      maxRecordingSeconds: 900,
      vadSpeechStartDecibels: -50,
      vadSilenceDecibels: -5,
      vadSpeechRequiredMs: 50,
      vadSilenceHoldMs: 5000,
      floatingIslandBottomOffsetVh: 50,
      documentSummaryRefreshMode: 'smart',
    })
  })
})
