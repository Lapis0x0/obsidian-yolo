import { Settings, Trash2 } from 'lucide-react'
import { App, Notice } from 'obsidian'
import React from 'react'

import { DEFAULT_PROVIDERS, PROVIDER_TYPES_INFO } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { getEmbeddingModelClient } from '../../../core/rag/embedding'
import SmartComposerPlugin from '../../../main'
import { LLMProvider } from '../../../types/provider.types'
import { ConfirmModal } from '../../modals/ConfirmModal'
import {
  AddProviderModal,
  EditProviderModal,
} from '../modals/ProviderFormModal'

type ProvidersSectionProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function ProvidersSection({ app, plugin }: ProvidersSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const handleDeleteProvider = (provider: LLMProvider) => {
    // Get associated models
    const associatedChatModels = settings.chatModels.filter(
      (m) => m.providerId === provider.id,
    )
    const associatedEmbeddingModels = settings.embeddingModels.filter(
      (m) => m.providerId === provider.id,
    )

    const message =
      `Are you sure you want to delete provider "${provider.id}"?\n\n` +
      `This will also delete:\n` +
      `- ${associatedChatModels.length} chat model(s)\n` +
      `- ${associatedEmbeddingModels.length} embedding model(s)\n\n` +
      `All embeddings generated using the associated embedding models will also be deleted.`

    new ConfirmModal(app, {
      title: 'Delete provider',
      message: message,
      ctaText: 'Delete',
      onConfirm: () => {
        void (async () => {
          try {
            const vectorManager = await plugin.tryGetVectorManager()

            if (vectorManager) {
              const embeddingStats = await vectorManager.getEmbeddingStats()

              // Clear embeddings for each associated embedding model
              for (const embeddingModel of associatedEmbeddingModels) {
                const embeddingStat = embeddingStats.find(
                  (v) => v.model === embeddingModel.id,
                )

                if (embeddingStat?.rowCount && embeddingStat.rowCount > 0) {
                  // only clear when there's data
                  const embeddingModelClient = getEmbeddingModelClient({
                    settings,
                    embeddingModelId: embeddingModel.id,
                  })
                  await vectorManager.clearAllVectors(embeddingModelClient)
                }
              }
            } else {
              console.warn(
                '[Smart Composer] Skip clearing embeddings because vector manager is unavailable.',
              )
            }

            await setSettings({
              ...settings,
              providers: [...settings.providers].filter(
                (v) => v.id !== provider.id,
              ),
              chatModels: [...settings.chatModels].filter(
                (v) => v.providerId !== provider.id,
              ),
              embeddingModels: [...settings.embeddingModels].filter(
                (v) => v.providerId !== provider.id,
              ),
            })
          } catch (error) {
            console.error('[Smart Composer] Failed to delete provider:', error)
            new Notice('Failed to delete provider.')
          }
        })()
      },
    }).open()
  }

  return (
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-header">
        {t('settings.providers.title')}
      </div>

      <div className="smtcmp-settings-desc">
        <span>{t('settings.providers.desc')}</span>
        <br />
        <a
          href="https://github.com/glowingjade/obsidian-smart-composer/wiki/1.2-Initial-Setup#getting-your-api-key"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('settings.providers.howToGetApiKeys')}
        </a>
      </div>

      <div className="smtcmp-settings-table-container">
        <table className="smtcmp-settings-table">
          <colgroup>
            <col />
            <col />
            <col />
            <col width={60} />
          </colgroup>
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>API Key</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {settings.providers.map((provider) => (
              <tr key={provider.id}>
                <td>{provider.id}</td>
                <td>{PROVIDER_TYPES_INFO[provider.presetType].label}</td>
                <td className="smtcmp-settings-table-api-key">
                  <button
                    type="button"
                    className="clickable-icon"
                    onClick={() => {
                      new EditProviderModal(app, plugin, provider).open()
                    }}
                  >
                    {provider.apiKey ? '••••••••' : 'Set API key'}
                  </button>
                </td>
                <td>
                  <div className="smtcmp-settings-actions">
                    <button
                      type="button"
                      onClick={() => {
                        new EditProviderModal(app, plugin, provider).open()
                      }}
                      className="clickable-icon"
                    >
                      <Settings />
                    </button>
                    {!DEFAULT_PROVIDERS.some((v) => v.id === provider.id) && (
                      <button
                        type="button"
                        onClick={() => handleDeleteProvider(provider)}
                        className="clickable-icon"
                      >
                        <Trash2 />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>
                <button
                  type="button"
                  onClick={() => {
                    new AddProviderModal(app, plugin).open()
                  }}
                >
                  Add custom provider
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
