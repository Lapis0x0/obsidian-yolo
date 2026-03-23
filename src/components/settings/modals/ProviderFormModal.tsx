import { App, Notice, Platform } from 'obsidian'
import { useState } from 'react'

import { PROVIDER_API_INFO, PROVIDER_PRESET_INFO } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import SmartComposerPlugin from '../../../main'
import { chatModelSchema } from '../../../types/chat-model.types'
import { embeddingModelSchema } from '../../../types/embedding-model.types'
import {
  LLMProvider,
  ProviderHeader,
  getDefaultApiTypeForPresetType,
  getSupportedApiTypesForPresetType,
  llmProviderSchema,
} from '../../../types/provider.types'
import { sanitizeProviderHeaders } from '../../../utils/llm/provider-headers'
import { getRequestTransportModeValue } from '../../../utils/llm/provider-config'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'

type ProviderFormComponentProps = {
  plugin: SmartComposerPlugin
  provider: LLMProvider | null // null for new provider
}

const CUSTOM_PROVIDER_TYPE_ENTRIES = Object.entries(PROVIDER_PRESET_INFO)

export class AddProviderModal extends ReactModal<ProviderFormComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app: app,
      Component: ProviderFormComponent,
      props: { plugin, provider: null },
      options: {
        title: 'Add custom provider', // Will be translated in component
      },
      plugin: plugin,
    })
  }
}

export class EditProviderModal extends ReactModal<ProviderFormComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin, provider: LLMProvider) {
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
  onClose,
}: ProviderFormComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()

  const [formData, setFormData] = useState<LLMProvider>(
    provider
      ? ({
          ...provider,
          additionalSettings: provider.additionalSettings
            ? { ...provider.additionalSettings }
            : undefined,
        } as LLMProvider)
      : {
          presetType: 'openai-compatible',
          apiType: getDefaultApiTypeForPresetType('openai-compatible'),
          id: '',
          apiKey: '',
          baseUrl: '',
        },
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
        const providerApiTypeChanged =
          provider.apiType !== validatedProvider.apiType

        const updatedProviders = [...plugin.settings.providers]
        updatedProviders[providerIndex] = validatedProvider

        const updatedChatModels = providerIdChanged
          ? plugin.settings.chatModels.map((model) => {
              if (model.providerId !== provider.id) {
                return model
              }
              const updatedModel = {
                ...model,
                ...(providerIdChanged
                  ? { providerId: validatedProvider.id }
                  : {}),
              }
              return updatedModel
            })
          : plugin.settings.chatModels

        const updatedEmbeddingModels: typeof plugin.settings.embeddingModels =
          providerIdChanged || providerPresetChanged
            ? providerPresetChanged &&
              !PROVIDER_PRESET_INFO[validatedProvider.presetType]
                .supportEmbedding
              ? plugin.settings.embeddingModels
              : plugin.settings.embeddingModels.map((model) => {
                  if (model.providerId !== provider.id) {
                    return model
                  }
                  const updatedModel = {
                    ...model,
                    ...(providerIdChanged
                      ? { providerId: validatedProvider.id }
                      : {}),
                  }
                  return updatedModel as typeof model
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
  const requestTransportOptions = {
    auto: t('settings.providers.requestTransportModeAuto'),
    browser: t('settings.providers.requestTransportModeBrowser'),
    obsidian: t('settings.providers.requestTransportModeObsidian'),
    ...(Platform.isDesktop
      ? {
          node: t('settings.providers.requestTransportModeNode'),
        }
      : {}),
  }

  return (
    <div className="smtcmp-provider-form">
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
            setFormData(
              (prev) =>
                ({
                  ...prev,
                  presetType: value as LLMProvider['presetType'],
                  apiType: getDefaultApiTypeForPresetType(
                    value as LLMProvider['presetType'],
                  ),
                  additionalSettings: {},
                }) as LLMProvider,
            )
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

      <ObsidianSetting
        name={t('settings.providers.apiKey')}
        desc={t('settings.providers.apiKeyDesc')}
        required={providerTypeInfo.requireApiKey}
      >
        <ObsidianTextInput
          value={formData.apiKey ?? ''}
          placeholder={t('settings.providers.apiKeyPlaceholder')}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, apiKey: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.providers.baseUrl')}
        desc={t('settings.providers.baseUrlDesc')}
        required={providerTypeInfo.requireBaseUrl}
      >
        <ObsidianTextInput
          value={formData.baseUrl ?? ''}
          placeholder={t('settings.providers.baseUrlPlaceholder')}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, baseUrl: value }))
          }
        />
      </ObsidianSetting>

      {providerTypeInfo.additionalSettings.map((setting) => {
        const label =
          setting.key === 'noStainless'
            ? t('settings.providers.noStainlessHeaders')
            : setting.key === 'requestTransportMode'
              ? t('settings.providers.requestTransportMode')
              : setting.label
        const description =
          setting.key === 'noStainless'
            ? t('settings.providers.noStainlessHeadersDesc')
            : setting.key === 'requestTransportMode'
              ? t('settings.providers.requestTransportModeDesc')
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
            ) : setting.type === 'select' ? (
              <ObsidianDropdown
                value={getRequestTransportModeValue(
                  formData.additionalSettings as
                    | Record<string, unknown>
                    | undefined,
                )}
                options={requestTransportOptions}
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
            ) : (
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
            )}
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
          className="smtcmp-settings-kv-entry smtcmp-settings-kv-entry--inline smtcmp-provider-headers-entry"
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
