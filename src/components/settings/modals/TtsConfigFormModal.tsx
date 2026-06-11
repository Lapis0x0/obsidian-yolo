import { App, Notice, getLanguage } from 'obsidian'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { applyAudioOutputDevice } from '../../../core/tts/audioOutput'
import { buildTtsProviderForConfig } from '../../../core/tts/manager'
import { type Language, createTranslationFunction } from '../../../i18n'
import YoloPlugin from '../../../main'
import {
  TTS_API_FORMATS,
  TTS_OUTPUT_FORMATS,
  TTS_TRANSPORT_MODES,
  type TtsApiFormat,
  type TtsConfig,
  type TtsOutputFormat,
  type TtsTransportMode,
} from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'

type TtsConfigFormProps = {
  plugin: YoloPlugin
  config: TtsConfig | null
}

type FormatDefaults = Pick<
  TtsConfig,
  | 'name'
  | 'format'
  | 'baseURL'
  | 'model'
  | 'voice'
  | 'outputFormat'
  | 'requestPath'
  | 'language'
>

const FORMAT_DEFAULTS: Record<TtsApiFormat, FormatDefaults> = {
  'openai-compatible-speech': {
    name: 'OpenAI Speech',
    format: 'openai-compatible-speech',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    outputFormat: 'mp3',
    requestPath: '',
    language: '',
  },
  'mimo-chat-audio-tts': {
    name: 'MiMo TTS',
    format: 'mimo-chat-audio-tts',
    baseURL: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: 'mimo_default',
    outputFormat: 'mp3',
    requestPath: '/chat/completions',
    language: 'zh',
  },
  'dashscope-cosyvoice': {
    name: 'DashScope CosyVoice',
    format: 'dashscope-cosyvoice',
    baseURL: 'https://dashscope.aliyuncs.com',
    model: 'cosyvoice-v2',
    voice: 'longxiaochun_v2',
    outputFormat: 'mp3',
    requestPath: '',
    language: 'zh',
  },
  'volcengine-tts-http': {
    name: 'Volcengine TTS',
    format: 'volcengine-tts-http',
    baseURL: 'https://openspeech.bytedance.com',
    model: 'seed-tts-2.0',
    voice: 'zh_female_vv_uranus_bigtts',
    outputFormat: 'mp3',
    requestPath: '/api/v3/tts/unidirectional',
    language: '',
  },
}

const FORMAT_LABEL: Record<TtsApiFormat, string> = {
  'openai-compatible-speech': 'OpenAI-compatible speech',
  'mimo-chat-audio-tts': 'MiMo chat audio TTS',
  'dashscope-cosyvoice': 'DashScope CosyVoice',
  'volcengine-tts-http': 'Volcengine TTS',
}

const TRANSPORT_LABEL: Record<TtsTransportMode, string> = {
  auto: 'Auto',
  browser: 'Browser fetch',
  obsidian: 'Obsidian requestUrl',
  node: 'Desktop Node fetch',
}

const OUTPUT_FORMATS_BY_API_FORMAT: Record<TtsApiFormat, TtsOutputFormat[]> = {
  'openai-compatible-speech': [...TTS_OUTPUT_FORMATS],
  'mimo-chat-audio-tts': ['mp3', 'pcm', 'wav', 'pcm16'],
  'dashscope-cosyvoice': ['mp3', 'wav'],
  'volcengine-tts-http': ['mp3', 'wav', 'pcm', 'pcm16', 'opus'],
}

