import { App, Notice, Platform } from 'obsidian'
import { useState } from 'react'

import {
  PROMPT_CACHING_SETTING,
  PROVIDER_API_INFO,
  PROVIDER_PRESET_INFO,
} from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import YoloPlugin from '../../../main'
import {
  LLMProvider,
  LLMProviderPresetType,
  ProviderHeader,
  getDefaultApiTypeForPresetType,
  getDefaultRequestTransportModeByPlatform,
  getSupportedApiTypesForPresetType,
  llmProviderSchema,
} from '../../../types/provider.types'
import {
  getDefaultBaseUrlForPreset,
  resolveProviderPrimaryRequestUrl,
} from '../../../utils/llm/provider-base-url'
import {
  getRequestTransportModeValue,
  getResponseStreamingMode,
  providerSupportsTransportModeSelection,
  reconcileEmbeddingModelsForProviderUpdate,
} from '../../../utils/llm/provider-config'
import { sanitizeProviderHeaders } from '../../../utils/llm/provider-headers'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'

type ProviderFormComponentProps = {
  plugin: YoloPlugin
  provider: LLMProvider | null // null for new provider
  initialPresetType?: LLMProviderPresetType
}

const CUSTOM_PROVIDER_TYPE_ENTRIES = Object.entries(PROVIDER_PRESET_INFO)

export class AddProviderModal extends ReactModal<ProviderFormComponentProps> {
  constructor(
    app: App,
    plugin: YoloPlugin,
    initialPresetType?: LLMProviderPresetType,
  ) {
    super({
      app: app,
      Component: ProviderFormComponent,
      props: { plugin, provider: null, initialPresetType },
      options: {
        title: 'Add custom provider', // Will be translated in component
      },
      plugin: plugin,
    })
  }
}

export class EditProviderModal extends ReactModal<ProviderFormComponentProps> {
  constructor(app: App, plugin: YoloPlugin, provider: LLMProvider) {
    super({
      app: app,
      Component: ProviderFormComponent,
      props: { plugin, provider },
      options: {
        title: `Edit provider: ${provider.id}`, // Will be translated in component
      },
      plugin: plugin,
    })
  }
}

