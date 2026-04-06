import { SerializedEditorState } from 'lexical'
import { memo, useMemo } from 'react'

import { ChatSelectedSkill, ChatUserMessage } from '../../types/chat'
import { UserMessageDisplaySnapshot } from '../../types/chat-timeline'
import { Mentionable } from '../../types/mentionable'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'

import type { ChatUserInputRef } from './chat-input/ChatUserInput'
import EditableUserMessageItem from './EditableUserMessageItem'
import { ReasoningLevel } from './chat-input/ReasoningSelect'
import SimilaritySearchResults from './SimilaritySearchResults'
import UserMessageCard from './UserMessageCard'

export type UserMessageItemProps = {
  message: ChatUserMessage
  chatUserInputRef: (ref: ChatUserInputRef | null) => void
  onInputChange: (content: SerializedEditorState) => void
  onSubmit: (content: SerializedEditorState, useVaultSearch: boolean) => void
  onFocus: () => void
  onBlur: () => void
  onMentionablesChange: (mentionables: Mentionable[]) => void
  onSelectedSkillsChange?: (skills: ChatSelectedSkill[]) => void
  displayMentionables?: Mentionable[]
  isFocused: boolean
  modelId?: string
  onModelChange?: (modelId: string) => void
  reasoningLevel?: ReasoningLevel
  onReasoningChange?: (level: ReasoningLevel) => void
  showReasoningSelect?: boolean
  showPlaceholder?: boolean
  currentAssistantId?: string
  currentChatMode?: 'chat' | 'agent'
  onSelectChatModeForConversation?: (mode: 'chat' | 'agent') => void
  allowAgentModeOption?: boolean
}

function UserMessageItem({
  message,
  chatUserInputRef,
  onInputChange,
  onSubmit,
  onFocus,
  onBlur,
  onMentionablesChange,
  onSelectedSkillsChange,
  displayMentionables,
  isFocused,
  modelId,
  onModelChange,
  reasoningLevel,
  onReasoningChange,
  showReasoningSelect,
  showPlaceholder,
  currentAssistantId,
  currentChatMode,
  onSelectChatModeForConversation,
  allowAgentModeOption,
}: UserMessageItemProps) {
  const snapshot = useMemo<UserMessageDisplaySnapshot>(
    () => ({
      content: message.content,
      text: message.content ? editorStateToPlainText(message.content) : '',
      mentionables: displayMentionables ?? message.mentionables,
      selectedSkills: message.selectedSkills ?? [],
      modelId,
      reasoningLevel,
    }),
    [
      displayMentionables,
      message.content,
      message.mentionables,
      message.selectedSkills,
      modelId,
      reasoningLevel,
    ],
  )

  return (
    <div
      className="smtcmp-chat-messages-user"
      data-user-message-id={message.id}
    >
      {isFocused ? (
        <EditableUserMessageItem
          message={message}
          chatUserInputRef={chatUserInputRef}
          autoFocus
          onInputChange={onInputChange}
          onSubmit={onSubmit}
          onFocus={onFocus}
          onBlur={onBlur}
          onMentionablesChange={onMentionablesChange}
          onSelectedSkillsChange={onSelectedSkillsChange}
          displayMentionables={displayMentionables}
          modelId={modelId}
          onModelChange={onModelChange}
          reasoningLevel={reasoningLevel}
          onReasoningChange={onReasoningChange}
          showReasoningSelect={showReasoningSelect}
          showPlaceholder={showPlaceholder}
          currentAssistantId={currentAssistantId}
          currentChatMode={currentChatMode}
          onSelectChatModeForConversation={onSelectChatModeForConversation}
          allowAgentModeOption={allowAgentModeOption}
        />
      ) : (
        <UserMessageCard snapshot={snapshot} onClick={onFocus} />
      )}
      {message.similaritySearchResults && (
        <SimilaritySearchResults
          similaritySearchResults={message.similaritySearchResults}
        />
      )}
    </div>
  )
}

export default memo(UserMessageItem)
