import { App, Notice } from 'obsidian'
import React, { useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { extractEmbeddingVector } from '../../../core/llm/embedding-utils'
import { getProviderClient } from '../../../core/llm/manager'
import SmartComposerPlugin from '../../../main'
import { EmbeddingModel } from '../../../types/embedding-model.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'

type EditEmbeddingModelModalComponentProps = {
  plugin: SmartComposerPlugin
  model: EmbeddingModel
}

export class EditEmbeddingModelModal extends ReactModal<EditEmbeddingModelModalComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin, model: EmbeddingModel) {
    super({
      app: app,
      Component: EditEmbeddingModelModalComponent,
      props: { plugin, model },
      options: {
        title: 'Edit custom embedding model', // Will be translated in component
      },
      plugin: plugin,
    })
  }
}

function EditEmbeddingModelModalComponent({
  plugin,
  onClose,
  model,
}: EditEmbeddingModelModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()

  // Update modal title
  React.useEffect(() => {
    const modalEl = document.querySelector('.modal .modal-title')
    if (modalEl) {
      modalEl.textContent = t('settings.models.editCustomEmbeddingModel')
    }
  }, [t])
  const [formData, setFormData] = useState<{
    id: string
    model: string
    name: string | undefined
    dimension: string
  }>({
    id: model.id,
    model: model.model,
    name: model.name,
    dimension: model.dimension?.toString() || '',
  })

  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = () => {
    if (!formData.model.trim()) {
      new Notice(t('common.error'))
      return
    }

    const execute = async () => {
      const dimension = formData.dimension
        ? parseInt(formData.dimension, 10)
        : undefined
      if (!dimension || isNaN(dimension) || dimension <= 0) {
        new Notice('Invalid dimension value')
        return
      }

      setIsSubmitting(true)
      try {
        const settings = plugin.settings
        const embeddingModels = [...settings.embeddingModels]
        const modelIndex = embeddingModels.findIndex((m) => m.id === model.id)

        if (modelIndex === -1) {
          new Notice('Model not found')
          return
        }

        const dimensionChanged = dimension !== model.dimension

        if (dimensionChanged) {
          const providerClient = getProviderClient({
            settings,
            providerId: model.providerId,
          })
          const probed = await providerClient.getEmbedding(
            formData.model,
            'test',
            { dimensions: dimension },
          )
          const actualDimension = extractEmbeddingVector(probed).length
          if (actualDimension !== dimension) {
            new Notice(
              `The model returned ${actualDimension} dimensions, but you requested ${dimension}. This model may not support variable dimensions.`,
            )
            return
          }
        }

        embeddingModels[modelIndex] = {
          ...embeddingModels[modelIndex],
          model: formData.model,
          name:
            formData.name && formData.name.trim().length > 0
              ? formData.name
              : formData.model,
          dimension,
        }

        await plugin.setSettings({
          ...settings,
          embeddingModels,
        })

        if (dimensionChanged) {
          new Notice(
            'Dimension updated. Please rebuild the index for this model to refresh existing vectors.',
          )
        } else {
          new Notice(t('common.success'))
        }
        onClose()
      } catch (error) {
        console.error('Failed to update embedding model:', error)
        new Notice(error instanceof Error ? error.message : t('common.error'))
      } finally {
        setIsSubmitting(false)
      }
    }

    void execute()
  }

  return (
    <>
      {/* Display name */}
      <ObsidianSetting name={t('settings.models.modelName')}>
        <ObsidianTextInput
          value={formData.name ?? ''}
          placeholder={t('settings.models.modelNamePlaceholder')}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, name: value }))
          }
        />
      </ObsidianSetting>

      {/* Model calling ID */}
      <ObsidianSetting
        name={t('settings.models.modelId')}
        desc={t('settings.models.modelIdDesc')}
        required
      >
        <ObsidianTextInput
          value={formData.model}
          placeholder={t('settings.models.modelIdPlaceholder')}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, model: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.models.dimension')}
        desc={t('settings.models.dimensionDesc')}
      >
        <ObsidianTextInput
          value={formData.dimension}
          placeholder={t('settings.models.dimensionPlaceholder')}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, dimension: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting>
        <ObsidianButton
          text={isSubmitting ? t('common.probingDimension') : t('common.save')}
          onClick={handleSubmit}
          cta
          disabled={isSubmitting}
        />
        <ObsidianButton
          text={t('common.cancel')}
          onClick={onClose}
          disabled={isSubmitting}
        />
      </ObsidianSetting>
    </>
  )
}
