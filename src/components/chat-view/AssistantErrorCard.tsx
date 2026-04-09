import { CircleAlert } from 'lucide-react'
import { memo } from 'react'

import { useLanguage } from '../../contexts/language-context'

const AssistantErrorCard = memo(function AssistantErrorCard({
  errorMessage,
}: {
  errorMessage: string
}) {
  const { t } = useLanguage()

  return (
    <div className="smtcmp-assistant-error-card" role="alert">
      <div className="smtcmp-assistant-error-card-header">
        <CircleAlert size={14} />
        <span>{t('chat.errorCard.title', '本次回复生成失败')}</span>
      </div>
      <div className="smtcmp-assistant-error-card-body">{errorMessage}</div>
    </div>
  )
})

export default AssistantErrorCard
