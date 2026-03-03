import { ArrowDown, ArrowUp, Clock, Zap } from 'lucide-react'

import { AssistantToolMessageGroup } from '../../types/chat'

import { useLLMResponseInfo } from './useLLMResponseInfo'

const formatTokenCount = (value: number) => {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`
  }
  return value.toString()
}

const formatDuration = (durationMs: number) => {
  const seconds = durationMs / 1000
  return `${seconds.toFixed(1)}s`
}

export default function LLMResponseInlineInfo({
  messages,
}: {
  messages: AssistantToolMessageGroup
}) {
  const { usage, durationMs } = useLLMResponseInfo(messages)

  if (!usage && durationMs === null) {
    return null
  }

  const tokensPerSecond =
    usage && durationMs && durationMs > 0
      ? usage.completion_tokens / (durationMs / 1000)
      : null

  return (
    <div className="smtcmp-llm-inline-info">
      <div className="smtcmp-llm-inline-info-content">
        {usage && (
          <>
            <span className="smtcmp-llm-inline-info-item">
              <ArrowUp className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--input" />
              <span>{formatTokenCount(usage.prompt_tokens)} tokens</span>
            </span>
            <span className="smtcmp-llm-inline-info-item">
              <ArrowDown className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--output" />
              <span>{formatTokenCount(usage.completion_tokens)} tokens</span>
            </span>
          </>
        )}
        {tokensPerSecond !== null && (
          <span className="smtcmp-llm-inline-info-item">
            <Zap className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--speed" />
            <span>{tokensPerSecond.toFixed(1)} tok/s</span>
          </span>
        )}
        {durationMs !== null && (
          <span className="smtcmp-llm-inline-info-item">
            <Clock className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--time" />
            <span>{formatDuration(durationMs)}</span>
          </span>
        )}
      </div>
    </div>
  )
}
