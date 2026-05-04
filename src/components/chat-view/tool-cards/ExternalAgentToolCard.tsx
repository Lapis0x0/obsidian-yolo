// 外部 Agent 工具卡：终端样式
// 布局：状态条 → Progress（始终展开+自动滚底） → Output → metadata chips
//
// 设计要点：
// - Progress 用 <pre> 容器配合每行 <span class> 渲染，给 claude 标签着色
// - 自动滚底：用户手动上滚后停止跟随（接近底部 16px 视为"在底部"）
// - metadata 从 stderr 现场正则解析，失败整块隐藏

import cx from 'clsx'
import {
  Check,
  Clock,
  Coins,
  DollarSign,
  Loader2,
  RefreshCw,
  Square,
  X,
} from 'lucide-react'
import { useMemo } from 'react'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { useExternalCliStream } from '../../../hooks/useExternalCliStream'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type { ToolCallResponse } from '../../../types/tool-call.types'

type ExternalAgentArgs = {
  provider?: string
  model?: string
  workingDirectory?: string
}

type ExternalAgentCardProps = {
  toolCallId: string
  response: ToolCallResponse
  /** 用于在状态条显示 provider · model · cwd 摘要 */
  args?: ExternalAgentArgs
  /** 用于在 running 状态显示终止按钮 */
  onAbort?: () => void
}

type Truncated = { totalBytes: number; omittedBytes: number }

type ProgressMeta = {
  durationMs?: number
  costUsd?: number
  turns?: number
  tokens?: number
}

export function ExternalAgentToolCard({
  toolCallId,
  response,
  args,
  onAbort,
}: ExternalAgentCardProps) {
  const { t } = useLanguage()
  const app = useApp()
  const { settings } = useSettings()
  const stream = useExternalCliStream(toolCallId, { app, settings })

  const isRunning = response.status === ToolCallResponseStatus.Running

  // ── 决定文本来源 ──
  let stderrText: string | undefined
  let stdoutText: string | undefined
  let fallbackText: string | undefined
  let progressTruncated: Truncated | undefined
  if (stream !== null && stream.source === 'live') {
    stderrText = stream.stderr || undefined
    stdoutText = stream.stdout || undefined
  } else if (stream !== null && stream.source === 'historical') {
    stderrText = stream.stderr || undefined
    progressTruncated = stream.truncated
    if (response.status === ToolCallResponseStatus.Success) {
      stdoutText = response.data.text || undefined
    } else if (
      response.status === ToolCallResponseStatus.Aborted &&
      response.data
    ) {
      stdoutText = response.data.text || undefined
    } else if (response.status === ToolCallResponseStatus.Error) {
      // Error 状态下保留错误文本，否则进度缓存会把原本的错误信息盖掉
      fallbackText = response.error
    }
  } else if (response.status === ToolCallResponseStatus.Success) {
    fallbackText = response.data.text
  } else if (
    response.status === ToolCallResponseStatus.Aborted &&
    response.data
  ) {
    fallbackText = response.data.text
  } else if (response.status === ToolCallResponseStatus.Error) {
    fallbackText = response.error
  }

  // ── 从 stderr 解析 metadata（失败则不显示）──
  const meta = useMemo<ProgressMeta>(() => {
    if (!stderrText) return {}
    const out: ProgressMeta = {}

    // claude: [done] duration=15769ms cost=$0.0465 turns=2
    const claudeDone = stderrText.match(
      /\[done\] duration=(\d+)ms cost=\$([\d.]+) turns=(\d+)/,
    )
    if (claudeDone) {
      out.durationMs = parseInt(claudeDone[1], 10)
      out.costUsd = parseFloat(claudeDone[2])
      out.turns = parseInt(claudeDone[3], 10)
    }

    // codex: tokens used\n10,465  (新行格式) 或 tokens used 10,465  (单行)
    const codexTokens = stderrText.match(/tokens used\s*\n?\s*([\d,]+)/)
    if (codexTokens) {
      out.tokens = parseInt(codexTokens[1].replace(/,/g, ''), 10)
    }

    return out
  }, [stderrText])

  const hasMeta =
    meta.durationMs !== undefined ||
    meta.costUsd !== undefined ||
    meta.turns !== undefined ||
    meta.tokens !== undefined

  return (
    <div className="yolo-external-agent-card">
      {/* 状态条 */}
      <div className="yolo-external-agent-card__status-row">
        <StatusBadge status={response.status} t={t} />
        <ArgsInline args={args} />
        {isRunning && onAbort && (
          <button
            type="button"
            className="yolo-external-agent-card__abort-btn"
            onClick={() => void onAbort?.()}
            title={t('chat.toolCall.abort', 'Abort')}
          >
            <Square size={12} />
            <span>{t('chat.toolCall.abort', 'Abort')}</span>
          </button>
        )}
      </div>

      {/* Progress 块 */}
      {stderrText !== undefined && (
        <div className="yolo-external-agent-card__stream-section">
          <div className="yolo-external-agent-card__stream-label">
            {t('chat.externalAgent.progress', 'Progress')}
          </div>
          <ConsoleBlock text={stderrText} variant="progress" />
          {progressTruncated && (
            <div className="yolo-external-agent-card__truncation-notice">
              {t(
                'chat.externalAgent.progressTruncated',
                `Progress truncated: ${progressTruncated.omittedBytes.toLocaleString()} bytes omitted.`,
              )}
            </div>
          )}
        </div>
      )}

      {/* Output 块 */}
      {stdoutText !== undefined && (
        <div className="yolo-external-agent-card__stream-section">
          <div className="yolo-external-agent-card__stream-label">
            {t('chat.externalAgent.output', 'Output')}
          </div>
          <ConsoleBlock text={stdoutText} />
        </div>
      )}

      {/* 历史/错误路径单块输出 */}
      {fallbackText !== undefined && (
        <ConsoleBlock text={fallbackText} />
      )}

      {/* Aborted 无输出文案 */}
      {response.status === ToolCallResponseStatus.Aborted &&
        !response.data &&
        stream === null && (
          <div className="yolo-external-agent-card__no-output">
            {t(
              'chat.externalAgent.abortedBeforeOutput',
              'Aborted before any output was collected.',
            )}
          </div>
        )}

      {/* metadata chips */}
      {hasMeta && <MetaRow meta={meta} />}

      {/* output 截断提示 */}
      <TruncationNotice response={response} t={t} />
    </div>
  )
}

