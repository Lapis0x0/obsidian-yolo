import { Sparkles, X } from 'lucide-react'

import { ChatSelectedSkill } from '../../../types/chat'

type ChatSkillBadgeProps = {
  skill: ChatSelectedSkill
  onDelete: () => void
  isFocused?: boolean
  showDeleteButton?: boolean
}

export default function ChatSkillBadge({
  skill,
  onDelete,
  isFocused = false,
  showDeleteButton = true,
}: ChatSkillBadgeProps) {
  return (
    <div
      className={`smtcmp-chat-user-input-file-badge ${isFocused ? 'smtcmp-chat-user-input-file-badge-focused' : ''}`}
    >
      <div className="smtcmp-chat-user-input-file-badge-name">
        <Sparkles
          size={12}
          className="smtcmp-chat-user-input-file-badge-name-icon"
        />
        <span>{skill.name}</span>
      </div>
      {showDeleteButton && (
        <button
          type="button"
          className="smtcmp-chat-user-input-file-badge-delete"
          onClick={(event) => {
            event.stopPropagation()
            onDelete()
          }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
