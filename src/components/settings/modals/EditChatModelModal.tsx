import { App, Notice } from 'obsidian'
import React, { useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import SmartComposerPlugin from '../../../main'
import { ChatModel } from '../../../types/chat-model.types'
import {
  detectReasoningTypeFromModelId,
  ensureUniqueModelId,
  generateModelId,
} from '../../../utils/model-id-utils'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'

type EditChatModelModalComponentProps = {
  plugin: SmartComposerPlugin
  model: ChatModel
}

type EditableChatModel = ChatModel & {
  reasoning?: {
    enabled: boolean
    reasoning_effort?: string
  }
  thinking?: {
    enabled: boolean
    thinking_budget?: number // Gemini, OpenRouter
    budget_tokens?: number // Anthropic
  }
  toolType?: 'none' | 'gemini'
  isBaseModel?: boolean
  customParameters?: { key: string; value: string }[]
}

export class EditChatModelModal extends ReactModal<EditChatModelModalComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin, model: ChatModel) {
    super({
      app: app,
      Component: EditChatModelModalComponent,
      props: { plugin, model },
      options: {
        title: 'Edit custom chat model', // Will be translated in component
      },
      plugin: plugin,
    })
  }
}

function EditChatModelModalComponent({
  plugin,
  onClose,
  model,
}: EditChatModelModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const editableModel: EditableChatModel = model
  const defaultSamplingCustomParameters: { key: string; value: string }[] = [
    { key: 'temperature', value: '0.8' },
    { key: 'top_p', value: '' },
  ]
  const withSamplingDefaults = (entries?: { key: string; value: string }[]) => {
    const base = Array.isArray(entries) ? entries : []
    const existingKeys = new Set(
      base.map((entry) => entry.key.trim().toLowerCase()),
    )
    const defaultsToAdd = defaultSamplingCustomParameters.filter(
      (entry) => !existingKeys.has(entry.key),
    )
    return [...defaultsToAdd, ...base]
  }

  const normalizeReasoningType = (
    value: string,
  ): 'none' | 'openai' | 'gemini' | 'base' => {
    if (value === 'openai' || value === 'gemini' || value === 'base') {
      return value
    }
    return 'none'
  }

  const normalizeReasoningEffort = (
    value: string,
  ): 'minimal' | 'low' | 'medium' | 'high' => {
    switch (value) {
      case 'minimal':
      case 'low':
      case 'medium':
      case 'high':
        return value
      default:
        return 'medium'
    }
  }

  const normalizeToolType = (value: string): 'none' | 'gemini' =>
    value === 'gemini' ? 'gemini' : 'none'

  // Update modal title
  React.useEffect(() => {
    const modalEl = document.querySelector('.modal .modal-title')
    if (modalEl) {
      modalEl.textContent = t('settings.models.editCustomChatModel')
    }
  }, [t])
  const [formData, setFormData] = useState<{
    model: string
    name: string
  }>({
    model: model.model,
    name: model.name ?? '',
  })

  const initialReasoningType: 'none' | 'openai' | 'gemini' | 'base' = (() => {
    if (editableModel.isBaseModel) return 'base'
    if (editableModel.reasoning?.enabled) return 'openai'
    if (editableModel.thinking?.enabled) return 'gemini'
    return 'none'
  })()

  // Reasoning UI states
  const [reasoningType, setReasoningType] = useState<
    'none' | 'openai' | 'gemini' | 'base'
  >(() => initialReasoningType)
  // If user changes dropdown manually, disable auto detection
  const [autoDetectReasoning, setAutoDetectReasoning] = useState<boolean>(
    initialReasoningType !== 'base',
  )
  const [openaiEffort, setOpenaiEffort] = useState<
    'minimal' | 'low' | 'medium' | 'high'
  >(() =>
    normalizeReasoningEffort(
      editableModel.reasoning?.reasoning_effort ?? 'medium',
    ),
  )
  const [geminiBudget, setGeminiBudget] = useState<string>(() =>
    typeof editableModel.thinking?.thinking_budget === 'number'
      ? `${editableModel.thinking.thinking_budget}`
      : '-1',
  )

  // Tool type state
  const [toolType, setToolType] = useState<'none' | 'gemini'>(
    normalizeToolType(editableModel.toolType ?? 'none'),
  )
  const [customParameters, setCustomParameters] = useState<
    { key: string; value: string }[]
  >(() => withSamplingDefaults(editableModel.customParameters))

  const handleSubmit = () => {
    if (!formData.model.trim()) {
      new Notice(t('common.error'))
      return
    }

    const execute = async () => {
      try {
        const settings = plugin.settings
        const chatModels = [...settings.chatModels]
        const modelIndex = chatModels.findIndex((m) => m.id === model.id)

        if (modelIndex === -1) {
          new Notice('Model not found')
          return
        }

        // Compute new internal id from provider + API model id (calling ID)
        const baseInternalId = generateModelId(model.providerId, formData.model)
        const existingIds = chatModels
          .map((m) => m.id)
          .filter((id) => id !== model.id)
        const newInternalId = ensureUniqueModelId(existingIds, baseInternalId)

        // Compose reasoning/thinking fields based on selection and provider
        const updatedModel: EditableChatModel = {
          ...chatModels[modelIndex],
          id: newInternalId,
          model: formData.model,
          name:
            formData.name && formData.name.trim().length > 0
              ? formData.name
              : undefined,
        }

        // Apply according to selected reasoningType only (not limited by providerType)
        if (reasoningType === 'base') {
          delete updatedModel.reasoning
          delete updatedModel.thinking
          updatedModel.isBaseModel = true
        } else if (reasoningType === 'openai') {
          updatedModel.reasoning = {
            enabled: true,
            reasoning_effort: openaiEffort,
          }
          delete updatedModel.thinking
          delete updatedModel.isBaseModel
        } else if (reasoningType === 'gemini') {
          const budget = parseInt(geminiBudget, 10)
          if (Number.isNaN(budget)) {
            new Notice(t('common.error'))
            return
          }
          updatedModel.thinking = { enabled: true, thinking_budget: budget }
          delete updatedModel.reasoning
          delete updatedModel.isBaseModel
        } else {
          delete updatedModel.reasoning
          delete updatedModel.thinking
          delete updatedModel.isBaseModel
        }

        // Apply tool type
        updatedModel.toolType = toolType

        const sanitizedCustomParameters = customParameters
          .map((entry) => ({ key: entry.key.trim(), value: entry.value }))
          .filter((entry) => entry.key.length > 0)

        if (sanitizedCustomParameters.length > 0) {
          updatedModel.customParameters = sanitizedCustomParameters
        } else {
          delete updatedModel.customParameters
        }

        // Update the model
        chatModels[modelIndex] = updatedModel

        // Update references if current selection points to the old id
        const nextSettings = { ...settings, chatModels }
        if (nextSettings.chatModelId === model.id) {
          nextSettings.chatModelId = newInternalId
        }
        if (nextSettings.applyModelId === model.id) {
          nextSettings.applyModelId = newInternalId
        }

        await plugin.setSettings(nextSettings)

        new Notice(t('common.success'))
        onClose()
      } catch (error) {
        console.error('Failed to update chat model:', error)
        new Notice(t('common.error'))
      }
    }

    void execute()
  }

  return (
    <>
      <ObsidianSetting
        name={t('settings.models.modelId')}
        desc={t('settings.models.modelIdDesc')}
        required
      >
        <ObsidianTextInput
          value={formData.model}
          placeholder={t('settings.models.modelIdPlaceholder')}
          onChange={(value: string) => {
            setFormData((prev) => ({ ...prev, model: value }))
            if (autoDetectReasoning) {
              const detected = detectReasoningTypeFromModelId(value)
              setReasoningType(detected)
            }
          }}
        />
      </ObsidianSetting>

      {/* Display name (move right below modelId) */}
      <ObsidianSetting name={t('settings.models.modelName')}>
        <ObsidianTextInput
          value={formData.name}
          placeholder={t('settings.models.modelNamePlaceholder')}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, name: value }))
          }
        />
      </ObsidianSetting>

      {/* Reasoning type */}
      <ObsidianSetting name={t('settings.models.reasoningType')}>
        <ObsidianDropdown
          value={reasoningType}
          options={{
            none: t('settings.models.reasoningTypeNone'),
            openai: t('settings.models.reasoningTypeOpenAI'),
            gemini: t('settings.models.reasoningTypeGemini'),
            base: t('settings.models.reasoningTypeBase'),
          }}
          onChange={(v: string) => {
            setReasoningType(normalizeReasoningType(v))
            setAutoDetectReasoning(false)
          }}
        />
      </ObsidianSetting>

      {reasoningType === 'base' && (
        <div className="smtcmp-settings-desc">
          {t('settings.models.baseModelWarning')}
        </div>
      )}

      {/* OpenAI reasoning options */}
      {reasoningType === 'openai' && (
        <ObsidianSetting
          name={t('settings.models.openaiReasoningEffort')}
          desc={t('settings.models.openaiReasoningEffortDesc')}
        >
          <ObsidianDropdown
            value={openaiEffort}
            options={{
              minimal: 'minimal',
              low: 'low',
              medium: 'medium',
              high: 'high',
            }}
            onChange={(v: string) =>
              setOpenaiEffort(normalizeReasoningEffort(v))
            }
          />
        </ObsidianSetting>
      )}

      {/* Gemini thinking options */}
      {reasoningType === 'gemini' && (
        <ObsidianSetting
          name={t('settings.models.geminiThinkingBudget')}
          desc={t('settings.models.geminiThinkingBudgetDesc')}
        >
          <ObsidianTextInput
            value={geminiBudget}
            placeholder={t('settings.models.geminiThinkingBudgetPlaceholder')}
            onChange={(v: string) => setGeminiBudget(v)}
          />
        </ObsidianSetting>
      )}

      {/* Tool type */}
      <ObsidianSetting
        name={t('settings.models.toolType')}
        desc={t('settings.models.toolTypeDesc')}
      >
        <ObsidianDropdown
          value={toolType}
          options={{
            none: t('settings.models.toolTypeNone'),
            gemini: t('settings.models.toolTypeGemini'),
          }}
          onChange={(v: string) => setToolType(normalizeToolType(v))}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.models.customParameters')}
        desc={t('settings.models.customParametersDesc')}
      >
        <ObsidianButton
          text={t('settings.models.customParametersAdd')}
          onClick={() =>
            setCustomParameters((prev) => [...prev, { key: '', value: '' }])
          }
        />
      </ObsidianSetting>

      {customParameters.map((param, index) => (
        <ObsidianSetting
          key={`custom-parameter-${index}`}
          className="smtcmp-settings-kv-entry"
        >
          <ObsidianTextInput
            value={param.key}
            placeholder={t('settings.models.customParametersKeyPlaceholder')}
            onChange={(value: string) =>
              setCustomParameters((prev) => {
                const next = [...prev]
                next[index] = { ...next[index], key: value }
                return next
              })
            }
          />
          <ObsidianTextInput
            value={param.value}
            placeholder={t('settings.models.customParametersValuePlaceholder')}
            onChange={(value: string) =>
              setCustomParameters((prev) => {
                const next = [...prev]
                next[index] = { ...next[index], value }
                return next
              })
            }
          />
          <ObsidianButton
            text={t('common.remove')}
            onClick={() =>
              setCustomParameters((prev) =>
                prev.filter((_, removeIndex) => removeIndex !== index),
              )
            }
          />
        </ObsidianSetting>
      ))}

      <ObsidianSetting>
        <ObsidianButton text={t('common.save')} onClick={handleSubmit} cta />
        <ObsidianButton text={t('common.cancel')} onClick={onClose} />
      </ObsidianSetting>
    </>
  )
}
