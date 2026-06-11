import { App, Notice } from 'obsidian'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type { BaseAsrProvider } from '../../../core/asr/base'
import type {
  AsrAudioInput,
  AsrStreamingSession,
} from '../../../core/asr/types'
import type { VoiceInputRecorder } from '../../../features/editor/voice/context-input/voiceInputRecorder'
import YoloPlugin from '../../../main'
import {
  ASR_AUDIO_FORMATS,
  ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
  ASR_WEBSOCKET_FILE_STREAMING_RATE_MAX,
  ASR_WEBSOCKET_FILE_STREAMING_RATE_MIN,
  type AsrApiFormat,
  type AsrAudioFormat,
  type AsrConfig,
  type AsrConfigCategory,
  type AsrTransportMode,
  type AsrWebSocketFeatureMode,
  type AsrWebSocketProtocol,
} from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'

type AsrConfigFormProps = {
  plugin: YoloPlugin
  /** null when adding a brand-new config. */
  config: AsrConfig | null
  category?: AsrConfigCategory
}

const TEST_RECORDING_SECONDS = 5
const STREAMING_TEST_MAX_SECONDS = 24 * 60 * 60

// Per-format defaults that get *written* into the form (not just shown as
// placeholder) when the user picks that format. Previous version showed
// greyed-out placeholders, then complained "Base URL is required" on save —
// fields are now genuinely pre-filled and ready.
type FormatDefaults = {
  name: string
  asrCategory: AsrConfigCategory
  asrProvider: string
  baseURL: string
  model: string
  transcriptionPath: string
  chatCompletionsPath: string
  audioContentFormat: string
  webSocketProtocol: AsrWebSocketProtocol
  webSocketPunctuate: boolean
  webSocketDiarizeMode: AsrWebSocketFeatureMode
  webSocketDictation: boolean
  webSocketFileStreamingRate: number
  audioFormat: AsrAudioFormat
  language: string
}
// Default values that get *written* into the form (not just shown as
// placeholders) when the user picks that format. We list popular endpoints
// so the new-config flow has a working starting point, but never claim the
// user has to use them — every field is editable.
const FORMAT_DEFAULTS: Record<AsrApiFormat, FormatDefaults> = {
  'openai-compatible-transcription': {
    name: 'OpenAI Whisper',
    asrCategory: 'http-short-audio',
    asrProvider: 'openai-compatible-transcription',
    baseURL: 'https://api.openai.com/v1',
    model: 'whisper-1',
    transcriptionPath: '',
    chatCompletionsPath: '',
    audioContentFormat: 'input_audio',
    webSocketProtocol: 'deepgram-compatible',
    webSocketPunctuate: true,
    webSocketDiarizeMode: 'off',
    webSocketDictation: false,
    webSocketFileStreamingRate: ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
    audioFormat: 'auto',
    language: 'auto',
  },
  'openai-compatible-chat-audio-asr': {
    name: 'Chat Audio',
    asrCategory: 'http-short-audio',
    asrProvider: 'openai-compatible-chat-audio-asr',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.1-flash-lite',
    transcriptionPath: '',
    chatCompletionsPath: '',
    audioContentFormat: 'input_audio',
    webSocketProtocol: 'deepgram-compatible',
    webSocketPunctuate: true,
    webSocketDiarizeMode: 'off',
    webSocketDictation: false,
    webSocketFileStreamingRate: ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
    // Many chat-audio endpoints reject webm — wav transcode is the safest
    // default. Switch to `auto` if you know your endpoint takes webm/opus.
    audioFormat: 'wav',
    language: 'auto',
  },
  'deepgram-compatible-websocket': {
    name: 'Deepgram WS',
    asrCategory: 'websocket',
    asrProvider: 'deepgram',
    baseURL: 'wss://api.deepgram.com/v1',
    model: 'nova-3',
    transcriptionPath: '/listen',
    chatCompletionsPath: '',
    audioContentFormat: 'input_audio',
    webSocketProtocol: 'deepgram-compatible',
    webSocketPunctuate: true,
    webSocketDiarizeMode: 'auto',
    webSocketDictation: false,
    webSocketFileStreamingRate: ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
    audioFormat: 'wav',
    language: 'zh',
  },
}

// Reuse the same transport labels as LLM providers so ASR does not invent a
// parallel vocabulary for the same request layer.
const TRANSPORT_LABEL_FALLBACK: Record<AsrTransportMode, string> = {
  auto: 'Auto (recommended)',
  browser: 'Browser fetch only',
  obsidian: 'Obsidian requestUrl only',
  node: 'Desktop Node fetch only',
}

const WS_PROTOCOL_DEFAULTS: Record<
  AsrWebSocketProtocol,
  Pick<
    FormatDefaults,
    | 'name'
    | 'baseURL'
    | 'model'
    | 'transcriptionPath'
    | 'audioFormat'
    | 'asrProvider'
    | 'webSocketPunctuate'
    | 'webSocketDiarizeMode'
    | 'webSocketDictation'
    | 'webSocketFileStreamingRate'
  >
> = {
  'deepgram-compatible': {
    name: 'Deepgram WS',
    asrProvider: 'deepgram',
    baseURL: 'wss://api.deepgram.com/v1',
    model: 'nova-3',
    transcriptionPath: '/listen',
    audioFormat: 'wav',
    webSocketPunctuate: true,
    webSocketDiarizeMode: 'auto',
    webSocketDictation: false,
    webSocketFileStreamingRate: ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
  },
  'whisperlivekit-native': {
    name: 'WhisperLiveKit WS',
    asrProvider: 'whisperlivekit',
    baseURL: 'ws://127.0.0.1:8000',
    model: '',
    transcriptionPath: '/asr',
    audioFormat: 'auto',
    webSocketPunctuate: false,
    webSocketDiarizeMode: 'auto',
    webSocketDictation: false,
    webSocketFileStreamingRate: ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
  },
}

type AsrLongAudioProvider =
  | 'funasr-local'
  | 'deepgram-prerecorded'
  | 'tencent-flash'

type LongAudioProviderDefaults = Pick<
  FormatDefaults,
  | 'name'
  | 'asrProvider'
  | 'baseURL'
  | 'model'
  | 'transcriptionPath'
  | 'audioFormat'
  | 'language'
> & {
  jobPath: string
  resultPath: string
  appId: string
  apiSecret: string
  longAudioDiarization: boolean
  longAudioPunctuation: boolean
  longAudioSpeakerCount: number
  longAudioTimestamps: boolean
}

type AsrTestStatus =
  | 'idle'
  | 'recording'
  | 'finalizing'
  | 'transcribing'
  | 'passed'
  | 'failed'