// ──────── 子组件 ────────

function ArgsInline({ args }: { args?: ExternalAgentArgs }) {
  if (!args) return null
  const parts: string[] = []
  if (args.provider) parts.push(args.provider)
  if (args.model) parts.push(args.model)
  if (parts.length === 0 && !args.workingDirectory) return null

  return (
    <div className="yolo-external-agent-card__meta-inline">
      {parts.map((p, i) => (
        <span key={p}>
          {i > 0 && (
            <span className="yolo-external-agent-card__meta-inline-sep">
              {' · '}
            </span>
          )}
          {p}
        </span>
      ))}
      {args.workingDirectory && (
        <>
          {parts.length > 0 && (
            <span className="yolo-external-agent-card__meta-inline-sep">
              {' · '}
            </span>
          )}
          <span
            className="yolo-external-agent-card__cwd"
            title={args.workingDirectory}
          >
            {args.workingDirectory}
          </span>
        </>
      )}
    </div>
  )
}

/**
 * 终端日志块。展示全部高度，超长由外层聊天视图滚动。
 */
function ConsoleBlock({
  text,
  variant,
}: {
  text: string
  variant?: 'progress'
}) {
  // progress 模式按行渲染（给 claude 标签着色）
  if (variant === 'progress') {
    const lines = text.split('\n')
    return (
      <pre
        className={cx(
          'yolo-external-agent-card__console',
          'yolo-external-agent-card__console--progress',
        )}
      >
        {lines.map((line, i) => (
          <span
            key={i}
            className={cx(
              'yolo-external-agent-card__line',
              progressLineClass(line),
            )}
          >
            {line}
          </span>
        ))}
      </pre>
    )
  }

  return <pre className="yolo-external-agent-card__console">{text}</pre>
}

