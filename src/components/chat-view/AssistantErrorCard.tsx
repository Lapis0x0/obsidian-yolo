import { ArrowRight, ChevronDown, CircleAlert, Settings } from 'lucide-react'
import { memo, useMemo, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import {
  ProviderErrorCategory,
  classifyProviderError,
} from '../../core/llm/providerErrorClassification'
import {
  LLMResponseFormatErrorPayload,
  parseLLMResponseFormatError,
} from '../../core/llm/responseFormatError'
import type { ChatErrorDetail } from '../../types/chat'
import { openPluginSettingsTab } from '../../utils/openPluginSettingsTab'
import type { SettingsTabId } from '../settings/SettingsTabs'

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

// The classified headline already explains a dropped connection, so the only
// thing left to say here is that the partial response survived — which the
// classification cannot know.
const formatKnownError = (
  errorMessage: string,
  canContinue: boolean,
  t: Translate,
): string | null =>
  canContinue && /premature close|socket hang up|econnreset/i.test(errorMessage)
    ? t(
        'chat.errorCard.connectionInterruptedContinuable',
        'The connection to the model service was interrupted. Your partial response is still here—click Continue response to resume.',
      )
    : null

const formatError = (
  errorMessage: string,
  canContinue: boolean,
  t: Translate,
): string =>
  formatResponseFormatError(errorMessage, t) ??
  formatKnownError(errorMessage, canContinue, t) ??
  errorMessage

const DIAGNOSIS_FALLBACK: Record<
  Exclude<ProviderErrorCategory, 'unknown'>,
  string
> = {
  auth: 'The API key is invalid. Check it and reconfigure the provider.',
  region:
    'The service is unavailable in your region. Configure a proxy or switch to an available provider.',
  model: 'The model does not exist, or you do not have access to it.',
  quota:
    'Your account balance is exhausted. Top up or switch to another provider.',
  rateLimit:
    'Too many requests in a short time. Wait a moment and retry, or switch to a model with a higher rate limit.',
  contextLength:
    'The conversation context is too long. Clear older messages or start a new chat.',
  payload: 'The request is too large. Send fewer files or less text.',
  content:
    'The content was blocked by a safety system. Revise it and try again.',
  mcp: 'The MCP server could not be reached. Check whether it is running.',
  stream:
    'The response stream was interrupted. Check your network stability or retry.',
  network: 'Could not reach the server. Check your network or proxy settings.',
  proxy:
    'Proxy or SSL certificate error. Check your proxy and network settings.',
  server: 'The model service is having problems. Try again later.',
  deprecated:
    'This model has been retired or deprecated. Switch to another model.',
  knowledge: 'Knowledge base vectorization failed.',
  parse:
    'The model returned a malformed response. Retry or switch to another model.',
}

// Categories YOLO can actually route somewhere. `network` and `proxy` are
// deliberately absent: the plugin has no network settings to send the user to.
const CATEGORY_SETTINGS_TAB: Partial<
  Record<ProviderErrorCategory, SettingsTabId>
> = {
  auth: 'models',
  region: 'models',
  model: 'models',
  quota: 'models',
  rateLimit: 'models',
  deprecated: 'models',
  mcp: 'agent',
  knowledge: 'knowledge',
}

const AssistantErrorCard = memo(function AssistantErrorCard({
  errorMessage,
  errorDetail,
  onContinue,
}: {
  errorMessage: string
  errorDetail?: ChatErrorDetail
  onContinue?: () => void
}) {
  const { t } = useLanguage()
  const app = useApp()
  const plugin = usePlugin()
  const [showDetails, setShowDetails] = useState(false)

  const category = useMemo(
    () =>
      classifyProviderError({
        message: errorMessage,
        status: errorDetail?.status,
        responseBody: errorDetail?.responseBody,
      }),
    [errorMessage, errorDetail?.status, errorDetail?.responseBody],
  )
  const settingsTab = CATEGORY_SETTINGS_TAB[category]
  const responseBody = errorDetail?.responseBody
  const displayErrorMessage = formatError(errorMessage, Boolean(onContinue), t)
  const headline =
    category === 'unknown'
      ? t('chat.errorCard.title', '本次回复生成失败')
      : t(`chat.errorCard.diagnosis.${category}`, DIAGNOSIS_FALLBACK[category])

  return (
    <div className="yolo-assistant-error-card" role="alert">
      <div className="yolo-assistant-error-card-header">
        <CircleAlert size={14} />
        <span>{headline}</span>
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
      {(settingsTab || responseBody) && (
        <div className="yolo-assistant-error-card-footer">
          {settingsTab && (
            <button
              type="button"
              className="yolo-assistant-error-card-settings"
              onClick={() => openPluginSettingsTab(app, plugin, settingsTab)}
            >
              <Settings size={13} />
              <span>{t('chat.errorCard.goToSettings', 'Go to settings')}</span>
            </button>
          )}
          {responseBody && (
            <button
              type="button"
              className="yolo-assistant-error-card-details-toggle"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((visible) => !visible)}
            >
              <span>
                {showDetails
                  ? t('chat.errorCard.hideDetails', 'Hide error details')
                  : t('chat.errorCard.viewDetails', 'View error details')}
              </span>
              <ChevronDown size={13} className={showDetails ? 'is-open' : ''} />
            </button>
          )}
        </div>
      )}
      {showDetails && responseBody && (
        <pre className="yolo-assistant-error-card-details">{responseBody}</pre>
      )}
    </div>
  )
})

export default AssistantErrorCard
