import { App, Notice } from 'obsidian'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { buildAsrProviderForConfig } from '../../../core/asr/manager'
import type { AsrAudioInput } from '../../../core/asr/types'
import { VoiceInputRecorder } from '../../../features/editor/context-voice-input/voiceInputRecorder'
import YoloPlugin from '../../../main'
import {
  ASR_API_FORMATS,
  ASR_AUDIO_FORMATS,
  type AsrApiFormat,
  type AsrAudioFormat,
  type AsrConfig,
  type AsrTransportMode,
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
  audioFormat: AsrAudioFormat
}
const FORMAT_DEFAULTS: Record<AsrApiFormat, FormatDefaults> = {
  'openai-compatible-transcription': {
    name: 'OpenAI Whisper',
    baseURL: 'https://api.openai.com/v1',
    model: 'whisper-1',
    transcriptionPath: '',
    chatCompletionsPath: '',
    audioContentFormat: 'input_audio',
    audioFormat: 'auto',
  },
  'openai-compatible-chat-audio-asr': {
    name: 'Google Gemini',
    // Google's OpenAI-compatible Chat Completions endpoint. The native
    // /v1beta is a different shape; this URL is the OpenAI-mimic one.
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.1-flash-lite',
    transcriptionPath: '',
    chatCompletionsPath: '',
    audioContentFormat: 'input_audio',
    // Google rejects webm — wav transcode is required for this default.
    audioFormat: 'wav',
  },
}

const FORMAT_LABEL: Record<AsrApiFormat, string> = {
  'openai-compatible-transcription': 'Transcription',
  'openai-compatible-chat-audio-asr': 'Chat audio ASR',
}

const AUDIO_FORMAT_LABEL: Record<AsrAudioFormat, string> = {
  auto: 'auto',
  wav: 'wav',
}

// Reuse the same transport labels as LLM providers so ASR does not invent a
// parallel vocabulary for the same request layer.
const TRANSPORT_LABEL_FALLBACK: Record<AsrTransportMode, string> = {
  auto: 'Auto (recommended)',
  browser: 'Browser fetch only',
  obsidian: 'Obsidian requestUrl only',
  node: 'Desktop Node fetch only',
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
      audioFormat: def.audioFormat,
      transportMode: 'auto',
      language: 'auto',
    }
  })
  const [testRunning, setTestRunning] = useState(false)
  const [testMessage, setTestMessage] = useState<string>('')
  const [testTranscript, setTestTranscript] = useState<string>('')
  const [testStatus, setTestStatus] = useState<
    'idle' | 'recording' | 'transcribing' | 'passed' | 'failed'
  >('idle')

  const isChatAudio = formData.format === 'openai-compatible-chat-audio-asr'

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
      audioFormat: keepIfEdited('audioFormat'),
    }))
    setTestMessage('')
    setTestTranscript('')
    setTestStatus('idle')
  }

  const validate = (): string | null => {
    if (!formData.baseURL.trim()) return 'Base URL is required.'
    if (!formData.model.trim()) return 'Model is required.'
    return null
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
        next = existing.map((c) => (c.id === formData.id ? formData : c))
      } else {
        next = [...existing, formData]
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
          lastAsrTestStatus: 'untested',
          lastAsrTestMessage: '',
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

    let provider
    try {
      provider = buildAsrProviderForConfig(formData)
    } catch (error: unknown) {
      setTestStatus('failed')
      setTestMessage(error instanceof Error ? error.message : 'Invalid config.')
      setTestRunning(false)
      return
    }

    const recorder = new VoiceInputRecorder()
    let recorded: AsrAudioInput | null = null
    try {
      await recorder.start({
        maxRecordingSeconds: TEST_RECORDING_SECONDS,
        deviceId: plugin.settings.contextVoiceInputOptions.microphoneDeviceId,
      })
      await new Promise<void>((resolve) =>
        setTimeout(resolve, TEST_RECORDING_SECONDS * 1000),
      )
      const audio = await recorder.stop()
      recorded = {
        blob: audio.blob,
        mimeType: audio.mimeType,
        durationMs: audio.durationMs,
      }
    } catch (error: unknown) {
      try {
        recorder.cancel()
      } catch {
        // noop
      }
      setTestStatus('failed')
      setTestMessage(
        error instanceof Error ? error.message : 'Recording failed.',
      )
      setTestRunning(false)
      return
    }

    setTestStatus('transcribing')
    setTestMessage('Calling ASR…')
    try {
      const result = await provider.transcribe(recorded, {
        language: formData.language,
      })
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
      setTestStatus('failed')
      setTestMessage(error instanceof Error ? error.message : 'Request failed.')
    } finally {
      setTestRunning(false)
    }
  }

  const formatOptions = useMemo<Record<string, string>>(
    () => Object.fromEntries(ASR_API_FORMATS.map((f) => [f, FORMAT_LABEL[f]])),
    [],
  )
  const audioFormatOptions = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        ASR_AUDIO_FORMATS.map((f) => [f, AUDIO_FORMAT_LABEL[f]]),
      ),
    [],
  )
  const transportOptions = useMemo<Record<string, string>>(
    () => ({
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
    }),
    [t],
  )

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
        desc={t(
          'settings.asr.apiFormatDesc',
          'Picks whether requests go to transcription or chat completions.',
        )}
        className="yolo-models-select-card"
      >
        <ObsidianDropdown
          value={formData.format}
          options={formatOptions}
          onChange={(value) => handleFormatChange(value as AsrApiFormat)}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.asr.baseURL', 'Base URL')}
        desc={t('settings.asr.baseURLDesc', 'Do not include the path here.')}
        className="yolo-models-select-card"
      >
        <ObsidianTextInput
          value={formData.baseURL}
          onChange={(value) => handlePatch({ baseURL: value })}
          placeholder="https://api.openai.com/v1"
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
          isChatAudio
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
          placeholder={isChatAudio ? 'gemini-3.1-flash-lite' : 'whisper-1'}
        />
      </ObsidianSetting>

      {!isChatAudio && (
        <ObsidianSetting
          name={t('settings.asr.transcriptionPath', 'Transcription path')}
          desc={t(
            'settings.asr.transcriptionPathDesc',
            'Defaults to /audio/transcriptions.',
          )}
          className="yolo-models-select-card"
        >
          <ObsidianTextInput
            value={formData.transcriptionPath}
            onChange={(value) => handlePatch({ transcriptionPath: value })}
            placeholder="/audio/transcriptions"
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
                input_audio: 'input_audio',
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
        desc={
          isChatAudio
            ? t(
                'settings.asr.audioFormatDescChat',
                'Google Gemini requires wav; others can use auto.',
              )
            : t(
                'settings.asr.audioFormatDescTranscription',
                'Zhipu GLM / some local Whisper servers require wav; OpenAI cloud accepts auto.',
              )
        }
        className="yolo-models-select-card"
      >
        <ObsidianDropdown
          value={formData.audioFormat}
          options={audioFormatOptions}
          onChange={(value) =>
            handlePatch({
              audioFormat: value === 'wav' ? 'wav' : 'auto',
            })
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.asr.transport', 'Transport')}
        desc={t(
          'settings.providers.requestTransportModeDesc',
          'Auto tries browser fetch, then desktop Node fetch, and falls back to Obsidian requestUrl on CORS/network errors. Obsidian buffers responses; Node uses the desktop proxy-aware fetch.',
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

      <ObsidianSetting
        name={t('settings.asr.language', 'Language')}
        desc={t(
          'settings.asr.languageDesc',
          'Leave empty or "auto" to let the provider detect.',
        )}
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