function ProviderFormComponent({
  plugin,
  provider,
  initialPresetType,
  onClose,
}: ProviderFormComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const getDefaultAdditionalSettings = (
    _presetType: LLMProvider['presetType'],
  ): LLMProvider['additionalSettings'] => {
    return { requestTransportMode: getDefaultRequestTransportModeByPlatform() }
  }

  const [formData, setFormData] = useState<LLMProvider>(
    provider
      ? ({
          ...provider,
          additionalSettings: provider.additionalSettings
            ? { ...provider.additionalSettings }
            : undefined,
        } as LLMProvider)
      : ((): LLMProvider => {
          const presetType = initialPresetType ?? 'openai-compatible'
          return {
            presetType,
            apiType: getDefaultApiTypeForPresetType(presetType),
            id: '',
            apiKey: '',
            baseUrl: getDefaultBaseUrlForPreset(presetType) ?? '',
            additionalSettings: getDefaultAdditionalSettings(presetType),
          } as LLMProvider
        })(),
  )
  const handleSubmit = () => {
    const execute = async () => {
      const sanitizedCustomHeaders = sanitizeProviderHeaders(
        formData.customHeaders,
      )
      const normalizedFormData: LLMProvider = {
        ...formData,
        ...(sanitizedCustomHeaders.length > 0
          ? { customHeaders: sanitizedCustomHeaders }
          : { customHeaders: undefined }),
      }

      if (provider) {
        if (
          plugin.settings.providers.some(
            (p: LLMProvider) => p.id === formData.id && p.id !== provider.id,
          )
        ) {
          new Notice(
            'Provider with this ID already exists. Try a different ID.',
          )
          return
        }

        const validationResult = llmProviderSchema.safeParse(normalizedFormData)
        if (!validationResult.success) {
          new Notice(
            validationResult.error.issues.map((v) => v.message).join('\n'),
          )
          return
        }

        const providerIndex = plugin.settings.providers.findIndex(
          (v) => v.id === provider.id,
        )

        if (providerIndex === -1) {
          new Notice(`No provider found with this ID`)
          return
        }

        const validatedProvider = validationResult.data
        const providerIdChanged = provider.id !== validatedProvider.id
        const providerPresetChanged =
          provider.presetType !== validatedProvider.presetType
        const providerApiChanged =
          provider.apiType !== validatedProvider.apiType
        const updatedProviders = [...plugin.settings.providers]
        updatedProviders[providerIndex] = validatedProvider

        const becameOpenRouter =
          providerPresetChanged && validatedProvider.presetType === 'openrouter'
        const updatedChatModels =
          providerIdChanged || becameOpenRouter
            ? plugin.settings.chatModels.map((model) => {
                if (model.providerId !== provider.id) {
                  return model
                }
                const updatedModel = {
                  ...model,
                  ...(providerIdChanged
                    ? { providerId: validatedProvider.id }
                    : {}),
                  ...(becameOpenRouter &&
                  model.builtinToolProvider !== 'none' &&
                  model.builtinToolProvider !== 'openrouter'
                    ? { builtinToolProvider: 'none' as const }
                    : {}),
                }
                return updatedModel
              })
            : plugin.settings.chatModels

        const updatedEmbeddingModels: typeof plugin.settings.embeddingModels =
          providerIdChanged || providerPresetChanged || providerApiChanged
            ? reconcileEmbeddingModelsForProviderUpdate({
                embeddingModels: plugin.settings.embeddingModels,
                previousProvider: provider,
                nextProvider: validatedProvider,
              })
            : plugin.settings.embeddingModels

        await plugin.setSettings({
          ...plugin.settings,
          providers: updatedProviders,
          chatModels: updatedChatModels,
          embeddingModels: updatedEmbeddingModels,
        })
      } else {
        if (
          plugin.settings.providers.some(
            (p: LLMProvider) => p.id === formData.id,
          )
        ) {
          new Notice(
            'Provider with this ID already exists. Try a different ID.',
          )
          return
        }

        const validationResult = llmProviderSchema.safeParse(normalizedFormData)
        if (!validationResult.success) {
          new Notice(
            validationResult.error.issues.map((v) => v.message).join('\n'),
          )
          return
        }

        const validatedProvider = validationResult.data
        await plugin.setSettings({
          ...plugin.settings,
          providers: [...plugin.settings.providers, validatedProvider],
        })
      }

      onClose()
    }

    void execute().catch((error) => {
      console.error('[YOLO] Failed to save provider:', error)
      new Notice('Failed to save provider settings.')
    })
  }

  const providerTypeInfo = PROVIDER_PRESET_INFO[formData.presetType]
  const providerApiOptions = Object.fromEntries(
    getSupportedApiTypesForPresetType(formData.presetType).map((apiType) => [
      apiType,
      PROVIDER_API_INFO[apiType].label,
    ]),
  )
  const shouldHideCredentialFields =
    formData.presetType === 'chatgpt-oauth' ||
    formData.presetType === 'gemini-oauth' ||
    formData.presetType === 'qwen-oauth'
  const shouldShowBaseUrlField =
    !shouldHideCredentialFields &&
    !(
      formData.presetType === 'amazon-bedrock' &&
      formData.apiType === 'amazon-bedrock'
    )
  const requestTransportOptions = {
    browser: t('settings.providers.requestTransportModeBrowser'),
    obsidian: t('settings.providers.requestTransportModeObsidian'),
    ...(Platform.isDesktop
      ? {
          node: t('settings.providers.requestTransportModeNode'),
        }
      : {}),
  }
  const responseStreamingOptions = {
    auto: t('settings.providers.responseStreamingModeAuto'),
    streaming: t('settings.providers.responseStreamingModeStreaming'),
    'non-streaming': t('settings.providers.responseStreamingModeNonStreaming'),
  }
  type AdditionalSettingEntry =
    | (typeof providerTypeInfo.additionalSettings)[number]
    | typeof PROMPT_CACHING_SETTING
  const baseAdditionalSettings: AdditionalSettingEntry[] =
    formData.apiType === 'anthropic'
      ? [PROMPT_CACHING_SETTING, ...providerTypeInfo.additionalSettings]
      : [...providerTypeInfo.additionalSettings]
  const visibleAdditionalSettings = baseAdditionalSettings.filter(
    (setting) =>
      setting.key !== 'requestTransportMode' ||
      providerSupportsTransportModeSelection(formData),
  )
  const apiKeyDesc =
    formData.presetType === 'amazon-bedrock'
      ? 'Enter your Amazon Bedrock API key / bearer token.'
      : t('settings.providers.apiKeyDesc')
  const apiKeyPlaceholder =
    formData.presetType === 'amazon-bedrock'
      ? 'Enter your Amazon Bedrock API key'
      : t('settings.providers.apiKeyPlaceholder')
  const baseUrlPlaceholder =
    formData.presetType === 'amazon-bedrock' &&
    formData.apiType === 'openai-compatible'
      ? 'https://bedrock-mantle.us-east-1.api.aws'
      : t('settings.providers.baseUrlPlaceholder')
  const primaryRequestUrlPreview = resolveProviderPrimaryRequestUrl(formData)

  return (
    <div className="yolo-provider-form">
      <ObsidianSetting
        name={t('settings.providers.providerId', 'ID')}
        desc={t(
          'settings.providers.providerIdDesc',
          'Choose an ID to identify this provider in your settings. This is just for your reference.',
        )}
        required
      >
        <ObsidianTextInput
          value={formData.id}
          placeholder={t(
            'settings.providers.providerIdPlaceholder',
            'my-custom-provider',
          )}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, id: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting name="Provider preset" required>
        <ObsidianDropdown
          value={formData.presetType}
          options={Object.fromEntries(
            CUSTOM_PROVIDER_TYPE_ENTRIES.map(([key, info]) => [
              key,
              info.label,
            ]),
          )}
          onChange={(value: string) =>
            setFormData((prev) => {
              const nextPreset = value as LLMProvider['presetType']
              return {
                ...prev,
                presetType: nextPreset,
                apiType: getDefaultApiTypeForPresetType(nextPreset),
                additionalSettings: getDefaultAdditionalSettings(nextPreset),
                baseUrl: getDefaultBaseUrlForPreset(nextPreset) ?? '',
              } as LLMProvider
            })
          }
        />
      </ObsidianSetting>

      <ObsidianSetting name="API type" required>
        <ObsidianDropdown
          value={formData.apiType}
          options={providerApiOptions}
          onChange={(value: string) =>
            setFormData((prev) => ({
              ...prev,
              apiType: value as LLMProvider['apiType'],
            }))
          }
        />
      </ObsidianSetting>

      {!shouldHideCredentialFields && (
        <>
          <div className="setting-item yolo-provider-field-block yolo-provider-api-key-setting">
            <div className="yolo-provider-field-header">
              <div
                className={`setting-item-name ${
                  providerTypeInfo.requireApiKey ? 'yolo-settings-required' : ''
                }`}
              >
                {t('settings.providers.apiKey')}
              </div>
            </div>
            <div className="yolo-provider-field-body">
              <input
                className="yolo-provider-field-input"
                type="text"
                value={formData.apiKey ?? ''}
                placeholder={apiKeyPlaceholder}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setFormData((prev) => ({ ...prev, apiKey: value }))
                }}
              />
              <div className="yolo-provider-field-help">{apiKeyDesc}</div>
            </div>
          </div>

          {shouldShowBaseUrlField && (
            <div className="setting-item yolo-provider-field-block yolo-provider-base-url-setting">
              <div className="yolo-provider-field-header">
                <div
                  className={`setting-item-name ${
                    providerTypeInfo.requireBaseUrl
                      ? 'yolo-settings-required'
                      : ''
                  }`}
                >
                  {t('settings.providers.baseUrl')}
                </div>
              </div>
              <div className="yolo-provider-field-body">
                <input
                  className="yolo-provider-field-input"
                  type="text"
                  value={formData.baseUrl ?? ''}
                  placeholder={baseUrlPlaceholder}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    setFormData((prev) => ({
                      ...prev,
                      baseUrl: value,
                    }))
                  }}
                />
                <div className="yolo-provider-api-url-preview">
                  <span className="yolo-provider-api-url-preview-label">
                    {t('settings.providers.apiUrlPreviewLabel', 'Preview')}
                  </span>
                  <span className="yolo-provider-api-url-preview-url">
                    {primaryRequestUrlPreview}
                  </span>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {visibleAdditionalSettings.map((setting) => {
        const label =
          setting.key === 'noStainless'
            ? t('settings.providers.noStainlessHeaders')
            : setting.key === 'requestTransportMode'
              ? t('settings.providers.requestTransportMode')
              : setting.key === 'responseStreamingMode'
                ? t('settings.providers.responseStreamingMode')
                : setting.key === 'promptCaching'
                  ? t('settings.providers.promptCaching')
                  : setting.label
        const description =
          setting.key === 'noStainless'
            ? t('settings.providers.noStainlessHeadersDesc')
            : setting.key === 'requestTransportMode'
              ? t('settings.providers.requestTransportModeDesc')
              : setting.key === 'responseStreamingMode'
                ? t('settings.providers.responseStreamingModeDesc')
                : setting.key === 'promptCaching'
                  ? t('settings.providers.promptCachingDesc')
                  : (setting as { description?: string }).description

        return (
          <ObsidianSetting
            key={setting.key}
            name={label}
            desc={description}
            required={setting.required}
          >
            {setting.type === 'toggle' ? (
              <ObsidianToggle
                value={
                  (formData.additionalSettings as Record<string, boolean>)?.[
                    setting.key
                  ] ?? false
                }
                onChange={(value: boolean) =>
                  setFormData(
                    (prev) =>
                      ({
                        ...prev,
                        additionalSettings: {
                          ...(prev.additionalSettings ?? {}),
                          [setting.key]: value,
                        },
                      }) as LLMProvider,
                  )
                }
              />
            ) : setting.type === 'select' &&
              setting.key === 'requestTransportMode' ? (
              <ObsidianDropdown
                value={getRequestTransportModeValue(
                  formData.additionalSettings,
                  Platform.isDesktop,
                )}
                options={requestTransportOptions}
                onChange={(value: string) =>
                  setFormData((prev) => {
                    const previousMode =
                      prev.additionalSettings?.requestTransportMode
                    const previousByPlatform =
                      previousMode &&
                      typeof previousMode === 'object' &&
                      !Array.isArray(previousMode)
                        ? previousMode
                        : getDefaultRequestTransportModeByPlatform()

                    return {
                      ...prev,
                      additionalSettings: {
                        ...(prev.additionalSettings ?? {}),
                        [setting.key]: {
                          ...previousByPlatform,
                          [Platform.isDesktop ? 'desktop' : 'mobile']: value,
                        },
                      },
                    } as LLMProvider
                  })
                }
              />
            ) : setting.type === 'select' &&
              setting.key === 'responseStreamingMode' ? (
              <ObsidianDropdown
                value={getResponseStreamingMode(formData.additionalSettings)}
                options={responseStreamingOptions}
                onChange={(value: string) =>
                  setFormData(
                    (prev) =>
                      ({
                        ...prev,
                        additionalSettings: {
                          ...(prev.additionalSettings ?? {}),
                          [setting.key]: value,
                        },
                      }) as LLMProvider,
                  )
                }
              />
            ) : setting.type === 'text' ? (
              <ObsidianTextInput
                value={
                  (formData.additionalSettings as Record<string, string>)?.[
                    setting.key
                  ] ?? ''
                }
                placeholder={setting.placeholder}
                onChange={(value: string) =>
                  setFormData(
                    (prev) =>
                      ({
                        ...prev,
                        additionalSettings: {
                          ...(prev.additionalSettings ?? {}),
                          [setting.key]: value,
                        },
                      }) as LLMProvider,
                  )
                }
              />
            ) : null}
          </ObsidianSetting>
        )
      })}

      <ObsidianSetting
        name={t('settings.providers.customHeaders')}
        desc={t('settings.providers.customHeadersDesc')}
      >
        <ObsidianButton
          text={t('settings.providers.customHeadersAdd')}
          onClick={() =>
            setFormData((prev) => ({
              ...prev,
              customHeaders: [
                ...(prev.customHeaders ?? []),
                { key: '', value: '' } as ProviderHeader,
              ],
            }))
          }
        />
      </ObsidianSetting>

      {(formData.customHeaders ?? []).map((header, index) => (
        <ObsidianSetting
          key={`${header.key}-${header.value}-${index}`}
          className="yolo-settings-kv-entry yolo-settings-kv-entry--inline yolo-provider-headers-entry"
        >
          <ObsidianTextInput
            value={header.key}
            placeholder={t('settings.providers.customHeadersKeyPlaceholder')}
            onChange={(value: string) =>
              setFormData((prev) => {
                const nextHeaders = [...(prev.customHeaders ?? [])]
                nextHeaders[index] = { ...nextHeaders[index], key: value }
                return {
                  ...prev,
                  customHeaders: nextHeaders,
                }
              })
            }
          />
          <ObsidianTextInput
            value={header.value}
            placeholder={t('settings.providers.customHeadersValuePlaceholder')}
            onChange={(value: string) =>
              setFormData((prev) => {
                const nextHeaders = [...(prev.customHeaders ?? [])]
                nextHeaders[index] = { ...nextHeaders[index], value }
                return {
                  ...prev,
                  customHeaders: nextHeaders,
                }
              })
            }
          />
          <ObsidianButton
            text={t('common.remove')}
            onClick={() =>
              setFormData((prev) => ({
                ...prev,
                customHeaders: (prev.customHeaders ?? []).filter(
                  (_, removeIndex) => removeIndex !== index,
                ),
              }))
            }
          />
        </ObsidianSetting>
      ))}

      <ObsidianSetting>
        <ObsidianButton
          text={provider ? t('common.save') : t('common.add')}
          onClick={handleSubmit}
          cta
        />
        <ObsidianButton text={t('common.cancel')} onClick={onClose} />
      </ObsidianSetting>
    </div>
  )
}
