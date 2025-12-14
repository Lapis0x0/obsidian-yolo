import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ChevronDown,
  ChevronRight,
  Edit,
  GripVertical,
  Settings,
  Trash2,
} from 'lucide-react'
import { App, Notice } from 'obsidian'
import React, { useMemo, useState } from 'react'

import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_EMBEDDING_MODELS,
  PROVIDER_TYPES_INFO,
} from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { getEmbeddingModelClient } from '../../../core/rag/embedding'
import SmartComposerPlugin from '../../../main'
import { ChatModel } from '../../../types/chat-model.types'
import { EmbeddingModel } from '../../../types/embedding-model.types'
import { LLMProvider } from '../../../types/provider.types'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { AddChatModelModal } from '../modals/AddChatModelModal'
import { AddEmbeddingModelModal } from '../modals/AddEmbeddingModelModal'
import { EditChatModelModal } from '../modals/EditChatModelModal'
import { EditEmbeddingModelModal } from '../modals/EditEmbeddingModelModal'
import {
  AddProviderModal,
  EditProviderModal,
} from '../modals/ProviderFormModal'

type ProvidersAndModelsSectionProps = {
  app: App
  plugin: SmartComposerPlugin
}

type ProviderSectionItemProps = {
  provider: LLMProvider
  app: App
  plugin: SmartComposerPlugin
  t: Translator
  isExpanded: boolean
  toggleProvider: (id: string) => void
  chatModels: ChatModel[]
  embeddingModels: EmbeddingModel[]
  modelSensors: ReturnType<typeof useSensors>
  handleDeleteProvider: (provider: LLMProvider) => void
  handleDeleteChatModel: (modelId: string) => void
  handleDeleteEmbeddingModel: (modelId: string) => void
  handleToggleEnableChatModel: (modelId: string, value: boolean) => void
  handleChatModelDragEnd: (event: DragEndEvent) => void
  handleEmbeddingModelDragEnd: (event: DragEndEvent) => void
}

function ProviderSectionItem({
  provider,
  app,
  plugin,
  t,
  isExpanded,
  toggleProvider,
  chatModels,
  embeddingModels,
  modelSensors,
  handleDeleteProvider,
  handleDeleteChatModel,
  handleDeleteEmbeddingModel,
  handleToggleEnableChatModel,
  handleChatModelDragEnd,
  handleEmbeddingModelDragEnd,
}: ProviderSectionItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: provider.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`smtcmp-provider-section ${isDragging ? 'smtcmp-provider-dragging' : ''}`}
      data-provider-id={provider.id}
      {...attributes}
    >
      <div
        className="smtcmp-provider-header smtcmp-clickable"
        onClick={() => toggleProvider(provider.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleProvider(provider.id)
          }
        }}
      >
        <span
          className="smtcmp-provider-drag-handle"
          aria-label={t('settings.providers.dragHandle', 'Drag to reorder')}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          {...listeners}
        >
          <GripVertical />
        </span>

        <div className="smtcmp-provider-expand-btn">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>

        <div className="smtcmp-provider-info">
          <span className="smtcmp-provider-id">{provider.id}</span>
          <span className="smtcmp-provider-type">
            {PROVIDER_TYPES_INFO[provider.type].label}
          </span>
          <span
            className="smtcmp-provider-api-key"
            onClick={(e) => {
              e.stopPropagation()
              new EditProviderModal(app, plugin, provider).open()
            }}
          >
            {provider.apiKey ? '••••••••' : 'Set API key'}
          </span>
        </div>

        <div className="smtcmp-provider-actions">
          <button
            onClick={(e) => {
              e.stopPropagation()
              new EditProviderModal(app, plugin, provider).open()
            }}
            className="clickable-icon"
          >
            <Settings />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleDeleteProvider(provider)
            }}
            className="clickable-icon"
          >
            <Trash2 />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="smtcmp-provider-models">
          <ChatModelsTable
            provider={provider}
            app={app}
            plugin={plugin}
            t={t}
            models={chatModels}
            sensors={modelSensors}
            onDragEnd={handleChatModelDragEnd}
            onToggle={handleToggleEnableChatModel}
            onDelete={handleDeleteChatModel}
          />

          <EmbeddingModelsTable
            provider={provider}
            app={app}
            plugin={plugin}
            t={t}
            models={embeddingModels}
            sensors={modelSensors}
            onDragEnd={handleEmbeddingModelDragEnd}
            onDelete={handleDeleteEmbeddingModel}
          />
        </div>
      )}
    </div>
  )
}

