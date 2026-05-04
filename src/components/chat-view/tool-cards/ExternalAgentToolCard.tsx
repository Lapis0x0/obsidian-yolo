// 外部 Agent 工具卡（M1 最简版）
// 纯文本 stdout 展示 + 三种状态徽章 + 终止按钮
// M2 再做：自动滚底、折叠、token 提取

import cx from 'clsx'
import { Check, Loader2, Square, X } from 'lucide-react'

import { useLanguage } from '../../../contexts/language-context'
import { useExternalCliStream } from '../../../hooks/useExternalCliStream'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type { ToolCallResponse } from '../../../types/tool-call.types'

type ExternalAgentCardProps = {
  toolCallId: string
  response: ToolCallResponse
  /** 用于在 running 状态显示终止按钮 */
  onAbort?: () => void
}

export function ExternalAgentToolCard({
  toolCallId,
  response,
  onAbort,
}: ExternalAgentCardProps) {
  const { t } = useLanguage()
  const stream = useExternalCliStream(toolCallId)

  const isRunning = response.status === ToolCallResponseStatus.Running

  // 决定要渲染的文本内容
  // 实时路径下 stderr 是进度日志（codex 的"思考中/调用工具"等输出走 stderr），
  // stdout 是最终结果；历史/落库路径目前只保留了 stdout 文本。
  let stderrText: string | undefined
  let stdoutText: string | undefined
  let fallbackText: string | undefined
  if (stream !== null) {
    stderrText = stream.stderr || undefined
    stdoutText = stream.stdout || undefined
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

  return (
    <div className="yolo-external-agent-card">
      {/* 状态徽章行 */}
      <div className="yolo-external-agent-card__status-row">
        <StatusBadge status={response.status} />
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

      {/* stderr 进度块（实时路径专用） */}
      {stderrText !== undefined && (
        <div className="yolo-external-agent-card__stream-section yolo-external-agent-card__stream-section--stderr">
          <div className="yolo-external-agent-card__stream-label">
            {t('chat.externalAgent.progress', 'Progress (stderr)')}
          </div>
          <pre className="yolo-external-agent-card__console">{stderrText}</pre>
        </div>
      )}

      {/* stdout 最终输出块（实时路径） */}
      {stdoutText !== undefined && (
        <div className="yolo-external-agent-card__stream-section">
          <div className="yolo-external-agent-card__stream-label">
            {t('chat.externalAgent.output', 'Output (stdout)')}
          </div>
          <pre className="yolo-external-agent-card__console">{stdoutText}</pre>
        </div>
      )}

      {/* 历史/错误路径单块输出 */}
      {fallbackText !== undefined && (
        <pre className="yolo-external-agent-card__console">{fallbackText}</pre>
      )}

      {/* Aborted 无输出时的文案 */}
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

      {/* 截断提示 */}
      <TruncationNotice response={response} t={t} />
    </div>
  )
}

function TruncationNotice({
  response,
  t,
}: {
  response: ToolCallResponse
  t: (key: string, fallback?: string) => string
}) {
  let truncated: { totalBytes: number; omittedBytes: number } | undefined

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

function StatusBadge({ status }: { status: ToolCallResponseStatus }) {
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
          <span>Running</span>
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
          <span>Done</span>
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
          <span>Aborted</span>
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
          <span>Error</span>
        </span>
      )
    default:
      return null
  }
}
