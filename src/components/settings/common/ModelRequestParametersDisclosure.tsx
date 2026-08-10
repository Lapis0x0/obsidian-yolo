import { ChevronDown } from 'lucide-react'
import { ReactNode } from 'react'

import { useLanguage } from '../../../contexts/language-context'

type ModelRequestParametersDisclosureProps = {
  children: ReactNode
  enabledCount: number
  onClear: () => void
}

export function ModelRequestParametersDisclosure({
  children,
  enabledCount,
  onClear,
}: ModelRequestParametersDisclosureProps) {
  const { t } = useLanguage()

  return (
    <details className="yolo-agent-model-request-parameters">
      <summary className="yolo-agent-model-request-parameters-summary">
        <div className="yolo-agent-model-request-parameters-meta">
          <div className="yolo-agent-model-request-parameters-title-row">
            <span>{t('settings.models.requestParameters')}</span>
            <span
              className="yolo-agent-model-request-parameters-count"
              aria-label={t(
                'settings.models.requestParametersEnabledCount',
                '{count} request parameters enabled',
              ).replace('{count}', String(enabledCount))}
            >
              {enabledCount}
            </span>
          </div>
          <div className="yolo-agent-model-request-parameters-desc">
            {t('settings.models.requestParametersDesc')}
          </div>
        </div>
        <ChevronDown
          className="yolo-agent-model-request-parameters-chevron"
          size={16}
          aria-hidden="true"
        />
      </summary>

      <div className="yolo-agent-model-request-parameters-content">
        {enabledCount > 0 && (
          <div className="yolo-agent-model-request-parameters-actions">
            <button
              type="button"
              className="yolo-agent-model-reset"
              onClick={onClear}
            >
              {t('settings.models.clearRequestParameterOverrides')}
            </button>
          </div>
        )}
        {children}
      </div>
    </details>
  )
}
