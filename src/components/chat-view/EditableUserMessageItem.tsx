import { SerializedEditorState } from 'lexical'
import { memo, useRef } from 'react'

import { ChatSelectedSkill, ChatUserMessage } from '../../types/chat'
import { Mentionable } from '../../types/mentionable'

import ChatUserInput, { ChatUserInputRef } from './chat-input/ChatUserInput'
import { ReasoningLevel } from './chat-input/ReasoningSelect'

export type EditableUserMessageItemProps = {
  message: ChatUserMessage
  chatUserInputRef: (ref: ChatUserInputRef | null) => void
  autoFocus?: boolean
  onInputChange: (content: SerializedEditorState) => void
  onSubmit: (content: SerializedEditorState) => void
  onFocus: () => void
  onBlur: () => void
  onMentionablesChange: (mentionables: Mentionable[]) => void
  onSelectedSkillsChange?: (skills: ChatSelectedSkill[]) => void
  displayMentionables?: Mentionable[]
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

function EditableUserMessageItem({
  message,
  chatUserInputRef,
  autoFocus = false,
  onInputChange,
  onSubmit,
  onFocus,
  onBlur,
  onMentionablesChange,
  onSelectedSkillsChange,
  displayMentionables,
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
}: EditableUserMessageItemProps) {
  const localInputRef = useRef<ChatUserInputRef | null>(null)

  const handleRegisterRef = (ref: ChatUserInputRef | null) => {
    localInputRef.current = ref
    chatUserInputRef(ref)
  }

  return (
    <ChatUserInput
      ref={handleRegisterRef}
      initialSerializedEditorState={message.content}
      autoFocus={autoFocus}
      onChange={onInputChange}
      onSubmit={onSubmit}
      onFocus={onFocus}
      onBlur={onBlur}
      mentionables={message.mentionables}
      setMentionables={onMentionablesChange}
      selectedSkills={message.selectedSkills ?? []}
      setSelectedSkills={onSelectedSkillsChange}
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
  )
}

export default memo(EditableUserMessageItem)
