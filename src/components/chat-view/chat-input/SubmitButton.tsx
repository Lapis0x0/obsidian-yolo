import { CornerDownLeftIcon } from 'lucide-react'

import { useLanguage } from '../../../contexts/language-context'

export function SubmitButton({ onClick }: { onClick: () => void }) {
  const { t } = useLanguage()

  return (
    <button
      type="button"
      className="smtcmp-chat-user-input-submit-button"
      onClick={onClick}
    >
      <div className="smtcmp-chat-user-input-submit-button-icons">
        <CornerDownLeftIcon size={12} />
      </div>
      <div className="smtcmp-chat-user-input-submit-button-label">
        {t('chat.sendMessage', 'Chat')}
      </div>
    </button>
  )
}
