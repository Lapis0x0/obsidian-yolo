import {
  Activity,
  Check,
  Clock,
  Loader2,
  RefreshCcw,
  Square,
  X,
} from 'lucide-react'
import { App } from 'obsidian'
import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
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
      Component: ConnectivityTestPanel,
      props: { plugin, provider },
      plugin,
      options: { className: 'yolo-connectivity-modal' },
    })
  }
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
    return (
      <span className="yolo-health-metric yolo-health-metric--error">
        {cell.code != null ? `${cell.code} · ` : ''}
        {cell.message}
      </span>
    )
  }
  if (cell.status === 'timeout') {
    return (
      <span className="yolo-health-metric yolo-health-metric--warn">
        {t('settings.models.connectivityTest.noResponse', '无响应')} ·{' '}
        {(cell.totalMs / 1000).toFixed(0)}s{' '}
        {t('settings.models.connectivityTest.statusTimeout', '超时')}
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
}: {
  model: ChatModel | EmbeddingModel
  kind: 'chat' | 'embedding'
  cell: CellState
  disabled: boolean
  onTest: (id: string) => void
}) {
  const { t } = useLanguage()
  const status: StatusKind = cell?.status ?? 'idle'
  const testing = status === 'testing'
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
  )
}

function ConnectivityTestPanel({
  plugin,
  provider,
}: ConnectivityTestModalProps & { onClose: () => void }) {
  const { t } = useLanguage()

  // `plugin.settings` is the live in-memory config; read it at render so the
  // model list reflects the current provider configuration.
  const chatModels = useMemo(
    () =>
      plugin.settings.chatModels.filter((m) => m.providerId === provider.id),
    [plugin.settings.chatModels, provider.id],
  )
  const embeddingModels = useMemo(
    () =>
      plugin.settings.embeddingModels.filter(
        (m) => m.providerId === provider.id,
      ),
    [plugin.settings.embeddingModels, provider.id],
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

        {chatModels.length > 0 ? (
          <>
            <div className="yolo-health-grouplabel">
              {t('settings.models.chatModels', '聊天模型')}
              <span className="yolo-health-grouplabel-ct">
                {chatModels.length}
              </span>
            </div>
            {chatModels.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                kind="chat"
                cell={results[model.id] ?? { status: 'idle' }}
                disabled={running}
                onTest={testOne}
              />
            ))}
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
            {embeddingModels.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                kind="embedding"
                cell={results[model.id] ?? { status: 'idle' }}
                disabled={running}
                onTest={testOne}
              />
            ))}
          </>
        ) : null}
      </div>
    </div>
  )
}
