import { SerializedEditorState } from 'lexical'
import { memo, useRef } from 'react'

import { ChatSelectedSkill, ChatUserMessage } from '../../types/chat'
import { Mentionable } from '../../types/mentionable'
import { ReasoningLevel } from '../../types/reasoning'

import ChatUserInput, { ChatUserInputRef } from './chat-input/ChatUserInput'

export type EditableUserMessageItemProps = {
  message: ChatUserMessage
  chatUserInputRef: (ref: ChatUserInputRef | null) => void
  autoFocus?: boolean
  onInputChange: (content: SerializedEditorState) => void
  onSubmit: (content: SerializedEditorState) => void
  onFocus: () => void
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
  currentChatMode?: import('./chat-input/ChatModeSelect').ChatMode
  onSelectChatModeForConversation?: (
    mode: import('./chat-input/ChatModeSelect').ChatMode,
  ) => void
  onControlPopoverOpenChange?: (isOpen: boolean) => void
  allowAgentModeOption?: boolean
}

function EditableUserMessageItem({
  message,
  chatUserInputRef,
  autoFocus = false,
  onInputChange,
  onSubmit,
  onFocus,
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
  onControlPopoverOpenChange,
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
      controlLayout="inline"
      currentAssistantId={currentAssistantId}
      currentChatMode={currentChatMode}
      onSelectChatModeForConversation={onSelectChatModeForConversation}
      onControlPopoverOpenChange={onControlPopoverOpenChange}
      allowAgentModeOption={allowAgentModeOption}
    />
  )
}

export default memo(EditableUserMessageItem)
