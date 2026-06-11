import * as Tooltip from '@radix-ui/react-tooltip'
import {
  Activity,
  Check,
  Clock,
  Loader2,
  RefreshCcw,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { App, Notice } from 'obsidian'
import { useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import { getEmbeddingModelClient } from '../../../core/rag/embedding'
import {
  CellState,
  ConnectivityCounts,
  useConnectivityTest,
} from '../../../hooks/useConnectivityTest'
import YoloPlugin from '../../../main'
import { ChatModel } from '../../../types/chat-model.types'
import { EmbeddingModel } from '../../../types/embedding-model.types'
import { LLMProvider } from '../../../types/provider.types'
import { resolveProviderDisplayBaseUrl } from '../../../utils/llm/provider-base-url'
import { ReactModal } from '../../common/ReactModal'

type ConnectivityTestModalProps = {
  plugin: YoloPlugin
  provider: LLMProvider
}

export class ConnectivityTestModal extends ReactModal<ConnectivityTestModalProps> {
  constructor(app: App, plugin: YoloPlugin, provider: LLMProvider) {
    super({
      app,
      Component: ConnectivityTestPanelWrapper,
      props: { plugin, provider },
      plugin,
      options: { className: 'yolo-connectivity-modal' },
    })
  }
}

function ConnectivityTestPanelWrapper(
  props: ConnectivityTestModalProps & { onClose: () => void },
) {
  const { plugin } = props
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <ConnectivityTestPanel {...props} />
    </SettingsProvider>
  )
}

type StatusKind = 'ok' | 'fail' | 'timeout' | 'testing' | 'idle'

function StatusChip({ status }: { status: StatusKind }) {
  const { t } = useLanguage()
  if (status === 'testing') {
    return (
      <span className="yolo-health-chip yolo-health-chip--testing">
        <Loader2 size={11} className="yolo-health-spin" />
        {t('settings.models.connectivityTest.statusTesting', '检测中')}
      </span>
    )
  }
  const label =
    status === 'ok'
      ? t('settings.models.connectivityTest.statusOk', '正常')
      : status === 'fail'
        ? t('settings.models.connectivityTest.statusFail', '失败')
        : status === 'timeout'
          ? t('settings.models.connectivityTest.statusTimeout', '超时')
          : t('settings.models.connectivityTest.statusIdle', '待测')
  const icon =
    status === 'ok' ? (
      <Check size={11} />
    ) : status === 'fail' ? (
      <X size={11} />
    ) : status === 'timeout' ? (
      <Clock size={11} />
    ) : (
      <span className="yolo-health-dot" />
    )
  return (
    <span className={`yolo-health-chip yolo-health-chip--${status}`}>
      {icon}
      {label}
    </span>
  )
}

function MetricDetailTooltip({
  detail,
  className,
}: {
  detail: string
  className: string
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className={className}>{detail}</span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="yolo-tooltip-content yolo-health-metric-tooltip"
          side="top"
          sideOffset={6}
          align="center"
        >
          {detail}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

function MetricInline({
  cell,
  kind,
}: {
  cell: CellState
  kind: 'chat' | 'embedding'
}) {
  const { t } = useLanguage()
  // While testing, the status chip ("检测中") + button spinner already convey
  // progress, so the metric column stays empty to avoid a redundant label.
  if (!cell || cell.status === 'idle' || cell.status === 'testing') {
    return (
      <span className="yolo-health-metric yolo-health-metric--muted">—</span>
    )
  }
  if (cell.status === 'fail') {
    const detail =
      cell.code != null ? `${cell.code} · ${cell.message}` : cell.message
    return (
      <MetricDetailTooltip
        detail={detail}
        className="yolo-health-metric yolo-health-metric--error"
      />
    )
  }
  if (cell.status === 'timeout') {
    const detail = `${t('settings.models.connectivityTest.noResponse', '无响应')} · ${(cell.totalMs / 1000).toFixed(0)}s ${t('settings.models.connectivityTest.statusTimeout', '超时')}`
    return (
      <span className="yolo-health-metric yolo-health-metric--warn">
        {detail}
      </span>
    )
  }
  // status === 'ok'
  if (kind === 'embedding' && cell.dimension != null) {
    return (
      <span className="yolo-health-metric">
        <b>{Math.round(cell.latencyMs ?? cell.totalMs)}ms</b> · {cell.dimension}{' '}
        {t('settings.models.connectivityTest.dims', '维')}
      </span>
    )
  }
  if (cell.firstTokenMs != null) {
    return (
      <span className="yolo-health-metric">
        {t('settings.models.connectivityTest.firstToken', '首字')}{' '}
        <b>{(cell.firstTokenMs / 1000).toFixed(2)}s</b>
      </span>
    )
  }
  return (
    <span className="yolo-health-metric">
      <b>{(cell.totalMs / 1000).toFixed(2)}s</b>
    </span>
  )
}

function SegBar({
  counts,
  total,
}: {
  counts: ConnectivityCounts
  total: number
}) {
  if (total === 0) return <div className="yolo-health-segbar" />
  const pct = (n: number) => `${(n / total) * 100}%`
  return (
    <div className="yolo-health-segbar">
      <div
        className="yolo-health-segbar-seg yolo-health-segbar-seg--ok"
        style={{ width: pct(counts.ok) }}
      />
      <div
        className="yolo-health-segbar-seg yolo-health-segbar-seg--timeout"
        style={{ width: pct(counts.timeout) }}
      />
      <div
        className="yolo-health-segbar-seg yolo-health-segbar-seg--fail"
        style={{ width: pct(counts.fail) }}
      />
      {counts.testing > 0 ? (
        <div
          className="yolo-health-segbar-seg yolo-health-segbar-seg--run"
          style={{ width: pct(counts.testing) }}
        />
      ) : null}
    </div>
  )
}

function ModelRow({
  model,
  kind,
  cell,
  disabled,
  onTest,
  onDelete,
  deleteDisabled,
  deleteDisabledReason,
}: {
  model: ChatModel | EmbeddingModel
  kind: 'chat' | 'embedding'
  cell: CellState
  disabled: boolean
  onTest: (id: string) => void
  onDelete: (id: string) => void
  deleteDisabled: boolean
  deleteDisabledReason?: string
}) {
  const { t } = useLanguage()
  const status: StatusKind = cell?.status ?? 'idle'
  const testing = status === 'testing'
  const abnormal = status === 'fail' || status === 'timeout'
  const deleteLabel = t(
    'settings.models.connectivityTest.deleteModel',
    '删除模型',
  )
  return (
    <div className="yolo-health-row">
      <div className="yolo-health-row-name">
        <div className="yolo-health-row-display">
          {model.name || model.model}
        </div>
        <div className="yolo-health-row-id">{model.model}</div>
      </div>
      <div className="yolo-health-row-metric">
        <MetricInline cell={cell} kind={kind} />
      </div>
      <StatusChip status={status} />
      <div className="yolo-health-row-actions">
        {abnormal ? (
          <button
            type="button"
            className="yolo-health-row-delete clickable-icon"
            disabled={testing || disabled || deleteDisabled}
            title={deleteDisabled ? deleteDisabledReason : deleteLabel}
            aria-label={deleteLabel}
            onClick={() => onDelete(model.id)}
          >
            <Trash2 size={14} />
          </button>
        ) : null}
        <button
          type="button"
          className="yolo-health-row-test"
          disabled={testing || disabled}
          onClick={() => onTest(model.id)}
        >
          {testing ? (
            <Loader2 size={12} className="yolo-health-spin" />
          ) : (
            t('settings.models.connectivityTest.test', '测试')
          )}
        </button>
      </div>
    </div>
  )
}

function ConnectivityTestPanel({
  provider,
}: ConnectivityTestModalProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { chatModelId, chatTitleModelId, embeddingModelId } = settings
  const [deletingEmbeddingModelIds, setDeletingEmbeddingModelIds] = useState(
    () => new Set<string>(),
  )

  const handleDeleteChatModel = useCallback(
    (modelId: string) => {
      if (
        modelId === settings.chatModelId ||
        modelId === settings.chatTitleModelId
      ) {
        new Notice(
          'Cannot remove model that is currently selected as chat model or conversation title model',
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
          console.error('[YOLO] Failed to delete chat model:', error)
          new Notice('Failed to delete chat model.')
        }
      })()
    },
    [settings, setSettings],
  )

  const handleDeleteEmbeddingModel = useCallback(
    (modelId: string) => {
      if (modelId === settings.embeddingModelId) {
        new Notice(
          'Cannot remove model that is currently selected as embedding model',
        )
        return
      }

      if (deletingEmbeddingModelIds.has(modelId)) {
        return
      }

      void (async () => {
        setDeletingEmbeddingModelIds((prev) => new Set(prev).add(modelId))
        try {
          const vectorManager = await plugin.tryGetVectorManager()
          if (vectorManager) {
            const embeddingModelClient = getEmbeddingModelClient({
              settings,
              embeddingModelId: modelId,
            })
            await vectorManager.clearAllVectors(embeddingModelClient)
          } else {
            console.warn(
              '[YOLO] Skip clearing embeddings because vector manager is unavailable.',
            )
          }
          await setSettings({
            ...settings,
            embeddingModels: settings.embeddingModels.filter(
              (v) => v.id !== modelId,
            ),
          })
        } catch (error) {
          console.error('[YOLO] Failed to delete embedding model:', error)
          new Notice('Failed to delete embedding model.')
        } finally {
          setDeletingEmbeddingModelIds((prev) => {
            const next = new Set(prev)
            next.delete(modelId)
            return next
          })
        }
      })()
    },
    [deletingEmbeddingModelIds, plugin, settings, setSettings],
  )

  const getChatDeleteState = (modelId: string) => {
    if (modelId === chatModelId || modelId === chatTitleModelId) {
      return {
        disabled: true,
        reason: t(
          'settings.models.connectivityTest.deleteChatModelBlocked',
          '无法删除当前选中的聊天或标题模型',
        ),
      }
    }
    return { disabled: false }
  }

  const getEmbeddingDeleteState = (modelId: string) => {
    if (modelId === embeddingModelId) {
      return {
        disabled: true,
        reason: t(
          'settings.models.connectivityTest.deleteEmbeddingModelBlocked',
          '无法删除当前选中的嵌入模型',
        ),
      }
    }
    if (deletingEmbeddingModelIds.has(modelId)) {
      return {
        disabled: true,
        reason: t(
          'settings.models.connectivityTest.deleteEmbeddingModelInProgress',
          '正在删除嵌入模型…',
        ),
      }
    }
    return { disabled: false }
  }

  const chatModels = useMemo(
    () => settings.chatModels.filter((m) => m.providerId === provider.id),
    [settings.chatModels, provider.id],
  )
  const embeddingModels = useMemo(
    () => settings.embeddingModels.filter((m) => m.providerId === provider.id),
    [settings.embeddingModels, provider.id],
  )

  const { results, testOne, testAll, stop, counts, done, total, phase } =
    useConnectivityTest({ chatModels, embeddingModels })

  const baseUrl = resolveProviderDisplayBaseUrl(provider)
  const running = phase === 'running'

  const summaryLabel =
    phase === 'idle'
      ? t('settings.models.connectivityTest.notTested', '尚未检测')
      : phase === 'running'
        ? `${t('settings.models.connectivityTest.statusTesting', '检测中')} · ${done}/${total}`
        : `${counts.ok} ${t('settings.models.connectivityTest.normalCount', '个正常')}，${
            counts.fail + counts.timeout
          } ${t('settings.models.connectivityTest.abnormalCount', '个异常')}`

  return (
    <div className="yolo-connectivity-panel">
      <div className="yolo-connectivity-header">
        <span className="yolo-connectivity-header-icon">
          <Activity size={16} />
        </span>
        <div className="yolo-connectivity-header-text">
          <h3>{t('settings.models.connectivityTest.title', '连通性测试')}</h3>
          <p className="yolo-connectivity-header-sub">
            {provider.id}
            {baseUrl ? ` · ${baseUrl}` : ''}
          </p>
        </div>
      </div>

      <div className="yolo-connectivity-body">
        <div className="yolo-connectivity-summary">
          <div className="yolo-connectivity-summary-top">
            <div className="yolo-connectivity-pass">
              <div className="yolo-connectivity-pass-num">
                {done ? counts.ok : '—'}
                <span>/{total}</span>
              </div>
              <div className="yolo-connectivity-pass-label">
                {t('settings.models.connectivityTest.passed', '通过')}
              </div>
            </div>
            <div className="yolo-connectivity-summary-mid">
              <div className="yolo-connectivity-summary-text">
                {summaryLabel}
              </div>
              <SegBar counts={counts} total={total} />
            </div>
            <div className="yolo-connectivity-summary-actions">
              {running ? (
                <button
                  type="button"
                  className="yolo-connectivity-btn yolo-connectivity-btn--stop"
                  onClick={() => stop()}
                >
                  <Square size={13} />
                  {t('settings.models.connectivityTest.stop', '停止')}
                </button>
              ) : (
                <button
                  type="button"
                  className="yolo-connectivity-btn yolo-connectivity-btn--primary"
                  disabled={total === 0}
                  onClick={() => testAll()}
                >
                  {phase === 'done' ? (
                    <>
                      <RefreshCcw size={13} />
                      {t('settings.models.connectivityTest.retest', '重新测试')}
                    </>
                  ) : (
                    <>
                      <Activity size={13} />
                      {t(
                        'settings.models.connectivityTest.testAll',
                        '测试全部',
                      )}
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>

        {total === 0 ? (
          <div className="yolo-connectivity-empty">
            {t(
              'settings.models.connectivityTest.noModels',
              '该提供商下暂无已配置的模型',
            )}
          </div>
        ) : null}

        <Tooltip.Provider delayDuration={200}>
          {chatModels.length > 0 ? (
            <>
              <div className="yolo-health-grouplabel">
                {t('settings.models.chatModels', '聊天模型')}
                <span className="yolo-health-grouplabel-ct">
                  {chatModels.length}
                </span>
              </div>
              {chatModels.map((model) => {
                const deleteState = getChatDeleteState(model.id)
                return (
                  <ModelRow
                    key={model.id}
                    model={model}
                    kind="chat"
                    cell={results[model.id] ?? { status: 'idle' }}
                    disabled={running}
                    onTest={testOne}
                    onDelete={handleDeleteChatModel}
                    deleteDisabled={deleteState.disabled}
                    deleteDisabledReason={deleteState.reason}
                  />
                )
              })}
            </>
          ) : null}

          {embeddingModels.length > 0 ? (
            <>
              <div className="yolo-health-grouplabel">
                {t('settings.models.embeddingModels', '嵌入模型')}
                <span className="yolo-health-grouplabel-ct">
                  {embeddingModels.length}
                </span>
              </div>
              {embeddingModels.map((model) => {
                const deleteState = getEmbeddingDeleteState(model.id)
                return (
                  <ModelRow
                    key={model.id}
                    model={model}
                    kind="embedding"
                    cell={results[model.id] ?? { status: 'idle' }}
                    disabled={running}
                    onTest={testOne}
                    onDelete={handleDeleteEmbeddingModel}
                    deleteDisabled={deleteState.disabled}
                    deleteDisabledReason={deleteState.reason}
                  />
                )
              })}
            </>
          ) : null}
        </Tooltip.Provider>
      </div>
    </div>
  )
}