type StreamingTestRuntime = {
  recorder: VoiceInputRecorder
  session: AsrStreamingSession
}

type VoiceInputRecorderConstructor = new () => VoiceInputRecorder

const LONG_AUDIO_PROVIDER_DEFAULTS: Record<
  AsrLongAudioProvider,
  LongAudioProviderDefaults
> = {
  'funasr-local': {
    name: 'FunASR local',
    asrProvider: 'funasr-local',
    baseURL: 'http://127.0.0.1:8001/v1',
    model: 'paraformer',
    transcriptionPath: '/audio/transcriptions',
    jobPath: '',
    resultPath: '',
    audioFormat: 'auto',
    language: 'zh',
    appId: '',
    apiSecret: '',
    longAudioPunctuation: false,
    longAudioDiarization: true,
    longAudioSpeakerCount: 0,
    longAudioTimestamps: true,
  },
  'deepgram-prerecorded': {
    name: 'Deepgram pre-recorded',
    asrProvider: 'deepgram-prerecorded',
    baseURL: 'https://api.deepgram.com',
    model: 'nova-3',
    transcriptionPath: '/v1/listen',
    jobPath: '',
    resultPath: '',
    audioFormat: 'auto',
    language: 'auto',
    appId: '',
    apiSecret: '',
    longAudioPunctuation: true,
    longAudioDiarization: true,
    longAudioSpeakerCount: 0,
    longAudioTimestamps: true,
  },
  'tencent-flash': {
    name: 'Tencent Flash',
    asrProvider: 'tencent-flash',
    baseURL: 'https://asr.cloud.tencent.com',
    model: '16k_zh',
    transcriptionPath: '/asr/flash/v1',
    jobPath: '',
    resultPath: '',
    audioFormat: 'auto',
    language: 'zh',
    appId: '',
    apiSecret: '',
    longAudioPunctuation: false,
    longAudioDiarization: true,
    longAudioSpeakerCount: 0,
    longAudioTimestamps: true,
  },
}