type ChatModelsTableProps = {
  provider: LLMProvider
  app: App
  plugin: SmartComposerPlugin
  t: Translator
  models: ChatModel[]
  sensors: ReturnType<typeof useSensors>
  onDragEnd: (event: DragEndEvent) => void
  onToggle: (modelId: string, value: boolean) => void
  onDelete: (modelId: string) => void
}

function ChatModelsTable({
  provider,
  app,
  plugin,
  t,
  models,
  sensors,
  onDragEnd,
  onToggle,
  onDelete,
}: ChatModelsTableProps) {
  const items = models.map((model) => model.id)

  return (
    <div className="smtcmp-models-subsection">
      <div className="smtcmp-models-subsection-header">
        <span>{t('settings.models.chatModels')}</span>
        <button
          className="smtcmp-add-model-btn"
          onClick={() => {
            const modal = new AddChatModelModal(app, plugin, provider)
            modal.open()
          }}
        >
          + {t('settings.models.addChatModel')}
        </button>
      </div>

      {models.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={items} strategy={verticalListSortingStrategy}>
            <table className="smtcmp-models-table">
              <colgroup>
                <col width={16} />
                <col />
                <col />
                <col width={60} />
                <col width={60} />
              </colgroup>
              <thead>
                <tr>
                  <th></th>
                  <th>{t('settings.models.modelName')}</th>
                  <th>Model (calling ID)</th>
                  <th>Enable</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <ChatModelRow
                    key={model.id}
                    provider={provider}
                    model={model}
                    app={app}
                    plugin={plugin}
                    t={t}
                    onToggle={onToggle}
                    onDelete={onDelete}
                  />
                ))}
              </tbody>
            </table>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="smtcmp-no-models">
          {t('settings.models.noChatModelsConfigured')}
        </div>
      )}
    </div>
  )
}

type EmbeddingModelsTableProps = {
  provider: LLMProvider
  app: App
  plugin: SmartComposerPlugin
  t: Translator
  models: EmbeddingModel[]
  sensors: ReturnType<typeof useSensors>
  onDragEnd: (event: DragEndEvent) => void
  onDelete: (modelId: string) => void
}

function EmbeddingModelsTable({
  provider,
  app,
  plugin,
  t,
  models,
  sensors,
  onDragEnd,
  onDelete,
}: EmbeddingModelsTableProps) {
  const items = models.map((model) => model.id)

  return (
    <div className="smtcmp-models-subsection">
      <div className="smtcmp-models-subsection-header">
        <span>{t('settings.models.embeddingModels')}</span>
        <button
          className="smtcmp-add-model-btn"
          onClick={() => {
            const modal = new AddEmbeddingModelModal(app, plugin, provider)
            modal.open()
          }}
        >
          + {t('settings.models.addEmbeddingModel')}
        </button>
      </div>

      {models.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={items} strategy={verticalListSortingStrategy}>
            <table className="smtcmp-models-table smtcmp-embedding-models-table">
              <colgroup>
                <col width={16} />
                <col />
                <col />
                <col width={80} />
                <col width={60} />
              </colgroup>
              <thead>
                <tr>
                  <th></th>
                  <th>{t('settings.models.modelName')}</th>
                  <th>Model (calling ID)</th>
                  <th>Dimension</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <EmbeddingModelRow
                    key={model.id}
                    provider={provider}
                    model={model}
                    app={app}
                    plugin={plugin}
                    t={t}
                    onDelete={onDelete}
                  />
                ))}
              </tbody>
            </table>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="smtcmp-no-models">
          {t('settings.models.noEmbeddingModelsConfigured')}
        </div>
      )}
    </div>
  )
}

type ChatModelRowProps = {
  provider: LLMProvider
  model: ChatModel
  app: App
  plugin: SmartComposerPlugin
  t: Translator
  onToggle: (modelId: string, value: boolean) => void
  onDelete: (modelId: string) => void
}

