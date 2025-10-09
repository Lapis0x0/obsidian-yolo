import {
  ChevronDown,
  ChevronRight,
  Edit,
  GripVertical,
  Settings,
  Trash2,
} from 'lucide-react'
import { App, Notice } from 'obsidian'
import React, { useState } from 'react'

import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_EMBEDDING_MODELS,
  PROVIDER_TYPES_INFO,
} from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { getEmbeddingModelClient } from '../../../core/rag/embedding'
import SmartComposerPlugin from '../../../main'
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

export function ProvidersAndModelsSection({
  app,
  plugin,
}: ProvidersAndModelsSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t, language: _language } = useLanguage()
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(
    new Set(),
  )
  const dragChatModelRef = React.useRef<{
    providerId: string
    index: number
  } | null>(null)
  const dragOverRowRef = React.useRef<HTMLTableRowElement | null>(null)
  const lastDropPosRef = React.useRef<'before' | 'after' | null>(null)
  const lastInsertIndexRef = React.useRef<number | null>(null)

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

  const toggleProvider = (providerId: string) => {
    const newExpanded = new Set(expandedProviders)
    if (newExpanded.has(providerId)) {
      newExpanded.delete(providerId)
    } else {
      newExpanded.add(providerId)
    }
    setExpandedProviders(newExpanded)
  }

  const handleDeleteProvider = async (provider: LLMProvider) => {
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
      associatedEmbeddingModels.some((m) => m.id === settings.embeddingModelId)
    ) {
      newSettings.embeddingModelId =
        otherEmbeddingModels.length > 0 ? otherEmbeddingModels[0].id : ''
    }

    // Clear embeddings for associated embedding models
    const vectorManager = (await plugin.getDbManager()).getVectorManager()
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

    new Notice(`Provider "${provider.id}" deleted successfully`)
  }

  const handleDeleteChatModel = async (modelId: string) => {
    if (modelId === settings.chatModelId || modelId === settings.applyModelId) {
      new Notice(
        'Cannot remove model that is currently selected as Chat Model or Tool Model',
      )
      return
    }

    // Delete immediately without confirmation
    await setSettings({
      ...settings,
      chatModels: settings.chatModels.filter((v) => v.id !== modelId),
    })
  }

  const handleDeleteEmbeddingModel = async (modelId: string) => {
    if (modelId === settings.embeddingModelId) {
      new Notice(
        'Cannot remove model that is currently selected as Embedding Model',
      )
      return
    }

    // Delete immediately without confirmation
    const vectorManager = (await plugin.getDbManager()).getVectorManager()
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
    await setSettings({
      ...settings,
      embeddingModels: settings.embeddingModels.filter((v) => v.id !== modelId),
    })
  }

  const handleToggleEnableChatModel = async (
    modelId: string,
    value: boolean,
  ) => {
    if (
      !value &&
      (modelId === settings.chatModelId || modelId === settings.applyModelId)
    ) {
      new Notice(
        'Cannot disable model that is currently selected as Chat Model or Tool Model',
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
  }

  const handleProviderModelDragStart = (
    event: React.DragEvent<HTMLTableRowElement>,
    providerId: string,
    index: number,
  ) => {
    dragChatModelRef.current = { providerId, index }
    event.dataTransfer?.setData('text/plain', `${providerId}:${index}`)
    event.dataTransfer.effectAllowed = 'move'

    // visual feedback
    const row = event.currentTarget
    row.classList.add('smtcmp-row-dragging')
    const handle = row.querySelector('.smtcmp-drag-handle')
    if (handle) handle.classList.add('smtcmp-drag-handle--active')
  }

  const handleProviderModelDragEnd = () => {
    dragChatModelRef.current = null
    if (dragOverRowRef.current) {
      dragOverRowRef.current.classList.remove(
        'smtcmp-row-drag-over-before',
        'smtcmp-row-drag-over-after',
      )
      dragOverRowRef.current = null
    }
    lastDropPosRef.current = null
    lastInsertIndexRef.current = null
    const dragging = document.querySelector('tr.smtcmp-row-dragging')
    if (dragging) dragging.classList.remove('smtcmp-row-dragging')
    const activeHandle = document.querySelector(
      '.smtcmp-drag-handle.smtcmp-drag-handle--active',
    )
    if (activeHandle)
      activeHandle.classList.remove('smtcmp-drag-handle--active')
  }

  const handleProviderModelDragOver = (
    event: React.DragEvent<HTMLTableRowElement>,
    providerId: string,
    targetIndex: number,
  ) => {
    event.preventDefault()

    // only show indicators when dragging within the same provider group
    if (
      !dragChatModelRef.current ||
      dragChatModelRef.current.providerId !== providerId
    ) {
      return
    }

    const row = event.currentTarget
    const rect = row.getBoundingClientRect()
    const rel = (event.clientY - rect.top) / rect.height

    // If hovering the row being dragged, suppress indicator to avoid flicker
    if (dragChatModelRef.current.index === targetIndex) {
      row.classList.remove(
        'smtcmp-row-drag-over-before',
        'smtcmp-row-drag-over-after',
      )
      if (dragOverRowRef.current && dragOverRowRef.current !== row) {
        dragOverRowRef.current.classList.remove(
          'smtcmp-row-drag-over-before',
          'smtcmp-row-drag-over-after',
        )
      }
      dragOverRowRef.current = row
      lastDropPosRef.current = null
      lastInsertIndexRef.current = null
      return
    }

    // Hysteresis around the midline to prevent rapid toggling
    const HYSTERESIS = 0.05
    let dropAfter: boolean
    if (lastDropPosRef.current) {
      if (rel > 0.5 + HYSTERESIS) dropAfter = true
      else if (rel < 0.5 - HYSTERESIS) dropAfter = false
      else dropAfter = lastDropPosRef.current === 'after'
    } else {
      dropAfter = rel > 0.5
    }

    // Calculate actual insert position to avoid duplicate indicators
    const sourceIndex = dragChatModelRef.current.index
    let insertIndex = targetIndex
    if (dropAfter) insertIndex += 1
    if (sourceIndex < targetIndex) insertIndex -= 1

    // If same insert position as before, don't change anything
    if (lastInsertIndexRef.current === insertIndex) {
      return
    }

    // clear previous indicator
    if (dragOverRowRef.current) {
      dragOverRowRef.current.classList.remove(
        'smtcmp-row-drag-over-before',
        'smtcmp-row-drag-over-after',
      )
    }

    const desiredClass = dropAfter
      ? 'smtcmp-row-drag-over-after'
      : 'smtcmp-row-drag-over-before'
    row.classList.remove(
      'smtcmp-row-drag-over-before',
      'smtcmp-row-drag-over-after',
    )
    row.classList.add(desiredClass)
    dragOverRowRef.current = row
    lastDropPosRef.current = dropAfter ? 'after' : 'before'
    lastInsertIndexRef.current = insertIndex
  }

  const handleProviderModelDrop = async (
    event: React.DragEvent<HTMLTableRowElement>,
    providerId: string,
    targetIndex: number,
  ) => {
    event.preventDefault()
    // capture row early to avoid SyntheticEvent pooling issues
    const rowEl = event.currentTarget as HTMLTableRowElement
    const dragInfo = dragChatModelRef.current
    dragChatModelRef.current = null
    if (!dragInfo || dragInfo.providerId !== providerId) {
      return
    }

    const providerModelIndexes = settings.chatModels.reduce<number[]>(
      (acc, model, idx) => {
        if (model.providerId === providerId) {
          acc.push(idx)
        }
        return acc
      },
      [],
    )

    const sourceGlobalIndex = providerModelIndexes[dragInfo.index]
    const targetGlobalIndex = providerModelIndexes[targetIndex]
    if (sourceGlobalIndex === undefined || targetGlobalIndex === undefined) {
      return
    }

    const updatedChatModels = [...settings.chatModels]
    const [moved] = updatedChatModels.splice(sourceGlobalIndex, 1)
    if (!moved) {
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const dropAfter = event.clientY - rect.top > rect.height / 2

    let insertIndex = targetGlobalIndex + (dropAfter ? 1 : 0)
    if (sourceGlobalIndex < insertIndex) {
      insertIndex -= 1
    }
    if (insertIndex < 0) {
      insertIndex = 0
    }
    if (insertIndex > updatedChatModels.length) {
      insertIndex = updatedChatModels.length
    }

    updatedChatModels.splice(insertIndex, 0, moved)

    await setSettings({
      ...settings,
      chatModels: updatedChatModels,
    })

    // clear visuals
    rowEl?.classList.remove(
      'smtcmp-row-drag-over-before',
      'smtcmp-row-drag-over-after',
    )
    const dragging = document.querySelector('tr.smtcmp-row-dragging')
    if (dragging) dragging.classList.remove('smtcmp-row-dragging')
    const activeHandle = document.querySelector(
      '.smtcmp-drag-handle.smtcmp-drag-handle--active',
    )
    if (activeHandle)
      activeHandle.classList.remove('smtcmp-drag-handle--active')

    dragOverRowRef.current = null
    lastDropPosRef.current = null
    lastInsertIndexRef.current = null

    // success feedback on moved row
    triggerProviderDropSuccess(providerId, moved.id)
  }

  const isEnabled = (enable: boolean | undefined | null) => enable ?? true

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
        {settings.providers.map((provider) => {
          const isExpanded = expandedProviders.has(provider.id)
          const chatModels = settings.chatModels.filter(
            (m) => m.providerId === provider.id,
          )
          const embeddingModels = settings.embeddingModels.filter(
            (m) => m.providerId === provider.id,
          )

          return (
            <div key={provider.id} className="smtcmp-provider-section">
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
                <div className="smtcmp-provider-expand-btn">
                  {isExpanded ? (
                    <ChevronDown size={16} />
                  ) : (
                    <ChevronRight size={16} />
                  )}
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
                  {/* Chat Models Section */}
                  <div className="smtcmp-models-subsection">
                    <div className="smtcmp-models-subsection-header">
                      <span>{t('settings.models.chatModels')}</span>
                      <button
                        className="smtcmp-add-model-btn"
                        onClick={() => {
                          const modal = new AddChatModelModal(
                            app,
                            plugin,
                            provider,
                          )
                          modal.open()
                        }}
                      >
                        + {t('settings.models.addChatModel')}
                      </button>
                    </div>

                    {chatModels.length > 0 ? (
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
                          {chatModels.map((model, index) => (
                            <tr
                              key={model.id}
                              data-model-id={model.id}
                              data-model-key={`${provider.id}:${model.id}`}
                              draggable
                              onDragStart={(event) =>
                                handleProviderModelDragStart(
                                  event,
                                  provider.id,
                                  index,
                                )
                              }
                              onDragOver={(event) =>
                                handleProviderModelDragOver(
                                  event,
                                  provider.id,
                                  index,
                                )
                              }
                              onDrop={(event) =>
                                void handleProviderModelDrop(
                                  event,
                                  provider.id,
                                  index,
                                )
                              }
                              onDragEnd={handleProviderModelDragEnd}
                            >
                              <td>
                                <span
                                  className="smtcmp-drag-handle"
                                  aria-label="Drag to reorder"
                                >
                                  <GripVertical />
                                </span>
                              </td>
                              <td title={model.id}>
                                {model.name || model.model || model.id}
                              </td>
                              <td>{model.model || model.id}</td>
                              <td>
                                <ObsidianToggle
                                  value={isEnabled(model.enable)}
                                  onChange={(value) =>
                                    handleToggleEnableChatModel(model.id, value)
                                  }
                                />
                              </td>
                              <td>
                                <div className="smtcmp-settings-actions">
                                  {/* Always allow editing, even for default models (e.g., Gemini presets) */}
                                  <button
                                    onClick={() =>
                                      new EditChatModelModal(
                                        app,
                                        plugin,
                                        model,
                                      ).open()
                                    }
                                    className="clickable-icon"
                                    title="Edit model"
                                  >
                                    <Edit />
                                  </button>
                                  {/* Keep delete hidden for default models */}
                                  {!DEFAULT_CHAT_MODELS.some(
                                    (v) =>
                                      v.id === model.id &&
                                      v.providerId === model.providerId,
                                  ) && (
                                    <button
                                      onClick={() =>
                                        handleDeleteChatModel(model.id)
                                      }
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
                      </table>
                    ) : (
                      <div className="smtcmp-no-models">
                        {t('settings.models.noChatModelsConfigured')}
                      </div>
                    )}
                  </div>

                  {/* Embedding Models Section */}
                  <div className="smtcmp-models-subsection">
                    <div className="smtcmp-models-subsection-header">
                      <span>{t('settings.models.embeddingModels')}</span>
                      <button
                        className="smtcmp-add-model-btn"
                        onClick={() => {
                          const modal = new AddEmbeddingModelModal(
                            app,
                            plugin,
                            provider,
                          )
                          modal.open()
                        }}
                      >
                        + {t('settings.models.addEmbeddingModel')}
                      </button>
                    </div>

                    {embeddingModels.length > 0 ? (
                      <table className="smtcmp-models-table smtcmp-embedding-models-table">
                        <colgroup>
                          <col />
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
                            <th>Dimension</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {embeddingModels.map((model) => (
                            <tr key={model.id}>
                              <td></td>
                              <td title={model.id}>{model.id}</td>
                              <td title={model.model}>{model.model}</td>
                              <td>{model.dimension}</td>
                              <td>
                                <div className="smtcmp-settings-actions">
                                  {!DEFAULT_EMBEDDING_MODELS.some(
                                    (v) =>
                                      v.id === model.id &&
                                      v.providerId === model.providerId,
                                  ) && (
                                    <>
                                      <button
                                        onClick={() =>
                                          new EditEmbeddingModelModal(
                                            app,
                                            plugin,
                                            model,
                                          ).open()
                                        }
                                        className="clickable-icon"
                                        title="Edit model"
                                      >
                                        <Edit />
                                      </button>
                                      <button
                                        onClick={() =>
                                          handleDeleteEmbeddingModel(model.id)
                                        }
                                        className="clickable-icon"
                                      >
                                        <Trash2 />
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="smtcmp-no-models">
                        {t('settings.models.noEmbeddingModelsConfigured')}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}

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
