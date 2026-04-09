import { memo, useMemo } from 'react'
import type { KeyboardEvent } from 'react'

import { useSettings } from '../../contexts/settings-context'
import type { ChatSelectedSkill } from '../../types/chat'
import type { UserMessageDisplaySnapshot } from '../../types/chat-timeline'
import type { Mentionable } from '../../types/mentionable'
import {
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'

import ChatSkillBadge from './chat-input/ChatSkillBadge'
import MentionableBadge from './chat-input/MentionableBadge'
import ReadOnlyUserMessageContent from './ReadOnlyUserMessageContent'

type UserMessageCardProps = {
  snapshot: UserMessageDisplaySnapshot
  onClick: () => void
  className?: string
}

const ReadOnlyBadge = memo(function ReadOnlyBadge({
  mentionable,
}: {
  mentionable: Mentionable
}) {
  return (
    <MentionableBadge
      mentionable={mentionable}
      onDelete={() => {}}
      onClick={() => {}}
      showDeleteButton={false}
    />
  )
})

const ReadOnlySkillBadge = memo(function ReadOnlySkillBadge({
  skill,
}: {
  skill: ChatSelectedSkill
}) {
  return (
    <ChatSkillBadge
      skill={skill}
      onDelete={() => {}}
      showDeleteButton={false}
    />
  )
})

function UserMessageCard({
  snapshot,
  onClick,
  className,
}: UserMessageCardProps) {
  const { settings } = useSettings()
  const mentionDisplayMode = settings.chatOptions.mentionDisplayMode ?? 'inline'
  const fallbackText = useMemo(
    () =>
      snapshot.text
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line, index, lines) => line.length > 0 || lines.length === 1)
        .join('\n'),
    [snapshot.text],
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    event.preventDefault()
    onClick()
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`smtcmp-user-message-card smtcmp-chat-user-input-wrapper smtcmp-chat-user-input-wrapper--compact${className ? ` ${className}` : ''}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      {mentionDisplayMode === 'badge' &&
        (snapshot.mentionables.length > 0 ||
          snapshot.selectedSkills.length > 0) && (
          <div className="smtcmp-chat-user-input-files smtcmp-user-message-card__badges">
            {snapshot.selectedSkills.map((skill) => (
              <ReadOnlySkillBadge key={skill.id} skill={skill} />
            ))}
            {snapshot.mentionables.map((mentionable) => (
              <ReadOnlyBadge
                key={getMentionableKey(serializeMentionable(mentionable))}
                mentionable={mentionable}
              />
            ))}
          </div>
        )}

      <div className="smtcmp-chat-user-input-container">
        <div className="smtcmp-chat-user-input-editor">
          <div className="smtcmp-user-message-card__content">
            {fallbackText.length > 0 || snapshot.content ? (
              <ReadOnlyUserMessageContent
                content={snapshot.content}
                fallbackText={fallbackText}
              />
            ) : (
              <div className="smtcmp-chat-user-input-placeholder">
                Click to edit...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(UserMessageCard)
