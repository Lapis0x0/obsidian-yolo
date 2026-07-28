import { ArrowRight, CircleAlert } from 'lucide-react'
import { memo } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  LLMResponseFormatErrorPayload,
  parseLLMResponseFormatError,
} from '../../core/llm/responseFormatError'

type Translate = (keyPath: string, fallback?: string) => string

const interpolate = (
  template: string,
  values: Record<string, string>,
): string => {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(value),
    template,
  )
}

const formatResponseFormatProblem = (
  payload: LLMResponseFormatErrorPayload,
  t: Translate,
): string => {
  switch (payload.problem.type) {
    case 'response_not_object':
      return interpolate(
        t(
          'chat.errorCard.responseFormat.responseNotObject',
          'The model service returned a response that is not an object (actual: {{actual}}).',
        ),
        { actual: payload.problem.actualType },
      )
    case 'missing_choices':
      return t(
        'chat.errorCard.responseFormat.missingChoices',
        'The model service returned a response that cannot be parsed: missing choices array.',
      )
    case 'invalid_choices':
      return interpolate(
        t(
          'chat.errorCard.responseFormat.invalidChoices',
          'The model service returned a response that cannot be parsed: choices is not an array (actual: {{actual}}).',
        ),
        { actual: payload.problem.actualType },
      )
  }
}

const formatExpectedField = (expected: string, t: Translate): string => {
  if (expected === 'choices_array') {
    return t(
      'chat.errorCard.responseFormat.expectedChoicesArray',
      'choices array',
    )
  }
  return expected
}

const formatResponseFormatError = (
  errorMessage: string,
  t: Translate,
): string | null => {
  const payload = parseLLMResponseFormatError(errorMessage)
  if (!payload) {
    return null
  }

  const lines = [
    formatResponseFormatProblem(payload, t),
    interpolate(t('chat.errorCard.responseFormat.stage', 'Stage: {{stage}}'), {
      stage: `${payload.adapter} ${payload.stage}`,
    }),
    interpolate(
      t('chat.errorCard.responseFormat.expected', 'Expected field: {{field}}'),
      { field: formatExpectedField(payload.expected, t) },
    ),
  ]

  if (payload.responseKeys && payload.responseKeys.length > 0) {
    lines.push(
      interpolate(
        t(
          'chat.errorCard.responseFormat.responseFields',
          'Response fields: {{fields}}',
        ),
        { fields: payload.responseKeys.join(', ') },
      ),
    )
  }

  if (payload.upstreamError?.message) {
    lines.push(
      interpolate(
        t(
          'chat.errorCard.responseFormat.upstreamError',
          'Upstream error: {{message}}',
        ),
        { message: payload.upstreamError.message },
      ),
    )
  }
  if (payload.upstreamError?.type) {
    lines.push(
      interpolate(
        t('chat.errorCard.responseFormat.errorType', 'Error type: {{type}}'),
        { type: payload.upstreamError.type },
      ),
    )
  }
  if (payload.upstreamError?.code) {
    lines.push(
      interpolate(
        t('chat.errorCard.responseFormat.errorCode', 'Error code: {{code}}'),
        { code: payload.upstreamError.code },
      ),
    )
  }
  if (payload.upstreamMessage) {
    lines.push(
      interpolate(
        t(
          'chat.errorCard.responseFormat.upstreamMessage',
          'Upstream message: {{message}}',
        ),
        { message: payload.upstreamMessage },
      ),
    )
  }
  if (payload.preview) {
    lines.push(
      interpolate(
        t(
          'chat.errorCard.responseFormat.responsePreview',
          'Response preview: {{preview}}',
        ),
        { preview: payload.preview },
      ),
    )
  }

  return lines.join('\n')
}

const formatKnownError = (
  errorMessage: string,
  canContinue: boolean,
  t: Translate,
): string | null => {
  if (/premature close|socket hang up|econnreset/i.test(errorMessage)) {
    return canContinue
      ? t(
          'chat.errorCard.connectionInterruptedContinuable',
          'The connection to the model service was interrupted. Your partial response is still here—click Continue response to resume.',
        )
      : t(
          'chat.errorCard.connectionInterrupted',
          'The connection to the model service was interrupted. Please try again. If this keeps happening, check your network or model service.',
        )
  }

  return null
}

const formatError = (
  errorMessage: string,
  canContinue: boolean,
  t: Translate,
): string =>
  formatResponseFormatError(errorMessage, t) ??
  formatKnownError(errorMessage, canContinue, t) ??
  errorMessage

const AssistantErrorCard = memo(function AssistantErrorCard({
  errorMessage,
  onContinue,
}: {
  errorMessage: string
  onContinue?: () => void
}) {
  const { t } = useLanguage()
  const displayErrorMessage = formatError(errorMessage, Boolean(onContinue), t)

  return (
    <div className="yolo-assistant-error-card" role="alert">
      <div className="yolo-assistant-error-card-header">
        <CircleAlert size={14} />
        <span>{t('chat.errorCard.title', '本次回复生成失败')}</span>
      </div>
      <div className="yolo-assistant-error-card-body">
        {displayErrorMessage}
      </div>
      {onContinue && (
        <button
          type="button"
          className="yolo-assistant-error-card-continue"
          onClick={onContinue}
        >
          <span>{t('chat.continueResponse', 'Continue response')}</span>
          <ArrowRight size={13} />
        </button>
      )}
    </div>
  )
})

export default AssistantErrorCard