const generateId = (): string =>
  `tts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const createDefaultConfig = (): TtsConfig => ({
  id: generateId(),
  ...FORMAT_DEFAULTS['openai-compatible-speech'],
  apiKey: '',
  sampleRate: null,
  speed: null,
  pitch: null,
  volume: null,
  styleInstruction: '',
  transportMode: 'node',
})

function resolveCurrentLanguage(): Language {
  const rawLanguage = String(getLanguage() ?? '')
    .trim()
    .toLowerCase()
  if (rawLanguage.startsWith('zh')) return 'zh'
  if (rawLanguage.startsWith('it')) return 'it'
  return 'en'
}

function translateOutsideReact(keyPath: string, fallback: string): string {
  return createTranslationFunction(resolveCurrentLanguage())(keyPath, fallback)
}

export class AddTtsConfigModal extends ReactModal<TtsConfigFormProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: TtsConfigFormComponent,
      props: { plugin, config: null },
      options: {
        title: translateOutsideReact(
          'settings.tts.addConfigTitle',
          'Add TTS configuration',
        ),
      },
      plugin,
    })
  }
}

export class EditTtsConfigModal extends ReactModal<TtsConfigFormProps> {
  constructor(app: App, plugin: YoloPlugin, config: TtsConfig) {
    super({
      app,
      Component: TtsConfigFormComponent,
      props: { plugin, config },
      options: {
        title: translateOutsideReact(
          'settings.tts.editConfigTitle',
          'Edit TTS config: {name}',
        ).replace('{name}', config.name || config.id),
      },
      plugin,
    })
  }
}

function TtsConfigFormComponent({
  plugin,
  config,
  onClose,
}: TtsConfigFormProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const [formData, setFormData] = useState<TtsConfig>(
    () => config ?? createDefaultConfig(),
  )
  const isVolcengineTts = formData.format === 'volcengine-tts-http'
  const [testText, setTestText] = useState('你好，谢谢，小笼包，再见。')
  const [testRunning, setTestRunning] = useState(false)
  const [testMessage, setTestMessage] = useState('')
  const [testAudioUrl, setTestAudioUrl] = useState<string | null>(null)
  const testUrlRef = useRef<string | null>(null)
  const testAudioElementRef = useRef<HTMLAudioElement | null>(null)
  const ttsOutputDeviceId =
    plugin.settings.contextVoiceInputOptions.ttsOutputDeviceId ?? ''

  const revokeTestAudioUrl = useCallback(() => {
    if (testUrlRef.current) {
      URL.revokeObjectURL(testUrlRef.current)
      testUrlRef.current = null
    }
  }, [])

  const clearTestAudio = useCallback(() => {
    revokeTestAudioUrl()
    setTestAudioUrl(null)
  }, [revokeTestAudioUrl])

  useEffect(
    () => () => {
      revokeTestAudioUrl()
    },
    [revokeTestAudioUrl],
  )

  useEffect(() => {
    const media = testAudioElementRef.current
    if (!media) return
    void applyAudioOutputDevice(media, ttsOutputDeviceId).catch(
      (error: unknown) => {
        console.warn('Failed to apply TTS test output device:', error)
      },
    )
  }, [testAudioUrl, ttsOutputDeviceId])

  useEffect(() => {
    const allowedFormats = OUTPUT_FORMATS_BY_API_FORMAT[formData.format]
    if (allowedFormats.includes(formData.outputFormat)) return
    setFormData((prev) => ({
      ...prev,
      outputFormat: FORMAT_DEFAULTS[prev.format].outputFormat,
    }))
  }, [formData.format, formData.outputFormat])

  const formatOptions = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        TTS_API_FORMATS.map((format) => [
          format,
          t(`settings.tts.format.${format}`, FORMAT_LABEL[format]),
        ]),
      ),
    [t],
  )
  const outputFormatOptions = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        OUTPUT_FORMATS_BY_API_FORMAT[formData.format].map((format) => [
          format,
          format,
        ]),
      ),
    [formData.format],
  )
  const transportOptions = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        TTS_TRANSPORT_MODES.map((mode) => [
          mode,
          t(`settings.tts.transportMode.${mode}`, TRANSPORT_LABEL[mode]),
        ]),
      ),
    [t],
  )

  const handlePatch = (patch: Partial<TtsConfig>) => {
    setFormData((prev) => ({ ...prev, ...patch }))
    setTestMessage('')
    clearTestAudio()
  }

  const handleFormatChange = (format: TtsApiFormat) => {
    const defaults = FORMAT_DEFAULTS[format]
    setFormData((prev) => ({
      ...prev,
      ...defaults,
      apiKey: prev.apiKey,
      styleInstruction: prev.styleInstruction,
    }))
    setTestMessage('')
    clearTestAudio()
  }

  const handleNumberPatch = (
    field: 'sampleRate' | 'speed' | 'pitch' | 'volume',
    value: string,
  ) => {
    const trimmed = value.trim()
    if (!trimmed) {
      handlePatch({ [field]: null })
      return
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) {
      handlePatch({ [field]: parsed })
    }
  }

  const handleSave = () => {
    void (async () => {
      const latestSettings = plugin.settings
      const latestVoice = latestSettings.contextVoiceInputOptions
      const existing = latestVoice.ttsConfigs ?? []
      const nextConfigs = config
        ? existing.map((item) => (item.id === formData.id ? formData : item))
        : [...existing, formData]
      await plugin.setSettings({
        ...latestSettings,
        contextVoiceInputOptions: {
          ...latestVoice,
          ttsConfigs: nextConfigs,
          activeTtsConfigId:
            latestVoice.activeTtsConfigId ||
            formData.id ||
            nextConfigs[0]?.id ||
            '',
        },
      })
      onClose()
    })().catch((error: unknown) => {
      console.error('Failed to save TTS config', error)
      new Notice(t('settings.tts.saveFailed', 'Failed to save TTS config.'))
    })
  }

  const runTest = () => {
    void (async () => {
      setTestRunning(true)
      setTestMessage('')
      clearTestAudio()
      try {
        const provider = buildTtsProviderForConfig(formData)
        const result = await provider.synthesize({
          text: testText,
          voice: formData.voice,
          model: formData.model,
          format: formData.outputFormat,
          sampleRate: formData.sampleRate ?? undefined,
          speed: formData.speed ?? undefined,
          pitch: formData.pitch ?? undefined,
          volume: formData.volume ?? undefined,
          language: formData.language || undefined,
          styleInstruction: formData.styleInstruction || undefined,
        })
        const url = URL.createObjectURL(
          new Blob([result.bytes], { type: result.mimeType }),
        )
        testUrlRef.current = url
        setTestAudioUrl(url)
        const audio = new Audio(url)
        try {
          let outputApplied = true
          try {
            outputApplied = await applyAudioOutputDevice(
              audio,
              ttsOutputDeviceId,
            )
          } catch (error) {
            console.warn('Failed to apply TTS test output device:', error)
            outputApplied = false
          }
          await audio.play()
          setTestMessage(
            outputApplied
              ? t('settings.tts.testPlaying', 'Playing test audio.')
              : t(
                  'settings.readAloud.speakerUnsupported',
                  'Speaker selection is not supported here; playing through the system default.',
                ),
          )
        } catch {
          setTestMessage(
            t(
              'settings.tts.testReady',
              'Test audio is ready. Use the player below to check playback.',
            ),
          )
        }
      } catch (error) {
        console.error('TTS test failed', error)
        setTestMessage(
          error instanceof Error
            ? error.message
            : t('settings.tts.testFailed', 'TTS test failed.'),
        )
      } finally {
        setTestRunning(false)
      }
    })()
  }

  return (
    <div className="yolo-tts-config-form">
      <ObsidianSetting
        name={t('settings.tts.configName', 'Name')}
        desc={t(
          'settings.tts.configNameDesc',
          'Shown in the read-aloud provider picker.',
        )}
      >
        <ObsidianTextInput
          value={formData.name}
          onChange={(value) => handlePatch({ name: value })}
          placeholder="OpenAI Speech"
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.apiFormat', 'API format')}
        desc={t(
          'settings.tts.apiFormatDesc',
          'Choose the protocol this endpoint speaks.',
        )}
      >
        <ObsidianDropdown
          value={formData.format}
          options={formatOptions}
          onChange={(value) => handleFormatChange(value as TtsApiFormat)}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.baseURL', 'Base URL')}
        desc={t('settings.tts.baseURLDesc', 'Do not include the path here.')}
      >
        <ObsidianTextInput
          value={formData.baseURL}
          onChange={(value) => handlePatch({ baseURL: value })}
          placeholder="https://api.openai.com/v1"
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.requestPath', 'Request path')}
        desc={t(
          'settings.tts.requestPathDesc',
          'Leave blank for the adapter default.',
        )}
      >
        <ObsidianTextInput
          value={formData.requestPath}
          onChange={(value) => handlePatch({ requestPath: value })}
          placeholder="/audio/speech"
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.apiKey', 'API key')}
        desc={t(
          'settings.tts.apiKeyDesc',
          'Leave empty for local servers without auth.',
        )}
      >
        <ObsidianTextInput
          value={formData.apiKey}
          onChange={(value) => handlePatch({ apiKey: value })}
          placeholder={t(
            'settings.tts.apiKeyPlaceholder',
            'Enter your API key',
          )}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.model', 'Model')}
        desc={t('settings.tts.modelDesc', 'Model name sent to the provider.')}
      >
        <ObsidianTextInput
          value={formData.model}
          onChange={(value) => handlePatch({ model: value })}
          placeholder={isVolcengineTts ? 'seed-tts-2.0' : 'gpt-4o-mini-tts'}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.voice', 'Voice')}
        desc={t(
          'settings.tts.voiceDesc',
          'Voice or speaker ID from the provider.',
        )}
      >
        <ObsidianTextInput
          value={formData.voice}
          onChange={(value) => handlePatch({ voice: value })}
          placeholder={isVolcengineTts ? 'zh_female_vv_uranus_bigtts' : 'alloy'}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.outputFormat', 'Output format')}
        desc={t(
          'settings.tts.outputFormatDesc',
          'Audio format requested from the provider.',
        )}
      >
        <ObsidianDropdown
          value={formData.outputFormat}
          options={outputFormatOptions}
          onChange={(value) =>
            handlePatch({ outputFormat: value as TtsOutputFormat })
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.transport', 'Transport')}
        desc={t(
          'settings.tts.transportDesc',
          'HTTP path used by the desktop app. Auto is best unless a provider needs a specific path.',
        )}
      >
        <ObsidianDropdown
          value={formData.transportMode}
          options={transportOptions}
          onChange={(value) =>
            handlePatch({ transportMode: value as TtsTransportMode })
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.language', 'Language')}
        desc={t(
          'settings.tts.languageDesc',
          'Optional language code when the provider supports it.',
        )}
      >
        <ObsidianTextInput
          value={formData.language}
          onChange={(value) => handlePatch({ language: value })}
          placeholder="auto"
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.sampleRate', 'Sample rate')}
        desc={t(
          'settings.tts.sampleRateDesc',
          'Optional output sample rate. Leave blank for the provider default.',
        )}
      >
        <ObsidianTextInput
          value={
            formData.sampleRate === null ? '' : String(formData.sampleRate)
          }
          onChange={(value) => handleNumberPatch('sampleRate', value)}
          placeholder={t('settings.tts.providerDefault', 'Provider default')}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.speed', 'Speed')}
        desc={t(
          'settings.tts.speedDesc',
          'Optional speaking speed multiplier. Leave blank for provider default.',
        )}
      >
        <ObsidianTextInput
          value={formData.speed === null ? '' : String(formData.speed)}
          onChange={(value) => handleNumberPatch('speed', value)}
          placeholder="1"
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.tts.styleInstruction', 'Style instruction')}
        desc={t(
          'settings.tts.styleInstructionDesc',
          'Optional style or tone instruction when the provider supports it.',
        )}
      >
        <ObsidianTextArea
          value={formData.styleInstruction}
          onChange={(value) => handlePatch({ styleInstruction: value })}
          placeholder="Speak clearly and naturally."
        />
      </ObsidianSetting>

      <div className="yolo-tts-test-text-card">
        <div className="yolo-tts-test-text-card__head">
          <div className="setting-item-info">
            <div className="setting-item-name">
              {t('settings.tts.testText', 'Test text')}
            </div>
            <div className="setting-item-description">
              {testMessage ||
                t('settings.tts.testTextDesc', 'Text used only for this test.')}
            </div>
          </div>
          <ObsidianButton
            text={
              testRunning
                ? t('settings.tts.testRunning', 'Testing...')
                : t('settings.tts.testRun', 'Run test')
            }
            disabled={testRunning}
            onClick={runTest}
          />
        </div>
        <div className="yolo-tts-test-text-card__body">
          <ObsidianTextArea
            value={testText}
            onChange={(value) => {
              setTestText(value)
              setTestMessage('')
              clearTestAudio()
            }}
            autoResize
            maxAutoResizeHeight={160}
          />
          {testAudioUrl && (
            <div className="yolo-tts-playback-test">
              <div className="setting-item-info">
                <div className="setting-item-name">
                  {t('settings.tts.testPlayback', 'Audio playback test')}
                </div>
                <div className="setting-item-description">
                  {t(
                    'settings.tts.testPlaybackDesc',
                    'Replay the last generated sample to verify the browser can decode and play it.',
                  )}
                </div>
              </div>
              <audio
                className="yolo-tts-playback-test__audio"
                ref={testAudioElementRef}
                controls
                src={testAudioUrl}
              />
            </div>
          )}
        </div>
      </div>

      <div className="yolo-tts-config-form__footer">
        <ObsidianButton text={t('common.cancel', 'Cancel')} onClick={onClose} />
        <ObsidianButton
          text={config ? t('common.save', 'Save') : t('common.add', 'Add')}
          cta
          onClick={handleSave}
        />
      </div>
    </div>
  )
}