const generateId = (): string =>
  `asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const formatTemplate = (
  template: string,
  values: Record<string, string | number>,
): string =>
  Object.entries(values).reduce(
    (text, [key, value]) =>
      text.replace(new RegExp(`{{${key}}}`, 'g'), String(value)),
    template,
  )

export class AddAsrConfigModal extends ReactModal<AsrConfigFormProps> {
  constructor(
    app: App,
    plugin: YoloPlugin,
    category: AsrConfigCategory = 'http-short-audio',
  ) {
    super({
      app,
      Component: AsrConfigFormComponent,
      props: { plugin, config: null, category },
      options: { title: 'Add ASR configuration' },
      plugin,
    })
  }
}

export class EditAsrConfigModal extends ReactModal<AsrConfigFormProps> {
  constructor(app: App, plugin: YoloPlugin, config: AsrConfig) {
    super({
      app,
      Component: AsrConfigFormComponent,
      props: { plugin, config },
      options: { title: `Edit ASR config: ${config.name || config.id}` },
      plugin,
    })
  }
}

function AsrConfigFormComponent({
  plugin,
  config,
  category,
  onClose,
}: AsrConfigFormProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const isEdit = !!config

  const [formData, setFormData] = useState<AsrConfig>(() => {
    if (config) {
      return {
        ...config,
        webSocketFileStreamingRate:
          config.webSocketFileStreamingRate ??
          ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
      }
    }
    // First-time add: start from the transcription default (most common new
    // user flow). The Format picker swaps in matching defaults when changed.
    const initialCategory = category ?? 'http-short-audio'
    const fmt: AsrApiFormat =
      initialCategory === 'websocket'
        ? 'deepgram-compatible-websocket'
        : 'openai-compatible-transcription'
    const def = FORMAT_DEFAULTS[fmt]
    const longDef = LONG_AUDIO_PROVIDER_DEFAULTS['funasr-local']
    return {
      id: generateId(),
      name: initialCategory === 'http-long-audio' ? longDef.name : def.name,
      asrCategory: initialCategory,
      asrProvider:
        initialCategory === 'http-long-audio'
          ? longDef.asrProvider
          : def.asrProvider,
      format: fmt,
      baseURL:
        initialCategory === 'http-long-audio' ? longDef.baseURL : def.baseURL,
      apiKey: '',
      apiSecret: initialCategory === 'http-long-audio' ? longDef.apiSecret : '',
      appId: initialCategory === 'http-long-audio' ? longDef.appId : '',
      model: initialCategory === 'http-long-audio' ? longDef.model : def.model,
      transcriptionPath:
        initialCategory === 'http-long-audio'
          ? longDef.transcriptionPath
          : def.transcriptionPath,
      jobPath: initialCategory === 'http-long-audio' ? longDef.jobPath : '',
      resultPath:
        initialCategory === 'http-long-audio' ? longDef.resultPath : '',
      chatCompletionsPath: def.chatCompletionsPath,
      audioContentFormat: def.audioContentFormat,
      webSocketProtocol: def.webSocketProtocol,
      webSocketPunctuate: def.webSocketPunctuate,
      webSocketDiarizeMode: def.webSocketDiarizeMode,
      webSocketDictation: def.webSocketDictation,
      webSocketFileStreamingRate: def.webSocketFileStreamingRate,
      audioFormat:
        initialCategory === 'http-long-audio'
          ? longDef.audioFormat
          : def.audioFormat,
      transportMode: 'node',
      language:
        initialCategory === 'http-long-audio' ? longDef.language : def.language,
      longAudioPunctuation:
        initialCategory === 'http-long-audio'
          ? longDef.longAudioPunctuation
          : true,
      longAudioDiarization:
        initialCategory === 'http-long-audio'
          ? longDef.longAudioDiarization
          : true,
      longAudioSpeakerCount:
        initialCategory === 'http-long-audio'
          ? longDef.longAudioSpeakerCount
          : 0,
      longAudioTimestamps:
        initialCategory === 'http-long-audio'
          ? longDef.longAudioTimestamps
          : true,
    }
  })
  const [testRunning, setTestRunning] = useState(false)
  const [streamingTestActive, setStreamingTestActive] = useState(false)
  const [testMessage, setTestMessage] = useState<string>('')
  const [testTranscript, setTestTranscript] = useState<string>('')
  const [testStatus, setTestStatus] = useState<AsrTestStatus>('idle')
  const [webSocketFileStreamingRateInput, setWebSocketFileStreamingRateInput] =
    useState(() =>
      String(
        config?.webSocketFileStreamingRate ??
          ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
      ),
    )
  const streamingTestRef = useRef<StreamingTestRuntime | null>(null)

  const isChatAudio = formData.format === 'openai-compatible-chat-audio-asr'
  const isHttpLongAudio = formData.asrCategory === 'http-long-audio'
  const isTencentFlash =
    isHttpLongAudio && formData.asrProvider === 'tencent-flash'
  const isDeepgramPreRecorded =
    isHttpLongAudio && formData.asrProvider === 'deepgram-prerecorded'
  const isCloudLongAudio =
    isHttpLongAudio && formData.asrProvider !== 'funasr-local'
  const isWebSocketAsr =
    formData.asrCategory === 'websocket' ||
    formData.format === 'deepgram-compatible-websocket'
  const isDeepgramCompatibleWs =
    isWebSocketAsr && formData.webSocketProtocol === 'deepgram-compatible'
  const isWhisperLiveKitWs =
    isWebSocketAsr && formData.webSocketProtocol === 'whisperlivekit-native'
  const providerFormData: AsrConfig = isWebSocketAsr
    ? { ...formData, transportMode: 'browser' }
    : formData
  const tf = useCallback(
    (key: string, fallback: string, values: Record<string, string | number>) =>
      formatTemplate(t(key, fallback), values),
    [t],
  )
  const localizeAsrErrorMessage = useCallback(
    (message: string): string => {
      switch (message) {
        case 'No ASR provider is configured. Add one under Models → Voice recognition (ASR).':
          return t(
            'settings.asr.errorNoProvider',
            'No ASR provider is configured.',
          )
        case 'Long-audio ASR provider adapters are not implemented yet.':
          return t(
            'settings.asr.errorLongAudioNotImplemented',
            'Long-audio provider adapters are not implemented yet.',
          )
        case 'Transcription ASR config needs both baseURL and model.':
        case 'Chat-audio ASR config needs both baseURL and model.':
        case 'ASR provider is missing baseURL.':
        case 'ASR provider is missing model.':
          return t(
            'settings.asr.errorIncompleteConfig',
            'This ASR configuration is incomplete.',
          )
        case 'WebSocket ASR config needs a baseURL.':
          return t(
            'settings.asr.errorWebSocketMissingBaseUrl',
            'This WebSocket provider needs a Base URL.',
          )
        default:
          if (message.startsWith('ASR transcription failed: ')) {
            return formatTemplate(
              t(
                'settings.asr.errorTranscriptionRequestFailed',
                'ASR transcription failed: {{detail}}',
              ),
              { detail: message.slice('ASR transcription failed: '.length) },
            )
          }
          if (message.startsWith('ASR chat-audio request failed: ')) {
            return formatTemplate(
              t(
                'settings.asr.errorChatAudioRequestFailed',
                'ASR chat-audio request failed: {{detail}}',
              ),
              {
                detail: message.slice('ASR chat-audio request failed: '.length),
              },
            )
          }
          return message
      }
    },
    [t],
  )
  const localizeTestError = useCallback(
    (error: Error): string => {
      const kind =
        typeof (error as { kind?: unknown }).kind === 'string'
          ? (error as Error & { kind: string }).kind
          : ''
      switch (kind) {
        case 'permission-denied':
          return t(
            'voiceInput.recorderPermissionDenied',
            'Microphone access was denied. Grant the permission in your system or Obsidian settings.',
          )
        case 'no-device':
          return t('voiceInput.recorderNoDevice', 'No microphone was found.')
        case 'device-busy':
          return t(
            'voiceInput.recorderDeviceBusy',
            'The microphone is busy or not readable.',
          )
        case 'unsupported':
          return t(
            'voiceInput.recorderUnsupported',
            'Recording is not supported in this environment.',
          )
        case 'aborted':
          return t('voiceInput.recordingCancelled', 'Recording cancelled.')
        default:
          return localizeAsrErrorMessage(error.message)
      }
    },
    [localizeAsrErrorMessage, t],
  )

  const cancelStreamingTest = useCallback((updateState = true) => {
    const runtime = streamingTestRef.current
    streamingTestRef.current = null
    if (!runtime) return
    runtime.recorder.cancel()
    try {
      runtime.session.cancel()
    } catch {
      // Best-effort cleanup when the modal is closed or the config changes.
    }
    if (!updateState) return
    setStreamingTestActive(false)
    setTestRunning(false)
  }, [])

  useEffect(() => {
    return () => cancelStreamingTest(false)
  }, [cancelStreamingTest])

  const handlePatch = (patch: Partial<AsrConfig>) => {
    cancelStreamingTest()
    setFormData((prev) => ({ ...prev, ...patch }))
    setTestMessage('')
    setTestTranscript('')
    setTestStatus('idle')
  }

  const normalizeWebSocketFileStreamingRate = (value: number): number =>
    Math.min(
      ASR_WEBSOCKET_FILE_STREAMING_RATE_MAX,
      Math.max(
        ASR_WEBSOCKET_FILE_STREAMING_RATE_MIN,
        Math.round(value * 100) / 100,
      ),
    )

  const parseWebSocketFileStreamingRate = (value: string): number | null => {
    const parsed = Number.parseFloat(value)
    if (!Number.isFinite(parsed)) return null
    return normalizeWebSocketFileStreamingRate(parsed)
  }

  useEffect(() => {
    setWebSocketFileStreamingRateInput(
      String(
        formData.webSocketFileStreamingRate ??
          ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT,
      ),
    )
  }, [formData.webSocketFileStreamingRate])

  // When the user switches API format, swap in that format's defaults — but
  // only for fields the user hasn't customized yet. We compare each field to
  // the OLD format's default; if unchanged, replace; if user overwrote it,
  // leave alone.
  const handleFormatChange = (nextFormat: AsrApiFormat) => {
    cancelStreamingTest()
    const oldFormat = formData.format
    const oldDef = FORMAT_DEFAULTS[oldFormat]
    const newDef = FORMAT_DEFAULTS[nextFormat]
    const keepIfEdited = <K extends keyof FormatDefaults>(
      field: K & keyof AsrConfig,
    ): AsrConfig[typeof field] => {
      const current = formData[field] as unknown as string
      return (
        current === (oldDef[field] as unknown as string)
          ? newDef[field]
          : current
      ) as AsrConfig[typeof field]
    }
    setFormData((prev) => ({
      ...prev,
      asrCategory: 'http-short-audio',
      asrProvider: newDef.asrProvider,
      format: nextFormat,
      name: keepIfEdited('name'),
      baseURL: keepIfEdited('baseURL'),
      model: keepIfEdited('model'),
      transcriptionPath: keepIfEdited('transcriptionPath'),
      chatCompletionsPath: keepIfEdited('chatCompletionsPath'),
      audioContentFormat: keepIfEdited('audioContentFormat'),
      webSocketProtocol: keepIfEdited('webSocketProtocol'),
      webSocketPunctuate: keepIfEdited('webSocketPunctuate'),
      webSocketDiarizeMode: keepIfEdited('webSocketDiarizeMode'),
      webSocketDictation: keepIfEdited('webSocketDictation'),
      webSocketFileStreamingRate: keepIfEdited('webSocketFileStreamingRate'),
      audioFormat: keepIfEdited('audioFormat'),
      transportMode:
        nextFormat === 'deepgram-compatible-websocket'
          ? 'browser'
          : prev.transportMode,
      language: keepIfEdited('language'),
    }))
    setTestMessage('')
    setTestTranscript('')
    setTestStatus('idle')
  }

  const handleWebSocketProtocolChange = (
    nextProtocol: AsrWebSocketProtocol,
  ) => {
    cancelStreamingTest()
    const defaults = WS_PROTOCOL_DEFAULTS[nextProtocol]
    setFormData((prev) => ({
      ...prev,
      webSocketProtocol: nextProtocol,
      asrCategory: 'websocket',
      asrProvider: defaults.asrProvider,
      format: 'deepgram-compatible-websocket',
      name: defaults.name,
      baseURL: defaults.baseURL,
      apiKey: '',
      model: defaults.model,
      transcriptionPath: defaults.transcriptionPath,
      audioFormat: defaults.audioFormat,
      webSocketPunctuate: defaults.webSocketPunctuate,
      webSocketDiarizeMode: defaults.webSocketDiarizeMode,
      webSocketDictation: defaults.webSocketDictation,
      webSocketFileStreamingRate: defaults.webSocketFileStreamingRate,
      transportMode: 'browser',
    }))
    setTestMessage('')
    setTestTranscript('')
    setTestStatus('idle')
  }

  const validate = (): string | null => {
    if (!formData.baseURL.trim()) {
      return t('settings.asr.baseURLRequired', 'Base URL is required.')
    }
    if (isHttpLongAudio) {
      if (
        formData.asrProvider === 'deepgram-prerecorded' &&
        !formData.apiKey.trim()
      ) {
        return t('settings.asr.apiKeyRequired', 'API key is required.')
      }
      if (
        formData.asrProvider === 'tencent-flash' &&
        (!formData.appId.trim() ||
          !formData.apiKey.trim() ||
          !formData.apiSecret.trim())
      ) {
        return t(
          'settings.asr.longProviderCredentialsRequired',
          'AppID, API key, and API secret are required.',
        )
      }
      return null
    }
    if (!isWebSocketAsr && !formData.model.trim()) {
      return t('settings.asr.modelRequired', 'Model is required.')
    }
    return null
  }

  const handleLongAudioProviderChange = (provider: AsrLongAudioProvider) => {
    cancelStreamingTest()
    const defaults = LONG_AUDIO_PROVIDER_DEFAULTS[provider]
    setFormData((prev) => ({
      ...prev,
      asrCategory: 'http-long-audio',
      asrProvider: defaults.asrProvider,
      name: defaults.name,
      baseURL: defaults.baseURL,
      // Cloud long-audio credentials are not interchangeable. Clear API key
      // when switching providers so stale keys cannot make validation pass.
      apiKey: '',
      model: defaults.model,
      transcriptionPath: defaults.transcriptionPath,
      jobPath: defaults.jobPath,
      resultPath: defaults.resultPath,
      audioFormat: defaults.audioFormat,
      language: defaults.language,
      appId: defaults.appId,
      apiSecret: defaults.apiSecret,
      longAudioPunctuation: defaults.longAudioPunctuation,
      longAudioDiarization: defaults.longAudioDiarization,
      longAudioSpeakerCount: defaults.longAudioSpeakerCount,
      longAudioTimestamps: defaults.longAudioTimestamps,
      transportMode: 'node',
    }))
    setTestMessage('')
    setTestTranscript('')
    setTestStatus('idle')
  }

  const buildApiFormatDesc = (): string => {
    if (isWebSocketAsr) {
      return t(
        'settings.asr.apiFormatDescWebSocket',
        'Live WebSocket ASR. Supports Deepgram-compatible /listen and WhisperLiveKit native /asr.',
      )
    }
    if (isChatAudio) {
      return t(
        'settings.asr.apiFormatDescChatAudio',
        'Sends the recording to a chat model that accepts audio input.',
      )
    }
    return t(
      'settings.asr.apiFormatDescTranscription',
      'Uploads a short recording to an OpenAI-style transcription endpoint.',
    )
  }

  const buildAudioFormatDesc = (): string => {
    if (isWebSocketAsr) {
      return t(
        'settings.asr.audioFormatDescWebSocket',
        'PCM has better compatibility, but sends larger data.',
      )
    }
    if (isChatAudio) {
      return t(
        'settings.asr.audioFormatDescChat',
        'wav has better compatibility, but creates larger uploads.',
      )
    }
    return t(
      'settings.asr.audioFormatDescTranscription',
      'wav has better compatibility, but creates larger uploads.',
    )
  }

  const buildLanguageDesc = (): string => {
    if (isDeepgramCompatibleWs || isDeepgramPreRecorded) {
      return t(
        'settings.asr.deepgramLanguageDesc',
        'auto omits the language parameter; fill it for non-English speech, for example zh.',
      )
    }
    return t(
      'settings.asr.languageDesc',
      'Leave empty or "auto" to let the provider detect.',
    )
  }

  const buildTranscriptionPathDesc = (): string => {
    if (isWebSocketAsr) {
      return t(
        'settings.asr.listenPathDesc',
        'Use the path expected by the selected WS speech protocol.',
      )
    }
    if (isHttpLongAudio) {
      return t(
        'settings.asr.longAudioPathDesc',
        'Provider-specific long-audio endpoint path. The selected provider fills its default value.',
      )
    }
    return t(
      'settings.asr.transcriptionPathDesc',
      'Defaults to /audio/transcriptions.',
    )
  }

  const buildTranscriptionPathPlaceholder = (): string => {
    if (isWebSocketAsr) return '/listen'
    if (isTencentFlash) return '/asr/flash/v1'
    if (isHttpLongAudio && formData.asrProvider === 'deepgram-prerecorded') {
      return '/v1/listen'
    }
    return '/audio/transcriptions'
  }

  const handleSave = () => {
    cancelStreamingTest()
    const err = validate()
    if (err) {
      new Notice(err)
      return
    }
    void (async () => {
      const settings = plugin.settings
      const voice = settings.contextVoiceInputOptions
      const existing = voice.asrConfigs ?? []
      let next: AsrConfig[]
      if (isEdit) {
        next = existing.map((c) =>
          c.id === formData.id ? providerFormData : c,
        )
      } else {
        next = [...existing, providerFormData]
      }
      await plugin.setSettings({
        ...settings,
        contextVoiceInputOptions: {
          ...voice,
          asrConfigs: next,
          activeAsrConfigId:
            providerFormData.asrCategory === 'http-long-audio'
              ? voice.activeAsrConfigId
              : voice.activeAsrConfigId &&
                  existing.some((c) => c.id === voice.activeAsrConfigId)
                ? voice.activeAsrConfigId
                : formData.id,
        },
      })
      onClose()
    })()
  }

  const loadTestProvider = async (): Promise<{
    provider: BaseAsrProvider
    Recorder: VoiceInputRecorderConstructor
  }> => {
    const [{ buildAsrProviderForConfig }, recorderModule] = await Promise.all([
      import('../../../core/asr/manager'),
      import('../../../features/editor/voice/context-input/voiceInputRecorder'),
    ])
    return {
      provider: buildAsrProviderForConfig(providerFormData),
      Recorder: recorderModule.VoiceInputRecorder,
    }
  }

  const reportTestError = (
    error: unknown,
    fallback = t('settings.asr.testFailed', 'ASR test failed.'),
  ) => {
    const message = error instanceof Error ? localizeTestError(error) : fallback
    setTestStatus('failed')
    setTestMessage(message)
    new Notice(message)
  }

  const finishStreamingTest = async (
    message = t('settings.asr.testFinalizing', 'Stopping…'),
  ): Promise<void> => {
    const runtime = streamingTestRef.current
    if (!runtime) return
    streamingTestRef.current = null
    setStreamingTestActive(false)
    setTestStatus('finalizing')
    setTestMessage(message)
    try {
      await runtime.recorder.stop()
      const result = await runtime.session.finish()
      const text = (result.text ?? '').trim()
      setTestTranscript(text)
      if (text.length > 0) {
        setTestStatus('passed')
        setTestMessage(
          tf('settings.asr.testTookMs', 'Took {{ms}} ms', {
            ms: result.requestDurationMs ?? 0,
          }),
        )
      } else {
        setTestStatus('failed')
        setTestMessage(
          t('settings.asr.testEmptyResult', 'ASR returned empty text.'),
        )
      }
    } catch (error: unknown) {
      runtime.recorder.cancel()
      try {
        runtime.session.cancel()
      } catch {
        // ignore cleanup failure
      }
      reportTestError(error)
    } finally {
      setTestRunning(false)
    }
  }

  const runStreamingTest = async () => {
    const err = validate()
    if (err) {
      setTestStatus('failed')
      setTestMessage(err)
      return
    }
    setTestRunning(true)
    setStreamingTestActive(false)
    setTestStatus('recording')
    setTestMessage(
      t(
        'settings.asr.testStreamingRunning',
        'Streaming ASR test is running. Click Stop when done.',
      ),
    )
    setTestTranscript('')

    let recorder: VoiceInputRecorder | null = null
    let session: AsrStreamingSession | null = null
    try {
      const { provider, Recorder } = await loadTestProvider()
      if (typeof provider.startStreaming !== 'function') {
        throw new Error(
          t(
            'settings.asr.testStreamingUnsupported',
            'This ASR provider does not support streaming tests.',
          ),
        )
      }
      session = await provider.startStreaming(
        { language: formData.language, purpose: 'settings-test' },
        {
          onPartial: (text) => setTestTranscript(text.trim()),
          onFinal: (text) => setTestTranscript(text.trim()),
        },
      )
      recorder = new Recorder()
      await recorder.start({
        maxRecordingSeconds: STREAMING_TEST_MAX_SECONDS,
        deviceId: plugin.settings.contextVoiceInputOptions.microphoneDeviceId,
        onChunk:
          providerFormData.audioFormat !== 'wav'
            ? (chunk) => session?.sendAudioChunk(chunk)
            : undefined,
        onPcm16Chunk:
          providerFormData.audioFormat === 'wav'
            ? (chunk) => session?.sendAudioChunk(chunk)
            : undefined,
        onError: (error) => {
          const runtime = streamingTestRef.current
          streamingTestRef.current = null
          runtime?.recorder.cancel()
          try {
            runtime?.session.cancel()
          } catch {
            // ignore cleanup failure
          }
          setStreamingTestActive(false)
          setTestRunning(false)
          reportTestError(error)
        },
        onAutoStop: () => {
          void finishStreamingTest(
            t(
              'settings.asr.testStreamingAutoStop',
              'Streaming ASR test reached the maximum duration. Stopping…',
            ),
          )
          return true
        },
      })
      streamingTestRef.current = { recorder, session }
      setStreamingTestActive(true)
    } catch (error: unknown) {
      recorder?.cancel()
      try {
        session?.cancel()
      } catch {
        // ignore cleanup failure
      }
      streamingTestRef.current = null
      setStreamingTestActive(false)
      setTestRunning(false)
      reportTestError(
        error,
        t('settings.asr.testInvalidConfig', 'Invalid config.'),
      )
    }
  }

  const runHttpTest = async () => {
    const err = validate()
    if (err) {
      setTestStatus('failed')
      setTestMessage(err)
      return
    }
    setTestRunning(true)
    setTestStatus('recording')
    setTestMessage(
      tf('settings.asr.testRecordingSeconds', 'Recording {{seconds}} s…', {
        seconds: TEST_RECORDING_SECONDS,
      }),
    )
    setTestTranscript('')

    let recorder: VoiceInputRecorder | null = null
    try {
      const { provider, Recorder } = await loadTestProvider()
      recorder = new Recorder()
      await recorder.start({
        maxRecordingSeconds: TEST_RECORDING_SECONDS,
        deviceId: plugin.settings.contextVoiceInputOptions.microphoneDeviceId,
      })
      await new Promise<void>((resolve) =>
        setTimeout(resolve, TEST_RECORDING_SECONDS * 1000),
      )
      setTestStatus('transcribing')
      setTestMessage(t('settings.asr.testCallingAsr', 'Calling ASR…'))
      const audio = await recorder.stop()
      let testAudio: AsrAudioInput = {
        blob: audio.blob,
        mimeType: audio.mimeType,
        durationMs: audio.durationMs,
      }
      if (isTencentFlash) {
        // Tencent Flash rejects the MediaRecorder default webm/opus container.
        // For the 5s settings test, transcode to the same 16 kHz mono WAV
        // shape users would pick for compatibility.
        const { transcodeToWav } = await import(
          '../../../core/asr/audioTranscode'
        )
        testAudio = await transcodeToWav(testAudio)
      }
      const result = await provider.transcribe(testAudio, {
        language: formData.language,
        purpose: 'settings-test',
      })
      const text = (result.text ?? '').trim()
      setTestTranscript(text)
      if (text.length > 0) {
        setTestStatus('passed')
        setTestMessage(
          tf('settings.asr.testTookMs', 'Took {{ms}} ms', {
            ms: result.requestDurationMs ?? 0,
          }),
        )
      } else {
        setTestStatus('failed')
        setTestMessage(
          t('settings.asr.testEmptyResult', 'ASR returned empty text.'),
        )
      }
    } catch (error: unknown) {
      recorder?.cancel()
      reportTestError(error)
    } finally {
      setTestRunning(false)
    }
  }

  const runTest = async () => {
    if (streamingTestRef.current) {
      await finishStreamingTest()
      return
    }
    if (isWebSocketAsr) await runStreamingTest()
    else await runHttpTest()
  }

  const formatOptions = useMemo<Record<string, string>>(
    () => ({
      'openai-compatible-transcription': t(
        'settings.asr.apiFormatTranscription',
        'Transcription',
      ),
      'openai-compatible-chat-audio-asr': t(
        'settings.asr.apiFormatChatAudio',
        'Chat Audio',
      ),
    }),
    [t],
  )
  const audioFormatOptions = useMemo<Record<string, string>>(
    () =>
      isWebSocketAsr
        ? {
            wav: t('settings.asr.audioFormatPcm16', 'PCM 16k'),
            auto: t('settings.asr.audioFormatAuto', 'auto'),
          }
        : Object.fromEntries(
            ASR_AUDIO_FORMATS.map((f) => [
              f,
              f === 'wav'
                ? t('settings.asr.audioFormatWav', 'wav')
                : t('settings.asr.audioFormatAuto', 'auto'),
            ]),
          ),
    [isWebSocketAsr, t],
  )
  const webSocketProtocolOptions = useMemo<Record<string, string>>(
    () => ({
      'deepgram-compatible': t(
        'settings.asr.webSocketProtocolDeepgram',
        'Deepgram',
      ),
      'whisperlivekit-native': t(
        'settings.asr.webSocketProtocolWhisperLiveKit',
        'WhisperLiveKit',
      ),
    }),
    [t],
  )
  const longAudioProviderOptions = useMemo<Record<string, string>>(
    () => ({
      'funasr-local': t('settings.asr.longProviderFunasr', 'FunASR local'),
      'deepgram-prerecorded': t(
        'settings.asr.longProviderDeepgram',
        'Deepgram pre-recorded',
      ),
      'tencent-flash': t('settings.asr.longProviderTencent', 'Tencent Flash'),
    }),
    [t],
  )
  const featureModeOptions = useMemo<Record<string, string>>(
    () => ({
      auto: t('settings.asr.featureModeAuto', 'Auto'),
      on: t('settings.asr.featureModeOn', 'On'),
      off: t('settings.asr.featureModeOff', 'Off'),
    }),
    [t],
  )
  const transportOptions = useMemo<Record<string, string>>(() => {
    const options: Record<string, string> = {
      auto: t(
        'settings.providers.requestTransportModeAuto',
        TRANSPORT_LABEL_FALLBACK.auto,
      ),
      browser: t(
        'settings.providers.requestTransportModeBrowser',
        TRANSPORT_LABEL_FALLBACK.browser,
      ),
      obsidian: t(
        'settings.providers.requestTransportModeObsidian',
        TRANSPORT_LABEL_FALLBACK.obsidian,
      ),
      node: t(
        'settings.providers.requestTransportModeNode',
        TRANSPORT_LABEL_FALLBACK.node,
      ),
    }
    return options
  }, [t])

  return (
    <div className="yolo-asr-config-form">
      <ObsidianSetting
        name={t('settings.asr.configName', 'Name')}
        desc={t('settings.asr.configNameDesc', 'Shown in the ASR list.')}
      >
        <ObsidianTextInput
          value={formData.name}
          onChange={(value) => handlePatch({ name: value })}
          placeholder="OpenAI Whisper / Google Gemini …"
        />
      </ObsidianSetting>

      {formData.asrCategory === 'http-short-audio' && (
        <ObsidianSetting
          name={t('settings.asr.apiFormat', 'API format')}
          desc={buildApiFormatDesc()}
        >
          <ObsidianDropdown
            value={formData.format}
            options={formatOptions}
            onChange={(value) => handleFormatChange(value as AsrApiFormat)}
          />
        </ObsidianSetting>
      )}

      {isWebSocketAsr && (
        <ObsidianSetting
          name={t('settings.asr.webSocketProvider', 'WebSocket provider')}
          desc={t(
            'settings.asr.webSocketProviderDesc',
            'Changing this fills that provider’s common Base URL and path.',
          )}
        >
          <ObsidianDropdown
            value={formData.webSocketProtocol ?? 'deepgram-compatible'}
            options={webSocketProtocolOptions}
            onChange={(value) =>
              handleWebSocketProtocolChange(value as AsrWebSocketProtocol)
            }
          />
        </ObsidianSetting>
      )}

      {isHttpLongAudio && (
        <ObsidianSetting
          name={t('settings.asr.longProvider', 'Long-audio provider')}
          desc={t(
            'settings.asr.longProviderDesc',
            'Fixed long-audio provider adapters keep their own request and result parsing.',
          )}
        >
          <ObsidianDropdown
            value={formData.asrProvider || 'funasr-local'}
            options={longAudioProviderOptions}
            onChange={(value) =>
              handleLongAudioProviderChange(value as AsrLongAudioProvider)
            }
          />
        </ObsidianSetting>
      )}

      {isHttpLongAudio && formData.asrProvider === 'funasr-local' && (
        <ObsidianSetting
          name={t('settings.asr.funasrServerFeatures', 'Server features')}
          desc={t(
            'settings.asr.funasrServerFeaturesDesc',
            'Configure punctuation and speaker diarization on the FunASR server. The plugin automatically uses returned punctuation and speaker fields.',
          )}
        />
      )}

      <ObsidianSetting
        name={t('settings.asr.baseURL', 'Base URL')}
        desc={t('settings.asr.baseURLDesc', 'Do not include the path here.')}
      >
        <ObsidianTextInput
          value={formData.baseURL}
          onChange={(value) => handlePatch({ baseURL: value })}
          placeholder={
            isWebSocketAsr
              ? 'wss://api.deepgram.com/v1 or ws://127.0.0.1:8000/v1'
              : 'https://api.openai.com/v1'
          }
        />
      </ObsidianSetting>

      {!isChatAudio && (
        <ObsidianSetting
          name={
            isWebSocketAsr
              ? t('settings.asr.listenPath', 'Path')
              : t('settings.asr.transcriptionPath', 'Transcription path')
          }
          desc={buildTranscriptionPathDesc()}
        >
          <ObsidianTextInput
            value={formData.transcriptionPath}
            onChange={(value) => handlePatch({ transcriptionPath: value })}
            placeholder={buildTranscriptionPathPlaceholder()}
          />
        </ObsidianSetting>
      )}

      {isChatAudio && (
        <ObsidianSetting
          name={t('settings.asr.chatCompletionsPath', 'Chat completions path')}
          desc={t(
            'settings.asr.chatCompletionsPathDesc',
            'Defaults to /chat/completions.',
          )}
        >
          <ObsidianTextInput
            value={formData.chatCompletionsPath}
            onChange={(value) => handlePatch({ chatCompletionsPath: value })}
            placeholder="/chat/completions"
          />
        </ObsidianSetting>
      )}

      {isTencentFlash && (
        <ObsidianSetting
          name={t('settings.asr.appId', 'AppID')}
          desc={t(
            'settings.asr.tencentAppIdDesc',
            'Use the Tencent Cloud main account AppID, not the account ID.',
          )}
        >
          <ObsidianTextInput
            value={formData.appId}
            onChange={(value) => handlePatch({ appId: value })}
            placeholder="1250000000"
          />
        </ObsidianSetting>
      )}

      <ObsidianSetting
        name={
          isTencentFlash
            ? t('settings.asr.secretId', 'SecretID')
            : t('settings.asr.apiKey', 'API key')
        }
        desc={t(
          isTencentFlash
            ? 'settings.asr.apiKeyRequiredDesc'
            : 'settings.asr.apiKeyDesc',
          isTencentFlash
            ? 'Required by this cloud provider.'
            : 'Leave empty for local servers without auth.',
        )}
      >
        <ObsidianTextInput
          value={formData.apiKey}
          onChange={(value) => handlePatch({ apiKey: value })}
          placeholder={t(
            'settings.asr.apiKeyPlaceholder',
            'Enter your API key',
          )}
        />
      </ObsidianSetting>

      {isTencentFlash && (
        <ObsidianSetting
          name={t('settings.asr.secretKey', 'SecretKey')}
          desc={t(
            'settings.asr.apiSecretDesc',
            'Used only for signing ASR requests.',
          )}
        >
          <ObsidianTextInput
            value={formData.apiSecret}
            onChange={(value) => handlePatch({ apiSecret: value })}
            placeholder={t(
              'settings.asr.apiSecretPlaceholder',
              'Enter your API secret',
            )}
          />
        </ObsidianSetting>
      )}

      <ObsidianSetting
        name={t('settings.asr.model', 'Model')}
        desc={
          isWebSocketAsr
            ? t(
                'settings.asr.deepgramWsModelDesc',
                'Optional Deepgram model query parameter. Local compatible servers may ignore it.',
              )
            : isChatAudio
              ? t(
                  'settings.asr.chatAudioModelDesc',
                  'A multimodal chat model that accepts audio in messages.',
                )
              : t('settings.asr.modelDesc', 'Speech-to-text model id.')
        }
      >
        <ObsidianTextInput
          value={formData.model}
          onChange={(value) => handlePatch({ model: value })}
          placeholder={
            isWebSocketAsr
              ? 'nova-3'
              : isChatAudio
                ? 'gemini-3.1-flash-lite'
                : 'whisper-1'
          }
        />
      </ObsidianSetting>

      {isChatAudio && (
        <ObsidianSetting
          name={t('settings.asr.audioContentFormat', 'Audio content carrier')}
          desc={t(
            'settings.asr.audioContentFormatDesc',
            'OpenAI-style services want input_audio; some others want audio_url.',
          )}
        >
          <ObsidianDropdown
            value={formData.audioContentFormat || 'input_audio'}
            options={{
              input_audio: 'input_audio (base64)',
              input_audio_data_url: 'input_audio (data URL)',
              audio_url: 'audio_url',
            }}
            onChange={(value) => handlePatch({ audioContentFormat: value })}
          />
        </ObsidianSetting>
      )}

      {/* 音频格式同样对 transcription 协议生效 — 例如智谱 GLM 的
          /v1/audio/transcriptions 也只接受 wav/mp3 而非 webm。 */}
      {!isHttpLongAudio && (
        <ObsidianSetting
          name={t('settings.asr.audioFormat', 'Audio format')}
          desc={buildAudioFormatDesc()}
        >
          <ObsidianDropdown
            value={providerFormData.audioFormat}
            options={audioFormatOptions}
            onChange={(value) =>
              handlePatch({
                audioFormat: value === 'wav' ? 'wav' : 'auto',
              })
            }
          />
        </ObsidianSetting>
      )}

      {isDeepgramPreRecorded && (
        <ObsidianSetting
          name={t('settings.asr.longAudioPunctuation', 'Punctuation')}
          desc={t(
            'settings.asr.longAudioPunctuationDesc',
            'Ask Deepgram to add punctuation, capitalization, and Smart Format. Turn off if the selected language produces unwanted formatting.',
          )}
        >
          <ObsidianToggle
            value={formData.longAudioPunctuation}
            onChange={(value) => handlePatch({ longAudioPunctuation: value })}
          />
        </ObsidianSetting>
      )}

      {isCloudLongAudio && (
        <ObsidianSetting
          name={t('settings.asr.longAudioDiarization', 'Speaker diarization')}
          desc={t(
            'settings.asr.longAudioDiarizationDesc',
            'Ask the provider to return speaker labels when supported.',
          )}
        >
          <ObsidianToggle
            value={formData.longAudioDiarization}
            onChange={(value) => handlePatch({ longAudioDiarization: value })}
          />
        </ObsidianSetting>
      )}

      {isCloudLongAudio && (
        <ObsidianSetting
          name={t('settings.asr.longAudioTimestamps', 'Timestamps')}
          desc={t(
            'settings.asr.longAudioTimestampsDesc',
            'Request provider timestamps when the API supports that option.',
          )}
        >
          <ObsidianToggle
            value={formData.longAudioTimestamps}
            onChange={(value) => handlePatch({ longAudioTimestamps: value })}
          />
        </ObsidianSetting>
      )}

      {isWhisperLiveKitWs && (
        <ObsidianSetting
          name={t('settings.asr.webSocketFileStreamingRate', 'Rate limit')}
          desc={t(
            'settings.asr.webSocketFileStreamingRateDesc',
            'Range 1-20, default 2. When an audio file is dropped in, stream to WhisperLiveKit at up to this realtime speed.',
          )}
        >
          <ObsidianTextInput
            value={webSocketFileStreamingRateInput}
            placeholder="2"
            type="number"
            inputMode="decimal"
            min={ASR_WEBSOCKET_FILE_STREAMING_RATE_MIN}
            max={ASR_WEBSOCKET_FILE_STREAMING_RATE_MAX}
            step="0.25"
            onChange={(value) => {
              setWebSocketFileStreamingRateInput(value)
              const parsed = parseWebSocketFileStreamingRate(value)
              if (parsed !== null) {
                handlePatch({ webSocketFileStreamingRate: parsed })
              }
            }}
            onBlur={(value) => {
              const parsed =
                parseWebSocketFileStreamingRate(value) ??
                ASR_WEBSOCKET_FILE_STREAMING_RATE_DEFAULT
              handlePatch({ webSocketFileStreamingRate: parsed })
              setWebSocketFileStreamingRateInput(String(parsed))
            }}
          />
        </ObsidianSetting>
      )}

      {!isWebSocketAsr && (
        <ObsidianSetting
          name={t('settings.asr.transport', 'Transport')}
          desc={t(
            'settings.providers.requestTransportModeDesc',
            'Auto uses the same platform default as chat models: desktop Node fetch, mobile browser fetch. Obsidian buffers responses; Node uses the desktop proxy-aware fetch.',
          )}
        >
          <ObsidianDropdown
            value={formData.transportMode}
            options={transportOptions}
            onChange={(value) =>
              handlePatch({ transportMode: value as AsrTransportMode })
            }
          />
        </ObsidianSetting>
      )}

      <ObsidianSetting
        name={t('settings.asr.language', 'Language')}
        desc={buildLanguageDesc()}
      >
        <ObsidianTextInput
          value={formData.language}
          onChange={(value) => handlePatch({ language: value })}
          placeholder="auto"
        />
      </ObsidianSetting>

      {isWebSocketAsr && (
        <ObsidianSetting
          name={t('settings.asr.webSocketDiarize', 'Speaker diarization')}
          desc={t(
            'settings.asr.webSocketDiarizeDesc',
            'Auto keeps speaker handling off for context voice input and on for audio file transcription.',
          )}
        >
          <ObsidianDropdown
            value={formData.webSocketDiarizeMode}
            options={featureModeOptions}
            onChange={(value) =>
              handlePatch({
                webSocketDiarizeMode: value as AsrWebSocketFeatureMode,
              })
            }
          />
        </ObsidianSetting>
      )}

      {isDeepgramCompatibleWs && (
        <ObsidianSetting
          name={t('settings.asr.webSocketPunctuate', 'Punctuation')}
          desc={t(
            'settings.asr.webSocketPunctuateDesc',
            'Adds punctuation and capitalization to Deepgram-compatible transcripts.',
          )}
        >
          <ObsidianToggle
            value={formData.webSocketPunctuate}
            onChange={(value) =>
              handlePatch({
                webSocketPunctuate: value,
                webSocketDictation: value ? formData.webSocketDictation : false,
              })
            }
          />
        </ObsidianSetting>
      )}

      {isDeepgramCompatibleWs && (
        <ObsidianSetting
          name={t('settings.asr.webSocketDictation', 'Dictation commands')}
          desc={t(
            'settings.asr.webSocketDictationDesc',
            'Turns spoken punctuation commands such as comma, period, and new line into marks. Requires punctuation.',
          )}
        >
          <ObsidianToggle
            value={formData.webSocketDictation}
            onChange={(value) =>
              handlePatch({
                webSocketDictation: value,
                webSocketPunctuate: value ? true : formData.webSocketPunctuate,
              })
            }
          />
        </ObsidianSetting>
      )}

      <ObsidianSetting
        name={t('settings.asr.testRecording', 'Test recording')}
        desc={t(
          isWebSocketAsr
            ? 'settings.asr.testRecordingDescWebSocket'
            : 'settings.asr.testRecordingDesc',
          isWebSocketAsr
            ? 'Starts a live streaming ASR test. Click Stop when done speaking.'
            : `Records a ${TEST_RECORDING_SECONDS}s clip with the current configuration to verify URL / key / model / format.`,
        )}
      >
        <ObsidianButton
          text={
            streamingTestActive
              ? t('settings.asr.testStopStreaming', 'Stop')
              : testRunning
                ? testStatus === 'finalizing'
                  ? t('settings.asr.testFinalizing', 'Stopping…')
                  : t('settings.asr.testRunning', 'Recording…')
                : t('settings.asr.testRun', 'Run test')
          }
          disabled={testRunning && !streamingTestActive}
          onClick={() => void runTest()}
        />
      </ObsidianSetting>

      {(testMessage || testTranscript) && (
        <div
          className={`yolo-asr-test-result yolo-asr-test-result--${testStatus}`}
        >
          <div className="yolo-asr-test-result__head">
            <span className="yolo-asr-test-result__badge">
              {testStatus === 'passed'
                ? t('settings.asr.testBadgePassed', '✓ Passed')
                : testStatus === 'failed'
                  ? t('settings.asr.testBadgeFailed', '× Failed')
                  : testStatus === 'recording'
                    ? t('settings.asr.testBadgeRecording', '● Recording')
                    : testStatus === 'finalizing'
                      ? t('settings.asr.testBadgeFinalizing', '… Finalizing')
                      : testStatus === 'transcribing'
                        ? t(
                            'settings.asr.testBadgeTranscribing',
                            '… Transcribing',
                          )
                        : '·'}
            </span>
            {testMessage && (
              <span className="yolo-asr-test-result__msg">{testMessage}</span>
            )}
          </div>
          {testTranscript && (
            <div className="yolo-asr-test-result__transcript">
              {testTranscript}
            </div>
          )}
        </div>
      )}

      <div className="yolo-asr-config-form__footer">
        <ObsidianButton text={t('common.cancel', 'Cancel')} onClick={onClose} />
        <ObsidianButton
          text={isEdit ? t('common.save', 'Save') : t('common.add', 'Add')}
          cta
          onClick={handleSave}
        />
      </div>
    </div>
  )
}