function progressLineClass(line: string): string | undefined {
  // ── claude 标签前缀 ──
  if (line.startsWith('[system]'))
    return 'yolo-external-agent-card__line--system'
  if (line.startsWith('[thinking]'))
    return 'yolo-external-agent-card__line--thinking'
  if (line.startsWith('[tool result]'))
    return 'yolo-external-agent-card__line--tool-result'
  if (line.startsWith('[tool]')) return 'yolo-external-agent-card__line--tool'
  if (line.startsWith('[done]')) return 'yolo-external-agent-card__line--done'
  if (line.startsWith('[parse error]') || line.startsWith('[event]'))
    return 'yolo-external-agent-card__line--parse-error'

  // ── codex 原生格式 ──
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  if (/^-{3,}$/.test(trimmed))
    return 'yolo-external-agent-card__line--system'
  if (
    trimmed === 'user' ||
    trimmed === 'codex' ||
    trimmed === 'exec' ||
    trimmed === 'tokens used'
  )
    return 'yolo-external-agent-card__line--section'
  if (trimmed.startsWith('succeeded in'))
    return 'yolo-external-agent-card__line--tool-result'
  if (/\b(ERROR|WARN|WARNING)\b/.test(line))
    return 'yolo-external-agent-card__line--parse-error'
  // codex 横幅元数据 key: value 行
  if (
    /^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/.test(
      trimmed,
    )
  )
    return 'yolo-external-agent-card__line--system'

  return undefined
}

function MetaRow({ meta }: { meta: ProgressMeta }) {
  return (
    <div className="yolo-external-agent-card__meta-row">
      {meta.durationMs !== undefined && (
        <span className="yolo-external-agent-card__chip">
          <Clock size={12} className="yolo-external-agent-card__chip-icon" />
          {formatDuration(meta.durationMs)}
        </span>
      )}
      {meta.tokens !== undefined && (
        <span className="yolo-external-agent-card__chip">
          <Coins size={12} className="yolo-external-agent-card__chip-icon" />
          {meta.tokens.toLocaleString()}
        </span>
      )}
      {meta.costUsd !== undefined && (
        <span className="yolo-external-agent-card__chip">
          <DollarSign
            size={12}
            className="yolo-external-agent-card__chip-icon"
          />
          {meta.costUsd.toFixed(4)}
        </span>
      )}
      {meta.turns !== undefined && (
        <span className="yolo-external-agent-card__chip">
          <RefreshCw
            size={12}
            className="yolo-external-agent-card__chip-icon"
          />
          {meta.turns}t
        </span>
      )}
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes}m${rest}s`
}

function TruncationNotice({
  response,
  t,
}: {
  response: ToolCallResponse
  t: (key: string, fallback?: string) => string
}) {
  let truncated: Truncated | undefined

  if (
    response.status === ToolCallResponseStatus.Success &&
    response.data.metadata?.truncated
  ) {
    truncated = response.data.metadata.truncated
  } else if (
    response.status === ToolCallResponseStatus.Aborted &&
    response.data?.metadata?.truncated
  ) {
    truncated = response.data.metadata.truncated
  }

  if (!truncated) return null

  return (
    <div className="yolo-external-agent-card__truncation-notice">
      {t(
        'chat.externalAgent.truncated',
        `Output truncated: ${truncated.omittedBytes.toLocaleString()} bytes omitted.`,
      )}
    </div>
  )
}

function StatusBadge({
  status,
  t,
}: {
  status: ToolCallResponseStatus
  t: (key: string, fallback?: string) => string
}) {
  switch (status) {
    case ToolCallResponseStatus.Running:
      return (
        <span
          className={cx(
            'yolo-external-agent-card__badge',
            'yolo-external-agent-card__badge--running',
          )}
        >
          <Loader2 size={12} className="smtcmp-spinner" />
          <span>
            {t('chat.externalAgent.statusRunning', 'Running')}
          </span>
        </span>
      )
    case ToolCallResponseStatus.Success:
      return (
        <span
          className={cx(
            'yolo-external-agent-card__badge',
            'yolo-external-agent-card__badge--success',
          )}
        >
          <Check size={12} />
          <span>{t('chat.externalAgent.statusDone', 'Done')}</span>
        </span>
      )
    case ToolCallResponseStatus.Aborted:
      return (
        <span
          className={cx(
            'yolo-external-agent-card__badge',
            'yolo-external-agent-card__badge--aborted',
          )}
        >
          <X size={12} />
          <span>
            {t('chat.externalAgent.statusAborted', 'Aborted')}
          </span>
        </span>
      )
    case ToolCallResponseStatus.Error:
      return (
        <span
          className={cx(
            'yolo-external-agent-card__badge',
            'yolo-external-agent-card__badge--error',
          )}
        >
          <X size={12} />
          <span>{t('chat.externalAgent.statusError', 'Error')}</span>
        </span>
      )
    default:
      return null
  }
}
