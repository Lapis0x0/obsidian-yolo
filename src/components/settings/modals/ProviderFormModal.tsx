import { App, Notice } from 'obsidian'
import { useState } from 'react'

import { PROVIDER_TYPES_INFO } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import SmartComposerPlugin from '../../../main'
import { chatModelSchema } from '../../../types/chat-model.types'
import { embeddingModelSchema } from '../../../types/embedding-model.types'
import { LLMProvider, llmProviderSchema } from '../../../types/provider.types'
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
          type: 'openai-compatible',
          id: '',
          apiKey: '',
          baseUrl: '',
        },
  )
  const handleSubmit = () => {
    const execute = async () => {
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

        const validationResult = llmProviderSchema.safeParse(formData)
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
        const providerTypeChanged = provider.type !== validatedProvider.type

        const updatedProviders = [...plugin.settings.providers]
        updatedProviders[providerIndex] = validatedProvider

        const updatedChatModels =
          providerIdChanged || providerTypeChanged
            ? plugin.settings.chatModels.map((model) => {
                if (model.providerId !== provider.id) {
                  return model
                }
                const updatedModel = {
                  ...model,
                  ...(providerIdChanged
                    ? { providerId: validatedProvider.id }
                    : {}),
                  ...(providerTypeChanged
                    ? { providerType: validatedProvider.type }
                    : {}),
                }
                return providerTypeChanged
                  ? chatModelSchema.parse(updatedModel)
                  : updatedModel
              })
            : plugin.settings.chatModels

        const updatedEmbeddingModels =
          providerIdChanged || providerTypeChanged
            ? plugin.settings.embeddingModels.map((model) => {
                if (model.providerId !== provider.id) {
                  return model
                }
                const updatedModel = {
                  ...model,
                  ...(providerIdChanged
                    ? { providerId: validatedProvider.id }
                    : {}),
                  ...(providerTypeChanged
                    ? { providerType: validatedProvider.type }
                    : {}),
                }
                return providerTypeChanged
                  ? embeddingModelSchema.parse(updatedModel)
                  : updatedModel
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

        const validationResult = llmProviderSchema.safeParse(formData)
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
      console.error('[Smart Composer] Failed to save provider:', error)
      new Notice('Failed to save provider settings.')
    })
  }

  const providerTypeInfo = PROVIDER_TYPES_INFO[formData.type]

  return (
    <>
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

      <ObsidianSetting name="Provider type" required>
        <ObsidianDropdown
          value={formData.type}
          options={Object.fromEntries(
            Object.entries(PROVIDER_TYPES_INFO).map(([key, info]) => [
              key,
              info.label,
            ]),
          )}
          onChange={(value: string) =>
            setFormData(
              (prev) =>
                ({
                  ...prev,
                  type: value,
                  additionalSettings: {},
                }) as LLMProvider,
            )
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
            : setting.key === 'useObsidianRequestUrl'
              ? t('settings.providers.useObsidianRequestUrl')
              : setting.label
        const description =
          setting.key === 'noStainless'
            ? t('settings.providers.noStainlessHeadersDesc')
            : setting.key === 'useObsidianRequestUrl'
              ? t('settings.providers.useObsidianRequestUrlDesc')
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

      <ObsidianSetting>
        <ObsidianButton
          text={provider ? t('common.save') : t('common.add')}
          onClick={handleSubmit}
          cta
        />
        <ObsidianButton text={t('common.cancel')} onClick={onClose} />
      </ObsidianSetting>
    </>
  )
}
