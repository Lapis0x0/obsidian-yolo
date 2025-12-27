import { ArrowUp } from 'lucide-react'

export function SubmitButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="smtcmp-chat-user-input-submit-button-circle"
      onClick={onClick}
      type="button"
    >
      <ArrowUp size={16} />
    </button>
  )
}
