import { Check, Plus, Search, Star, X } from 'lucide-react'
import { App } from 'obsidian'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  getRegisteredChatModels,
  resolveSubagentModelConfig,
} from '../../../core/agent/subagent/model-config'
import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { ChatModel } from '../../../types/chat-model.types'
import { ReactModal } from '../../common/ReactModal'

type SubagentModelPoolValue = {
  allowedModelIds?: string[]
  preferredModelId?: string
}

type SubagentConfigModalProps = {
  app: App
  settings: YoloSettings
  value: SubagentModelPoolValue
  onChange: (next: SubagentModelPoolValue) => void
}

export class SubagentConfigModal extends ReactModal<SubagentConfigModalProps> {
  constructor(
    app: App,
    options: {
      title: string
      settings: YoloSettings
      value: SubagentModelPoolValue
      onChange: (next: SubagentModelPoolValue) => void
    },
  ) {
    super({
      app,
      Component: SubagentConfigModalContent,
      props: {
        app,
        settings: options.settings,
        value: options.value,
        onChange: options.onChange,
      },
      options: {
        title: options.title,
        className: 'yolo-subagent-config-modal',
      },
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function SubagentConfigModalContent({
  settings,
  value,
  onChange,
}: SubagentConfigModalProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const registeredModels = useMemo(
    () => getRegisteredChatModels(settings),
    [settings],
  )
  const modelById = useMemo(
    () => new Map(registeredModels.map((model) => [model.id, model])),
    [registeredModels],
  )
  const resolved = useMemo(
    () =>
      resolveSubagentModelConfig({
        ...settings,
        mcp: {
          ...settings.mcp,
          builtinToolOptions: {
            ...settings.mcp.builtinToolOptions,
            delegate_subagent: {
              ...settings.mcp.builtinToolOptions.delegate_subagent,
              ...value,
            },
          },
        },
      }),
    [settings, value],
  )
  const [pool, setPool] = useState<string[]>(resolved.allowedModelIds)
  const [preferredModelId, setPreferredModelId] = useState<string>(
    resolved.preferredModelId,
  )
  const [isAdding, setIsAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [batchSelected, setBatchSelected] = useState<Set<string>>(
    () => new Set(),
  )

  const poolSet = useMemo(() => new Set(pool), [pool])
  const poolModels = useMemo(
    () =>
      pool
        .map((modelId) => modelById.get(modelId))
        .filter((model): model is ChatModel => Boolean(model)),
    [modelById, pool],
  )
  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return registeredModels
    return registeredModels.filter((model) =>
      modelMatchesQuery(model, normalizedQuery),
    )
  }, [query, registeredModels])
  const providerOrder = useMemo(
    () => settings.providers.map((provider) => provider.id),
    [settings.providers],
  )
  const filteredModelGroups = useMemo(
    () => groupModelsByProvider(filteredModels, providerOrder),
    [filteredModels, providerOrder],
  )
  const poolModelGroups = useMemo(
    () => groupModelsByProvider(poolModels, providerOrder),
    [poolModels, providerOrder],
  )
  const addableFilteredIds = filteredModels
    .filter((model) => !poolSet.has(model.id))
    .map((model) => model.id)
  const allAddableFilteredSelected =
    addableFilteredIds.length > 0 &&
    addableFilteredIds.every((modelId) => batchSelected.has(modelId))

  const commit = (nextPool: string[], requestedPreferred: string) => {
    const normalizedPool = registeredModels
      .map((model) => model.id)
      .filter((modelId) => nextPool.includes(modelId))
    const nextPreferred =
      requestedPreferred && normalizedPool.includes(requestedPreferred)
        ? requestedPreferred
        : (normalizedPool[0] ?? '')

    setPool(normalizedPool)
    setPreferredModelId(nextPreferred)
    onChange({
      allowedModelIds: normalizedPool,
      preferredModelId: nextPreferred,
    })
  }

  const openAddModels = () => {
    setBatchSelected(new Set())
    setQuery('')
    setIsAdding(true)
  }

  const toggleBatchModel = (modelId: string) => {
    if (poolSet.has(modelId)) return
    setBatchSelected((prev) => {
      const next = new Set(prev)
      if (next.has(modelId)) {
        next.delete(modelId)
      } else {
        next.add(modelId)
      }
      return next
    })
  }

  const toggleAllAddableFiltered = () => {
    setBatchSelected((prev) => {
      const next = new Set(prev)
      if (allAddableFilteredSelected) {
        for (const modelId of addableFilteredIds) {
          next.delete(modelId)
        }
      } else {
        for (const modelId of addableFilteredIds) {
          next.add(modelId)
        }
      }
      return next
    })
  }

  const addSelectedModels = () => {
    const selectedIds = registeredModels
      .map((model) => model.id)
      .filter((modelId) => batchSelected.has(modelId) && !poolSet.has(modelId))
    if (selectedIds.length === 0) return
    const nextPool = [...pool, ...selectedIds]
    commit(nextPool, preferredModelId || selectedIds[0])
    setBatchSelected(new Set())
    setIsAdding(false)
  }

  if (isAdding) {
    return (
      <div className="yolo-subagent-config yolo-subagent-config--adding">
        <section className="yolo-terminal-command-section yolo-subagent-add-section">
          <div className="yolo-terminal-command-section-head">
            <div>
              <h3>
                {t('settings.subagent.addModelsTitle', 'Add subagent models')}
              </h3>
              <p>
                {t(
                  'settings.subagent.addModelsDesc',
                  'Select registered chat models to add to the subagent model pool.',
                )}
              </p>
            </div>
          </div>

          <div className="yolo-subagent-model-search-wrap">
            <Search size={16} />
            <input
              className="yolo-batch-add-search yolo-subagent-model-search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t(
                'settings.subagent.searchModels',
                'Search models...',
              )}
            />
          </div>

          <div className="yolo-batch-add-toolbar">
            <button
              type="button"
              className="yolo-batch-add-selectall"
              disabled={addableFilteredIds.length === 0}
              onClick={toggleAllAddableFiltered}
            >
              <span
                className={`yolo-batch-add-check${
                  allAddableFilteredSelected ? ' is-checked' : ''
                }`}
              >
                {allAddableFilteredSelected ? <Check size={12} /> : null}
              </span>
              {t('settings.models.batchSelectAll', 'Select all')}
            </button>
            <span className="yolo-batch-add-count">
              {t('settings.models.batchSelected', 'Selected')}{' '}
              {batchSelected.size} / {registeredModels.length}
            </span>
          </div>

          <div className="yolo-batch-add-list yolo-subagent-model-list">
            {filteredModels.length === 0 ? (
              <div className="yolo-batch-add-empty">
                {t('common.noResults', 'No results')}
              </div>
            ) : (
              filteredModelGroups.map((group) => (
                <div
                  key={group.providerId}
                  className="yolo-subagent-provider-group"
                >
                  <div className="yolo-subagent-provider-heading">
                    {group.providerId}
                  </div>
                  {group.models.map((model) => {
                    const alreadyAdded = poolSet.has(model.id)
                    const checked = batchSelected.has(model.id)
                    return (
                      <div
                        key={model.id}
                        className={`yolo-batch-add-row yolo-subagent-model-row${
                          alreadyAdded ? ' is-added' : ''
                        }${checked ? ' is-checked' : ''}`}
                        role={alreadyAdded ? undefined : 'button'}
                        tabIndex={alreadyAdded ? undefined : 0}
                        onClick={
                          alreadyAdded
                            ? undefined
                            : () => toggleBatchModel(model.id)
                        }
                        onKeyDown={
                          alreadyAdded
                            ? undefined
                            : (event) => {
                                if (
                                  event.key === 'Enter' ||
                                  event.key === ' '
                                ) {
                                  event.preventDefault()
                                  toggleBatchModel(model.id)
                                }
                              }
                        }
                      >
                        <span
                          className={`yolo-batch-add-check${
                            checked ? ' is-checked' : ''
                          }`}
                        >
                          {checked ? <Check size={12} /> : null}
                        </span>
                        <span className="yolo-subagent-model-row-text">
                          <span>{getModelLabel(model)}</span>
                          <span>{model.model || model.id}</span>
                        </span>
                        {alreadyAdded ? (
                          <span className="yolo-batch-add-added">
                            {t('settings.models.batchAlreadyAdded', 'Added')}
                          </span>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>

          <div className="yolo-subagent-modal-actions">
            <button
              type="button"
              className="mod-cta"
              disabled={batchSelected.size === 0}
              onClick={addSelectedModels}
            >
              {`${t('settings.subagent.addSelectedModels', 'Add selected models')}${
                batchSelected.size > 0 ? ` (${batchSelected.size})` : ''
              }`}
            </button>
            <button type="button" onClick={() => setIsAdding(false)}>
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="yolo-subagent-config yolo-subagent-config--pool">
      <section className="yolo-terminal-command-section yolo-subagent-pool-section">
        <div className="yolo-terminal-command-section-head">
          <div>
            <h3>{t('settings.subagent.modelPool', 'Subagent model pool')}</h3>
          </div>
        </div>

        <div className="yolo-subagent-intro">
          {`${t(
            'settings.subagent.modelPoolDesc',
            'The parent agent can dispatch subagents only with models in this pool.',
          )} ${t(
            'settings.subagent.preferredModelRule',
            'If the parent agent does not pass modelId explicitly, the preferred model is used.',
          )}`}
        </div>

        <div className="yolo-subagent-pool-toolbar">
          <span className="yolo-batch-add-count">
            {t('settings.subagent.poolCount', '{count} models').replace(
              '{count}',
              String(poolModels.length),
            )}
          </span>
          <button type="button" className="mod-cta" onClick={openAddModels}>
            <Plus size={15} />
            {t('settings.subagent.addModel', 'Add model')}
          </button>
        </div>

        <div className="yolo-subagent-pool-list">
          {poolModels.length === 0 ? (
            <div className="yolo-batch-add-empty">
              {t(
                'settings.subagent.emptyModelPool',
                'No subagent models selected.',
              )}
            </div>
          ) : (
            poolModelGroups.map((group) => (
              <div
                key={group.providerId}
                className="yolo-subagent-provider-group"
              >
                <div className="yolo-subagent-provider-heading">
                  {group.providerId}
                </div>
                {group.models.map((model) => {
                  const isPreferred = preferredModelId === model.id
                  return (
                    <div key={model.id} className="yolo-subagent-pool-row">
                      <span className="yolo-subagent-model-row-text">
                        <span>{getModelLabel(model)}</span>
                        <span>{model.model || model.id}</span>
                      </span>
                      <button
                        type="button"
                        className={
                          isPreferred
                            ? 'clickable-icon yolo-subagent-default-btn is-active'
                            : 'clickable-icon yolo-subagent-default-btn'
                        }
                        aria-label={t(
                          'settings.subagent.setPreferredModel',
                          'Set as preferred model',
                        )}
                        onClick={() => commit(pool, model.id)}
                      >
                        <Star size={15} />
                        <span>
                          {isPreferred
                            ? t('settings.subagent.defaultModel', 'Default')
                            : t(
                                'settings.subagent.setDefaultModel',
                                'Set default',
                              )}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="clickable-icon"
                        aria-label={t('common.remove', 'Remove')}
                        onClick={() =>
                          commit(
                            pool.filter((modelId) => modelId !== model.id),
                            preferredModelId === model.id
                              ? ''
                              : preferredModelId,
                          )
                        }
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

function modelMatchesQuery(model: ChatModel, normalizedQuery: string): boolean {
  return (
    model.id.toLowerCase().includes(normalizedQuery) ||
    model.model.toLowerCase().includes(normalizedQuery) ||
    (model.name?.toLowerCase().includes(normalizedQuery) ?? false) ||
    model.providerId.toLowerCase().includes(normalizedQuery)
  )
}

function getModelLabel(model: ChatModel): string {
  return model.name?.trim() || model.model || model.id
}

function groupModelsByProvider(
  models: ChatModel[],
  providerOrder: string[],
): { providerId: string; models: ChatModel[] }[] {
  const modelsByProvider = new Map<string, ChatModel[]>()
  for (const model of models) {
    const group = modelsByProvider.get(model.providerId) ?? []
    group.push(model)
    modelsByProvider.set(model.providerId, group)
  }

  const providerIds = Array.from(modelsByProvider.keys())
  const orderedProviderIds = [
    ...providerOrder.filter((providerId) => modelsByProvider.has(providerId)),
    ...providerIds.filter((providerId) => !providerOrder.includes(providerId)),
  ]

  return orderedProviderIds.map((providerId) => ({
    providerId,
    models: modelsByProvider.get(providerId) ?? [],
  }))
}
