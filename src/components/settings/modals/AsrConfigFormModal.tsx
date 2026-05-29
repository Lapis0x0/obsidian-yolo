import { App, Notice } from 'obsidian'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type { BaseAsrProvider } from '../../../core/asr/base'
import type {
  AsrAudioInput,
  AsrStreamingSession,
} from '../../../core/asr/types'
import YoloPlugin from '../../../main'
import {
  ASR_AUDIO_FORMATS,
  type AsrApiFormat,
  type AsrAudioFormat,
  type AsrConfig,
  type AsrTransportMode,
  type AsrWebSocketProtocol,
} from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'

type AsrConfigFormProps = {
  plugin: YoloPlugin
  /** null when adding a brand-new config. */
  config: AsrConfig | null
}

const TEST_RECORDING_SECONDS = 5

// Per-format defaults that get *written* into the form (not just shown as
// placeholder) when the user picks that format. Previous version showed
// greyed-out placeholders, then complained "Base URL is required" on save —
// fields are now genuinely pre-filled and ready.
type FormatDefaults = {
  name: string
  baseURL: string
  model: string
  transcriptionPath: string
  chatCompletionsPath: string
  audioContentFormat: string
  webSocketProtocol: AsrWebSocketProtocol
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
    baseURL: 'https://api.openai.com/v1',
    model: 'whisper-1',
    transcriptionPath: '',
    chatCompletionsPath: '',
    audioContentFormat: 'input_audio',
    webSocketProtocol: 'deepgram-compatible',
    audioFormat: 'auto',
    language: 'auto',
  },
  'openai-compatible-chat-audio-asr': {
    name: 'Chat audio ASR',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.1-flash-lite',
    transcriptionPath: '',
    chatCompletionsPath: '',
    audioContentFormat: 'input_audio',
    webSocketProtocol: 'deepgram-compatible',
    // Many chat-audio endpoints reject webm — wav transcode is the safest
    // default. Switch to `auto` if you know your endpoint takes webm/opus.
    audioFormat: 'wav',
    language: 'auto',
  },
  'deepgram-compatible-websocket': {
    name: 'Deepgram WS',
    baseURL: 'wss://api.deepgram.com/v1',
    model: 'nova-3',
    transcriptionPath: '/listen',
    chatCompletionsPath: '',
    audioContentFormat: 'input_audio',
    webSocketProtocol: 'deepgram-compatible',
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
    'name' | 'baseURL' | 'model' | 'transcriptionPath' | 'audioFormat'
  >
> = {
  'deepgram-compatible': {
    name: 'Deepgram WS',
    baseURL: 'wss://api.deepgram.com/v1',
    model: 'nova-3',
    transcriptionPath: '/listen',
    audioFormat: 'wav',
  },
  'whisperlivekit-native': {
    name: 'WhisperLiveKit WS',
    baseURL: 'ws://127.0.0.1:8000',
    model: '',
    transcriptionPath: '/asr',
    audioFormat: 'auto',
  },
}

const generateId = (): string =>
  `asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export class AddAsrConfigModal extends ReactModal<AsrConfigFormProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: AsrConfigFormComponent,
      props: { plugin, config: null },
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
  onClose,
}: AsrConfigFormProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const isEdit = !!config

  const [formData, setFormData] = useState<AsrConfig>(() => {
    if (config) return { ...config }
    // First-time add: start from the transcription default (most common new
    // user flow). The Format picker swaps in matching defaults when changed.
    const fmt: AsrApiFormat = 'openai-compatible-transcription'
    const def = FORMAT_DEFAULTS[fmt]
    return {
      id: generateId(),
      name: def.name,
      format: fmt,
      baseURL: def.baseURL,
      apiKey: '',
      model: def.model,
      transcriptionPath: def.transcriptionPath,
      chatCompletionsPath: def.chatCompletionsPath,
      audioContentFormat: def.audioContentFormat,
      webSocketProtocol: def.webSocketProtocol,
      audioFormat: def.audioFormat,
      transportMode: 'node',
      language: def.language,
    }
  })
  const [testRunning, setTestRunning] = useState(false)
  const [testMessage, setTestMessage] = useState<string>('')
  const [testTranscript, setTestTranscript] = useState<string>('')
  const [testStatus, setTestStatus] = useState<
    'idle' | 'recording' | 'finalizing' | 'transcribing' | 'passed' | 'failed'
  >('idle')

  const isChatAudio = formData.format === 'openai-compatible-chat-audio-asr'
  const isDeepgramWs = formData.format === 'deepgram-compatible-websocket'
  const providerFormData: AsrConfig = isDeepgramWs
    ? { ...formData, transportMode: 'browser' }
    : formData

  const handlePatch = (patch: Partial<AsrConfig>) => {
    setFormData((prev) => ({ ...prev, ...patch }))
    setTestMessage('')
    setTestTranscript('')
    setTestStatus('idle')
  }

  // When the user switches API format, swap in that format's defaults — but
  // only for fields the user hasn't customized yet. We compare each field to
  // the OLD format's default; if unchanged, replace; if user overwrote it,
  // leave alone.
  const handleFormatChange = (nextFormat: AsrApiFormat) => {
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
      format: nextFormat,
      name: keepIfEdited('name'),
      baseURL: keepIfEdited('baseURL'),
      model: keepIfEdited('model'),
      transcriptionPath: keepIfEdited('transcriptionPath'),
      chatCompletionsPath: keepIfEdited('chatCompletionsPath'),
      audioContentFormat: keepIfEdited('audioContentFormat'),
      webSocketProtocol: keepIfEdited('webSocketProtocol'),
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
    const defaults = WS_PROTOCOL_DEFAULTS[nextProtocol]
    setFormData((prev) => ({
      ...prev,
      webSocketProtocol: nextProtocol,
      name: defaults.name,
      baseURL: defaults.baseURL,
      model: defaults.model,
      transcriptionPath: defaults.transcriptionPath,
      audioFormat: defaults.audioFormat,
      transportMode: 'browser',
    }))
    setTestMessage('')
    setTestTranscript('')
    setTestStatus('idle')
  }

  const validate = (): string | null => {
    if (!formData.baseURL.trim()) return 'Base URL is required.'
    if (!isDeepgramWs && !formData.model.trim()) return 'Model is required.'
    return null
  }

  const buildApiFormatDesc = (): string => {
    if (isDeepgramWs) {
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
    if (isDeepgramWs) {
      return t(
        'settings.asr.audioFormatDescWebSocket',
        'PCM usually has better compatibility.',
      )
    }
    if (isChatAudio) {
      return t(
        'settings.asr.audioFormatDescChat',
        'Auto uses the browser recording. Choose wav only if the service rejects webm/opus.',
      )
    }
    return t(
      'settings.asr.audioFormatDescTranscription',
      'Auto uses the browser recording. Choose wav only if the service requires it.',
    )
  }

  const buildLanguageDesc = (): string => {
    if (isDeepgramWs) {
      return t(
        'settings.asr.deepgramWsLanguageDesc',
        'auto omits the language parameter; fill it for non-English speech, for example zh.',
      )
    }
    return t(
      'settings.asr.languageDesc',
      'Leave empty or "auto" to let the provider detect.',
    )
  }

  const handleSave = () => {
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
            voice.activeAsrConfigId &&
            existing.some((c) => c.id === voice.activeAsrConfigId)
              ? voice.activeAsrConfigId
              : formData.id,
        },
      })
      onClose()
    })()
  }

  const runTest = async () => {
    const err = validate()
    if (err) {
      setTestStatus('failed')
      setTestMessage(err)
      return
    }
    setTestRunning(true)
    setTestStatus('recording')
    setTestMessage(`Recording ${TEST_RECORDING_SECONDS} s…`)
    setTestTranscript('')

    let provider: BaseAsrProvider
    let Recorder: typeof import('../../../features/editor/context-voice-input/voiceInputRecorder').VoiceInputRecorder
    try {
      const [{ buildAsrProviderForConfig }, recorderModule] = await Promise.all(
        [
          import('../../../core/asr/manager'),
          import(
            '../../../features/editor/context-voice-input/voiceInputRecorder'
          ),
        ],
      )
      Recorder = recorderModule.VoiceInputRecorder
      provider = buildAsrProviderForConfig(providerFormData)
    } catch (error: unknown) {
      setTestStatus('failed')
      setTestMessage(error instanceof Error ? error.message : 'Invalid config.')
      setTestRunning(false)
      return
    }

    const recorder = new Recorder()
    let streamSession: AsrStreamingSession | null = null
    let recorded: AsrAudioInput | null = null
    try {
      if (typeof provider.startStreaming === 'function') {
        streamSession = await provider.startStreaming(
          { language: formData.language },
          {
            onPartial: (text) => setTestTranscript(text.trim()),
            onFinal: (text) => setTestTranscript(text.trim()),
          },
        )
      }
      await recorder.start({
        maxRecordingSeconds: streamSession
          ? TEST_RECORDING_SECONDS + 30
          : TEST_RECORDING_SECONDS,
        deviceId: plugin.settings.contextVoiceInputOptions.microphoneDeviceId,
        onChunk:
          streamSession && providerFormData.audioFormat !== 'wav'
            ? (chunk) => streamSession?.sendAudioChunk(chunk)
            : undefined,
        onPcm16Chunk:
          streamSession && providerFormData.audioFormat === 'wav'
            ? (chunk) => streamSession?.sendAudioChunk(chunk)
            : undefined,
      })
      await new Promise<void>((resolve) =>
        setTimeout(resolve, TEST_RECORDING_SECONDS * 1000),
      )
      setTestStatus('transcribing')
      if (streamSession) {
        setTestStatus('finalizing')
        setTestMessage('Finalizing ASR…')
      } else {
        setTestMessage('Calling ASR…')
      }
      if (streamSession) {
        recorder.cancel()
      } else {
        const audio = await recorder.stop()
        recorded = {
          blob: audio.blob,
          mimeType: audio.mimeType,
          durationMs: audio.durationMs,
        }
      }
      let result
      if (streamSession) {
        result = await streamSession.finish()
      } else if (recorded) {
        result = await provider.transcribe(recorded, {
          language: formData.language,
        })
      } else {
        throw new Error('Recording did not produce audio.')
      }
      const text = (result.text ?? '').trim()
      setTestTranscript(text)
      if (text.length > 0) {
        setTestStatus('passed')
        setTestMessage(`Took ${result.requestDurationMs ?? 0} ms`)
      } else {
        setTestStatus('failed')
        setTestMessage('ASR returned empty text.')
      }
    } catch (error: unknown) {
      recorder.cancel()
      if (streamSession) {
        try {
          streamSession.cancel()
        } catch {
          // ignore cleanup failure
        }
      }
      setTestStatus('failed')
      setTestMessage(
        error instanceof Error ? error.message : 'ASR test failed.',
      )
      new Notice(error instanceof Error ? error.message : 'ASR test failed.')
    } finally {
      setTestRunning(false)
    }
  }

  const formatOptions = useMemo<Record<string, string>>(
    () => ({
      'openai-compatible-transcription': t(
        'settings.asr.apiFormatTranscription',
        'Transcription',
      ),
      'openai-compatible-chat-audio-asr': t(
        'settings.asr.apiFormatChatAudio',
        'Chat audio',
      ),
      'deepgram-compatible-websocket': t(
        'settings.asr.apiFormatWebSocket',
        'WebSocket',
      ),
    }),
    [t],
  )
  const audioFormatOptions = useMemo<Record<string, string>>(
    () =>
      isDeepgramWs
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
    [isDeepgramWs, t],
  )
  const webSocketProtocolOptions = useMemo<Record<string, string>>(
    () => ({
      'deepgram-compatible': t(
        'settings.asr.webSocketProtocolDeepgram',
        'Deepgram /listen',
      ),
      'whisperlivekit-native': t(
        'settings.asr.webSocketProtocolWhisperLiveKit',
        'WhisperLiveKit /asr',
      ),
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
    <div>
      <ObsidianSetting
        name={t('settings.asr.configName', 'Name')}
        desc={t('settings.asr.configNameDesc', 'Shown in the ASR list.')}
        className="yolo-models-select-card"
      >
        <ObsidianTextInput
          value={formData.name}
          onChange={(value) => handlePatch({ name: value })}
          placeholder="OpenAI Whisper / Google Gemini …"
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.asr.apiFormat', 'API format')}
        desc={buildApiFormatDesc()}
        className="yolo-models-select-card"
      >
        <ObsidianDropdown
          value={formData.format}
          options={formatOptions}
          onChange={(value) => handleFormatChange(value as AsrApiFormat)}
        />
      </ObsidianSetting>

      {isDeepgramWs && (
        <ObsidianSetting
          name={t('settings.asr.webSocketProtocol', 'WS speech protocol')}
          desc={t(
            'settings.asr.webSocketProtocolDesc',
            'Changing this fills the common Base URL and path for that protocol.',
          )}
          className="yolo-models-select-card"
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

      <ObsidianSetting
        name={t('settings.asr.baseURL', 'Base URL')}
        desc={t('settings.asr.baseURLDesc', 'Do not include the path here.')}
        className="yolo-models-select-card"
      >
        <ObsidianTextInput
          value={formData.baseURL}
          onChange={(value) => handlePatch({ baseURL: value })}
          placeholder={
            isDeepgramWs
              ? 'wss://api.deepgram.com/v1 or ws://127.0.0.1:8000/v1'
              : 'https://api.openai.com/v1'
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.asr.apiKey', 'API key')}
        desc={t(
          'settings.asr.apiKeyDesc',
          'Leave empty for local servers without auth.',
        )}
        className="yolo-models-select-card"
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

      <ObsidianSetting
        name={t('settings.asr.model', 'Model')}
        desc={
          isDeepgramWs
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
        className="yolo-models-select-card"
      >
        <ObsidianTextInput
          value={formData.model}
          onChange={(value) => handlePatch({ model: value })}
          placeholder={
            isDeepgramWs
              ? 'nova-3'
              : isChatAudio
                ? 'gemini-3.1-flash-lite'
                : 'whisper-1'
          }
        />
      </ObsidianSetting>

      {!isChatAudio && (
        <ObsidianSetting
          name={
            isDeepgramWs
              ? t('settings.asr.listenPath', 'Path')
              : t('settings.asr.transcriptionPath', 'Transcription path')
          }
          desc={t(
            isDeepgramWs
              ? 'settings.asr.listenPathDesc'
              : 'settings.asr.transcriptionPathDesc',
            isDeepgramWs
              ? 'Use the path expected by the selected WS speech protocol.'
              : 'Defaults to /audio/transcriptions.',
          )}
          className="yolo-models-select-card"
        >
          <ObsidianTextInput
            value={formData.transcriptionPath}
            onChange={(value) => handlePatch({ transcriptionPath: value })}
            placeholder={isDeepgramWs ? '/listen' : '/audio/transcriptions'}
          />
        </ObsidianSetting>
      )}

      {isChatAudio && (
        <>
          <ObsidianSetting
            name={t(
              'settings.asr.chatCompletionsPath',
              'Chat completions path',
            )}
            desc={t(
              'settings.asr.chatCompletionsPathDesc',
              'Defaults to /chat/completions.',
            )}
            className="yolo-models-select-card"
          >
            <ObsidianTextInput
              value={formData.chatCompletionsPath}
              onChange={(value) => handlePatch({ chatCompletionsPath: value })}
              placeholder="/chat/completions"
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.asr.audioContentFormat', 'Audio content carrier')}
            desc={t(
              'settings.asr.audioContentFormatDesc',
              'OpenAI-style services want input_audio; some others want audio_url.',
            )}
            className="yolo-models-select-card"
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
        </>
      )}

      {/* 音频格式同样对 transcription 协议生效 — 例如智谱 GLM 的
          /v1/audio/transcriptions 也只接受 wav/mp3 而非 webm。 */}
      <ObsidianSetting
        name={t('settings.asr.audioFormat', 'Audio format')}
        desc={buildAudioFormatDesc()}
        className="yolo-models-select-card"
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

      {!isDeepgramWs && (
        <ObsidianSetting
          name={t('settings.asr.transport', 'Transport')}
          desc={t(
            'settings.providers.requestTransportModeDesc',
            'Auto on desktop tries Node fetch first, then browser fetch on CORS/network errors; on mobile tries browser fetch then Obsidian requestUrl. Obsidian buffers responses; Node uses the desktop proxy-aware fetch.',
          )}
          className="yolo-models-select-card"
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
        className="yolo-models-select-card"
      >
        <ObsidianTextInput
          value={formData.language}
          onChange={(value) => handlePatch({ language: value })}
          placeholder="auto"
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.asr.testRecording', 'Test recording')}
        desc={t(
          'settings.asr.testRecordingDesc',
          `Records a ${TEST_RECORDING_SECONDS}s clip with the current configuration to verify URL / key / model / format.`,
        )}
        className="yolo-models-select-card"
      >
        <ObsidianButton
          text={
            testRunning
              ? t('settings.asr.testRunning', 'Recording…')
              : t('settings.asr.testRun', 'Run test')
          }
          disabled={testRunning}
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
