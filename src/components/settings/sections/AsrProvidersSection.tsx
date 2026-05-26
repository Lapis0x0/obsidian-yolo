import { useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { buildAsrProviderForFormat } from '../../../core/asr/manager'
import type { AsrAudioInput } from '../../../core/asr/types'
import { VoiceInputRecorder } from '../../../features/editor/context-voice-input/voiceInputRecorder'
import {
  ASR_API_FORMATS,
  type AsrApiFormat,
  type AsrProviderProfiles,
  type ContextVoiceInputOptions,
} from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'

type TestStatus = ContextVoiceInputOptions['lastAsrTestStatus']

const TEST_RECORDING_SECONDS = 5

const formatLabel = (format: AsrApiFormat): string => {
  switch (format) {
    case 'openai-compatible-transcription':
      return 'OpenAI-compatible transcription (/v1/audio/transcriptions)'
    case 'openai-compatible-chat-audio-asr':
      return 'OpenAI-compatible chat audio ASR (/v1/chat/completions)'
    default:
      return format
  }
}

export function AsrProvidersSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const voice = settings.contextVoiceInputOptions
  const [testRunning, setTestRunning] = useState(false)
  const [testTranscript, setTestTranscript] = useState<string>('')

  const selectedFormat = voice.selectedAsrApiFormat
  const profiles = voice.asrProviderProfiles

  const updateVoice = useCallback(
    (patch: Partial<ContextVoiceInputOptions>, context: string) => {
      void (async () => {
        try {
          await setSettings({
            ...settings,
            contextVoiceInputOptions: {
              ...voice,
              ...patch,
            },
          })
        } catch (error: unknown) {
          console.error(
            `Failed to update voice input settings: ${context}`,
            error,
          )
        }
      })()
    },
    [settings, setSettings, voice],
  )

  const updateProfile = useCallback(
    <K extends keyof AsrProviderProfiles>(
      format: K,
      patch: Partial<NonNullable<AsrProviderProfiles[K]>>,
    ) => {
      const existing =
        profiles[format] ?? ({} as NonNullable<AsrProviderProfiles[K]>)
      const next: AsrProviderProfiles = {
        ...profiles,
        [format]: { ...existing, ...patch },
      }
      updateVoice(
        {
          asrProviderProfiles: next,
          lastAsrTestStatus: 'untested',
          lastAsrTestMessage: '',
        },
        `asrProviderProfile.${String(format)}`,
      )
      setTestTranscript('')
    },
    [profiles, updateVoice],
  )

  const transcriptionProfile = useMemo(
    () => profiles['openai-compatible-transcription'] ?? null,
    [profiles],
  )
  const chatAudioProfile = useMemo(
    () => profiles['openai-compatible-chat-audio-asr'] ?? null,
    [profiles],
  )

  const handleFormatChange = useCallback(
    (value: string) => {
      if ((ASR_API_FORMATS as readonly string[]).includes(value)) {
        updateVoice(
          { selectedAsrApiFormat: value as AsrApiFormat },
          'selectedAsrApiFormat',
        )
        setTestTranscript('')
      }
    },
    [updateVoice],
  )

  const runVoiceTest = useCallback(async () => {
    if (testRunning) return
    setTestRunning(true)
    setTestTranscript('')

    let provider
    try {
      provider = buildAsrProviderForFormat(selectedFormat, profiles)
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'ASR not configured.'
      updateVoice(
        { lastAsrTestStatus: 'failed', lastAsrTestMessage: message },
        'asrTest.configError',
      )
      setTestRunning(false)
      return
    }

    const recorder = new VoiceInputRecorder()
    let recorded: AsrAudioInput | null = null
    try {
      await recorder.start({ maxRecordingSeconds: TEST_RECORDING_SECONDS })
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
      const message =
        error instanceof Error ? error.message : 'Recording failed.'
      updateVoice(
        { lastAsrTestStatus: 'failed', lastAsrTestMessage: message },
        'asrTest.recordError',
      )
      setTestRunning(false)
      return
    }

    try {
      const result = await provider.transcribe(recorded, {
        language: voice.language,
      })
      const text = (result.text ?? '').trim()
      setTestTranscript(text)
      updateVoice(
        {
          lastAsrTestStatus: text.length > 0 ? 'passed' : 'failed',
          lastAsrTestMessage:
            text.length > 0
              ? `OK (${result.requestDurationMs ?? 0} ms)`
              : 'ASR returned empty text.',
        },
        'asrTest.transcribe',
      )
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'ASR request failed.'
      updateVoice(
        { lastAsrTestStatus: 'failed', lastAsrTestMessage: message },
        'asrTest.transcribeError',
      )
    } finally {
      setTestRunning(false)
    }
  }, [profiles, selectedFormat, testRunning, updateVoice, voice.language])

  const testStatus: TestStatus = voice.lastAsrTestStatus ?? 'untested'

  return (
    <div className="yolo-settings-section yolo-settings-section--tight">
      <section className="yolo-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t('settings.asr.title', 'Voice recognition (ASR)')}
            </div>
            <div className="yolo-settings-desc yolo-settings-block-desc">
              {t(
                'settings.asr.description',
                'Configure how recorded audio is transcribed for context-aware voice input. The polish LLM is set under Editor → Voice input.',
              )}
            </div>
          </div>
        </div>

        <div className="yolo-settings-block-content">
          <ObsidianSetting
            name={t('settings.asr.apiFormat', 'API format')}
            desc={t(
              'settings.asr.apiFormatDesc',
              'Switching formats keeps the other format’s configuration so you can A/B-test endpoints without retyping.',
            )}
            className="yolo-models-select-card"
          >
            <ObsidianDropdown
              value={selectedFormat}
              options={Object.fromEntries(
                ASR_API_FORMATS.map((f) => [f, formatLabel(f)]),
              )}
              onChange={handleFormatChange}
            />
          </ObsidianSetting>

          {selectedFormat === 'openai-compatible-transcription' && (
            <>
              <ObsidianSetting
                name={t('settings.asr.baseURL', 'Base URL')}
                desc={t(
                  'settings.asr.baseURLDesc',
                  'Root URL of the OpenAI-compatible transcription server, including the /v1 segment if any.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianTextInput
                  value={transcriptionProfile?.baseURL ?? ''}
                  onChange={(value) =>
                    updateProfile('openai-compatible-transcription', {
                      baseURL: value,
                    })
                  }
                  placeholder="https://api.openai.com/v1"
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.asr.apiKey', 'API key')}
                desc={t(
                  'settings.asr.apiKeyDesc',
                  'Leave empty for local servers that do not require auth.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianTextInput
                  value={transcriptionProfile?.apiKey ?? ''}
                  onChange={(value) =>
                    updateProfile('openai-compatible-transcription', {
                      apiKey: value,
                    })
                  }
                  placeholder="sk-..."
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.asr.model', 'Model')}
                desc={t(
                  'settings.asr.modelDesc',
                  'e.g. whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe, or a local model id.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianTextInput
                  value={transcriptionProfile?.model ?? ''}
                  onChange={(value) =>
                    updateProfile('openai-compatible-transcription', {
                      model: value,
                    })
                  }
                  placeholder="whisper-1"
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.asr.transcriptionPath', 'Transcription path')}
                desc={t(
                  'settings.asr.transcriptionPathDesc',
                  'Override only if your server uses a non-default path. Defaults to /audio/transcriptions; the /v1 prefix should live in Base URL.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianTextInput
                  value={transcriptionProfile?.transcriptionPath ?? ''}
                  onChange={(value) =>
                    updateProfile('openai-compatible-transcription', {
                      transcriptionPath: value,
                    })
                  }
                  placeholder="/audio/transcriptions"
                />
              </ObsidianSetting>
            </>
          )}

          {selectedFormat === 'openai-compatible-chat-audio-asr' && (
            <>
              <ObsidianSetting
                name={t('settings.asr.baseURL', 'Base URL')}
                desc={t(
                  'settings.asr.baseURLDesc',
                  'Root URL of the OpenAI-compatible chat-completions server, including the /v1 segment if any.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianTextInput
                  value={chatAudioProfile?.baseURL ?? ''}
                  onChange={(value) =>
                    updateProfile('openai-compatible-chat-audio-asr', {
                      baseURL: value,
                    })
                  }
                  placeholder="https://api.openai.com/v1"
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.asr.apiKey', 'API key')}
                desc={t(
                  'settings.asr.apiKeyDesc',
                  'Leave empty for local servers that do not require auth.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianTextInput
                  value={chatAudioProfile?.apiKey ?? ''}
                  onChange={(value) =>
                    updateProfile('openai-compatible-chat-audio-asr', {
                      apiKey: value,
                    })
                  }
                  placeholder="sk-..."
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.asr.model', 'Model')}
                desc={t(
                  'settings.asr.chatAudioModelDesc',
                  'A model that accepts audio in chat messages, e.g. gpt-4o-audio-preview or a vLLM-served Qwen3-ASR / FireRedASR2-LLM endpoint.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianTextInput
                  value={chatAudioProfile?.model ?? ''}
                  onChange={(value) =>
                    updateProfile('openai-compatible-chat-audio-asr', {
                      model: value,
                    })
                  }
                  placeholder="gpt-4o-audio-preview"
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t(
                  'settings.asr.chatCompletionsPath',
                  'Chat completions path',
                )}
                desc={t(
                  'settings.asr.chatCompletionsPathDesc',
                  'Override only if your server uses a non-default path. Defaults to /chat/completions; the /v1 prefix should live in Base URL.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianTextInput
                  value={chatAudioProfile?.chatCompletionsPath ?? ''}
                  onChange={(value) =>
                    updateProfile('openai-compatible-chat-audio-asr', {
                      chatCompletionsPath: value,
                    })
                  }
                  placeholder="/chat/completions"
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t(
                  'settings.asr.audioContentFormat',
                  'Audio content format',
                )}
                desc={t(
                  'settings.asr.audioContentFormatDesc',
                  'How the audio is embedded in the chat message content. Use input_audio for OpenAI-style; switch to audio_url if your server expects a data-URL part.',
                )}
                className="yolo-models-select-card"
              >
                <ObsidianDropdown
                  value={chatAudioProfile?.audioContentFormat ?? 'input_audio'}
                  options={{
                    input_audio: 'input_audio',
                    audio_url: 'audio_url',
                  }}
                  onChange={(value) =>
                    updateProfile('openai-compatible-chat-audio-asr', {
                      audioContentFormat: value,
                    })
                  }
                />
              </ObsidianSetting>
            </>
          )}

          <ObsidianSetting
            name={t('settings.asr.language', 'Language hint')}
            desc={t(
              'settings.asr.languageDesc',
              'BCP47 code (e.g. en, zh) sent to the ASR. Use "auto" to let the provider detect.',
            )}
            className="yolo-models-select-card"
          >
            <ObsidianTextInput
              value={voice.language}
              onChange={(value) => updateVoice({ language: value }, 'language')}
              placeholder="auto"
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.asr.testRecording', 'Test recording')}
            desc={t(
              'settings.asr.testRecordingDesc',
              `Records ${TEST_RECORDING_SECONDS} seconds of audio and runs the current ASR provider so you can verify the configuration end-to-end.`,
            )}
            className="yolo-models-select-card"
          >
            <ObsidianButton
              text={
                testRunning
                  ? t('settings.asr.testRunning', 'Recording...')
                  : t('settings.asr.testRun', 'Run test')
              }
              disabled={testRunning}
              onClick={() => void runVoiceTest()}
            />
          </ObsidianSetting>

          {(testTranscript.length > 0 || voice.lastAsrTestMessage) && (
            <div
              className="yolo-settings-card"
              data-asr-test-status={testStatus}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {testStatus === 'passed'
                  ? t('settings.asr.testPassed', 'Test passed')
                  : testStatus === 'failed'
                    ? t('settings.asr.testFailed', 'Test failed')
                    : t('settings.asr.testUntested', 'Untested')}
              </div>
              {voice.lastAsrTestMessage && (
                <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
                  {voice.lastAsrTestMessage}
                </div>
              )}
              {testTranscript.length > 0 && (
                <div style={{ whiteSpace: 'pre-wrap' }}>{testTranscript}</div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