function ChatModelRow({
  provider,
  model,
  app,
  plugin,
  t,
  onToggle,
  onDelete,
}: ChatModelRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: model.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const isDefault = DEFAULT_CHAT_MODELS.some(
    (v) => v.id === model.id && v.providerId === model.providerId,
  )

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={isDragging ? 'smtcmp-row-dragging' : ''}
      data-model-id={model.id}
      data-model-key={`${provider.id}:${model.id}`}
      {...attributes}
      {...listeners}
    >
      <td>
        <span
          className="smtcmp-drag-handle"
          aria-label={t('settings.models.dragHandle', 'Drag to reorder')}
        >
          <GripVertical />
        </span>
      </td>
      <td title={model.id}>{model.name || model.model || model.id}</td>
      <td>{model.model || model.id}</td>
      <td onPointerDown={(event) => event.stopPropagation()}>
        <ObsidianToggle
          value={model.enable ?? true}
          onChange={(value) => onToggle(model.id, value)}
        />
      </td>
      <td>
        <div className="smtcmp-settings-actions">
          <button
            onClick={() => new EditChatModelModal(app, plugin, model).open()}
            className="clickable-icon"
            title="Edit model"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Edit />
          </button>
          {!isDefault && (
            <button
              onClick={() => onDelete(model.id)}
              className="clickable-icon"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Trash2 />
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

type EmbeddingModelRowProps = {
  provider: LLMProvider
  model: EmbeddingModel
  app: App
  plugin: SmartComposerPlugin
  t: Translator
  onDelete: (modelId: string) => void
}

function EmbeddingModelRow({
  provider,
  model,
  app,
  plugin,
  t,
  onDelete,
}: EmbeddingModelRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: model.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const isDefault = DEFAULT_EMBEDDING_MODELS.some(
    (v) => v.id === model.id && v.providerId === model.providerId,
  )

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={isDragging ? 'smtcmp-row-dragging' : ''}
      data-model-id={model.id}
      data-model-key={`${provider.id}:${model.id}`}
      {...attributes}
      {...listeners}
    >
      <td>
        <span
          className="smtcmp-drag-handle"
          aria-label={t('settings.models.dragHandle', 'Drag to reorder')}
        >
          <GripVertical />
        </span>
      </td>
      <td title={model.id}>{model.name ?? model.model ?? model.id}</td>
      <td title={model.model}>{model.model}</td>
      <td>{model.dimension}</td>
      <td>
        <div className="smtcmp-settings-actions">
          {!isDefault && (
            <>
              <button
                onClick={() =>
                  new EditEmbeddingModelModal(app, plugin, model).open()
                }
                className="clickable-icon"
                title="Edit model"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <Edit />
              </button>
              <button
                onClick={() => onDelete(model.id)}
                className="clickable-icon"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <Trash2 />
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  )
}

type Translator = ReturnType<typeof useLanguage>['t']

export function ProvidersAndModelsSection({
  app,
  plugin,
}: ProvidersAndModelsSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(
    new Set(),
  )
  const providerSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )
  const modelSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )
  const providerIds = useMemo(
    () => settings.providers.map((provider) => provider.id),
    [settings.providers],
  )

  // Robustly highlight the moved row after DOM re-render
  const triggerProviderDropSuccess = (providerId: string, movedId: string) => {
    const key = `${providerId}:${movedId}`
    const tryFind = (attempt = 0) => {
      let movedRow = document.querySelector(`tr[data-model-key="${key}"]`)
      if (!movedRow) {
        movedRow = document.querySelector(`tr[data-model-id="${movedId}"]`)
      }
      if (movedRow) {
        movedRow.classList.add('smtcmp-row-drop-success')
        window.setTimeout(() => {
          movedRow.classList.remove('smtcmp-row-drop-success')
        }, 700)
      } else if (attempt < 8) {
        window.setTimeout(() => tryFind(attempt + 1), 50)
      }
    }
    requestAnimationFrame(() => tryFind())
  }

  const handleProviderDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) {
      return
    }

    const oldIndex = settings.providers.findIndex((p) => p.id === active.id)
    const newIndex = settings.providers.findIndex((p) => p.id === over.id)
    if (oldIndex < 0 || newIndex < 0) {
      return
    }

    const reorderedProviders = arrayMove(settings.providers, oldIndex, newIndex)
    try {
      await setSettings({
        ...settings,
        providers: reorderedProviders,
      })
      triggerProviderDropSuccessFeedback(String(active.id))
    } catch (error) {
      console.error('[Smart Composer] Failed to reorder providers:', error)
      new Notice('Failed to reorder providers.')
    }
  }

  const handleChatModelDragEnd = async (
    providerId: string,
    { active, over }: DragEndEvent,
  ) => {
    if (!over || active.id === over.id) {
      return
    }

    const providerModels = settings.chatModels.filter(
      (model) => model.providerId === providerId,
    )
    const oldIndex = providerModels.findIndex((model) => model.id === active.id)
    const newIndex = providerModels.findIndex((model) => model.id === over.id)
    if (oldIndex < 0 || newIndex < 0) {
      return
    }

    const reorderedProviderModels = arrayMove(
      providerModels,
      oldIndex,
      newIndex,
    )
    const queue = [...reorderedProviderModels]
    const updatedChatModels = settings.chatModels.map((model) => {
      if (model.providerId !== providerId) {
        return model
      }
      return queue.shift() ?? model
    })

    try {
      await setSettings({
        ...settings,
        chatModels: updatedChatModels,
      })
      triggerProviderDropSuccess(providerId, String(active.id))
    } catch (error) {
      console.error('[Smart Composer] Failed to reorder chat models:', error)
      new Notice('Failed to reorder chat models.')
    }
  }

  const handleEmbeddingModelDragEnd = async (
    providerId: string,
    { active, over }: DragEndEvent,
  ) => {
    if (!over || active.id === over.id) {
      return
    }

    const providerModels = settings.embeddingModels.filter(
      (model) => model.providerId === providerId,
    )
    const oldIndex = providerModels.findIndex((model) => model.id === active.id)
    const newIndex = providerModels.findIndex((model) => model.id === over.id)
    if (oldIndex < 0 || newIndex < 0) {
      return
    }

    const reorderedProviderModels = arrayMove(
      providerModels,
      oldIndex,
      newIndex,
    )
    const queue = [...reorderedProviderModels]
    const updatedEmbeddingModels = settings.embeddingModels.map((model) => {
      if (model.providerId !== providerId) {
        return model
      }
      return queue.shift() ?? model
    })

    try {
      await setSettings({
        ...settings,
        embeddingModels: updatedEmbeddingModels,
      })
      triggerProviderDropSuccess(providerId, String(active.id))
    } catch (error) {
      console.error(
        '[Smart Composer] Failed to reorder embedding models:',
        error,
      )
      new Notice('Failed to reorder embedding models.')
    }
  }

  const toggleProvider = (providerId: string) => {
    const newExpanded = new Set(expandedProviders)
    if (newExpanded.has(providerId)) {
      newExpanded.delete(providerId)
    } else {
      newExpanded.add(providerId)
    }
    setExpandedProviders(newExpanded)
  }

  const handleDeleteProvider = (provider: LLMProvider) => {
    void (async () => {
      const associatedChatModels = settings.chatModels.filter(
        (m) => m.providerId === provider.id,
      )
      const associatedEmbeddingModels = settings.embeddingModels.filter(
        (m) => m.providerId === provider.id,
      )

      // Handle default model reassignment before deletion
      const newSettings = { ...settings }

      // Find alternative chat models from other providers
      const otherChatModels = settings.chatModels.filter(
        (m) => m.providerId !== provider.id && (m.enable ?? true),
      )

      // Find alternative embedding models from other providers
      const otherEmbeddingModels = settings.embeddingModels.filter(
        (m) => m.providerId !== provider.id,
      )

      // Check if current chat model is from this provider and reassign
      if (associatedChatModels.some((m) => m.id === settings.chatModelId)) {
        newSettings.chatModelId =
          otherChatModels.length > 0 ? otherChatModels[0].id : ''
      }

      // Check if current apply model is from this provider and reassign
      if (associatedChatModels.some((m) => m.id === settings.applyModelId)) {
        newSettings.applyModelId =
          otherChatModels.length > 0 ? otherChatModels[0].id : ''
      }

      // Check if current embedding model is from this provider and reassign
      if (
        associatedEmbeddingModels.some(
          (m) => m.id === settings.embeddingModelId,
        )
      ) {
        newSettings.embeddingModelId =
          otherEmbeddingModels.length > 0 ? otherEmbeddingModels[0].id : ''
      }

      try {
        const vectorManager = await plugin.tryGetVectorManager()

        if (vectorManager) {
          const embeddingStats = await vectorManager.getEmbeddingStats()

          for (const embeddingModel of associatedEmbeddingModels) {
            const embeddingStat = embeddingStats.find(
              (v) => v.model === embeddingModel.id,
            )

            if (embeddingStat?.rowCount && embeddingStat.rowCount > 0) {
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

        // Delete provider and associated models
        await setSettings({
          ...newSettings,
          providers: settings.providers.filter((v) => v.id !== provider.id),
          chatModels: settings.chatModels.filter(
            (v) => v.providerId !== provider.id,
          ),
          embeddingModels: settings.embeddingModels.filter(
            (v) => v.providerId !== provider.id,
          ),
        })

        new Notice(`Provider "${provider.id}" deleted successfully.`)
      } catch (error) {
        console.error('[Smart Composer] Failed to delete provider:', error)
        new Notice('Failed to delete provider.')
      }
    })()
  }

  const handleDeleteChatModel = (modelId: string) => {
    if (modelId === settings.chatModelId || modelId === settings.applyModelId) {
      new Notice(
        'Cannot remove model that is currently selected as chat model or tool model',
      )
      return
    }

    void (async () => {
      try {
        await setSettings({
          ...settings,
          chatModels: settings.chatModels.filter((v) => v.id !== modelId),
        })
      } catch (error: unknown) {
        console.error('[Smart Composer] Failed to delete chat model:', error)
        new Notice('Failed to delete chat model.')
      }
    })()
  }

  const handleDeleteEmbeddingModel = (modelId: string) => {
    if (modelId === settings.embeddingModelId) {
      new Notice(
        'Cannot remove model that is currently selected as embedding model',
      )
      return
    }

    void (async () => {
      try {
        const vectorManager = await plugin.tryGetVectorManager()
        if (vectorManager) {
          const embeddingStats = await vectorManager.getEmbeddingStats()
          const embeddingStat = embeddingStats.find((v) => v.model === modelId)
          const rowCount = embeddingStat?.rowCount || 0

          if (rowCount > 0) {
            const embeddingModelClient = getEmbeddingModelClient({
              settings,
              embeddingModelId: modelId,
            })
            await vectorManager.clearAllVectors(embeddingModelClient)
          }
        } else {
          console.warn(
            '[Smart Composer] Skip clearing embeddings because vector manager is unavailable.',
          )
        }
        await setSettings({
          ...settings,
          embeddingModels: settings.embeddingModels.filter(
            (v) => v.id !== modelId,
          ),
        })
      } catch (error) {
        console.error(
          '[Smart Composer] Failed to delete embedding model:',
          error,
        )
        new Notice('Failed to delete embedding model.')
      }
    })()
  }

  const handleToggleEnableChatModel = (modelId: string, value: boolean) => {
    void (async () => {
      try {
        if (
          !value &&
          (modelId === settings.chatModelId ||
            modelId === settings.applyModelId)
        ) {
          new Notice(
            'Cannot disable model that is currently selected as chat model or tool model',
          )
          await setSettings({
            ...settings,
            chatModels: settings.chatModels.map((v) =>
              v.id === modelId ? { ...v, enable: true } : v,
            ),
          })
          return
        }

        await setSettings({
          ...settings,
          chatModels: settings.chatModels.map((v) =>
            v.id === modelId ? { ...v, enable: value } : v,
          ),
        })
      } catch (error: unknown) {
        console.error(
          '[Smart Composer] Failed to update chat model state:',
          error,
        )
        new Notice('Failed to update chat model.')
      }
    })()
  }

  const triggerProviderDropSuccessFeedback = (movedId: string) => {
    const tryFind = (attempt = 0) => {
      const movedSection = document.querySelector(
        `.smtcmp-provider-section[data-provider-id="${movedId}"]`,
      )
      if (movedSection) {
        movedSection.classList.add('smtcmp-provider-drop-success')
        window.setTimeout(() => {
          movedSection.classList.remove('smtcmp-provider-drop-success')
        }, 700)
      } else if (attempt < 8) {
        window.setTimeout(() => tryFind(attempt + 1), 50)
      }
    }
    requestAnimationFrame(() => tryFind())
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

      <div className="smtcmp-providers-models-container">
        <DndContext
          sensors={providerSensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => void handleProviderDragEnd(event)}
        >
          <SortableContext
            items={providerIds}
            strategy={verticalListSortingStrategy}
          >
            {settings.providers.map((provider) => {
              const isExpanded = expandedProviders.has(provider.id)
              const chatModels = settings.chatModels.filter(
                (m) => m.providerId === provider.id,
              )
              const embeddingModels = settings.embeddingModels.filter(
                (m) => m.providerId === provider.id,
              )

              return (
                <ProviderSectionItem
                  key={provider.id}
                  provider={provider}
                  app={app}
                  plugin={plugin}
                  t={t}
                  isExpanded={isExpanded}
                  toggleProvider={toggleProvider}
                  chatModels={chatModels}
                  embeddingModels={embeddingModels}
                  modelSensors={modelSensors}
                  handleDeleteProvider={handleDeleteProvider}
                  handleDeleteChatModel={handleDeleteChatModel}
                  handleDeleteEmbeddingModel={handleDeleteEmbeddingModel}
                  handleToggleEnableChatModel={handleToggleEnableChatModel}
                  handleChatModelDragEnd={(event) =>
                    void handleChatModelDragEnd(provider.id, event)
                  }
                  handleEmbeddingModelDragEnd={(event) =>
                    void handleEmbeddingModelDragEnd(provider.id, event)
                  }
                />
              )
            })}
          </SortableContext>
        </DndContext>

        <button
          className="smtcmp-add-provider-btn"
          onClick={() => new AddProviderModal(app, plugin).open()}
        >
          {t('settings.providers.addCustomProvider')}
        </button>
      </div>
    </div>
  )
}
