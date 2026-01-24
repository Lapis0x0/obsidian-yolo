import { SerializedEditorState } from 'lexical'
import { useRef } from 'react'

import { ChatUserMessage } from '../../types/chat'
import { Mentionable } from '../../types/mentionable'

import ChatUserInput, { ChatUserInputRef } from './chat-input/ChatUserInput'
import { ReasoningLevel } from './chat-input/ReasoningSelect'
import SimilaritySearchResults from './SimilaritySearchResults'

export type UserMessageItemProps = {
  message: ChatUserMessage
  chatUserInputRef: (ref: ChatUserInputRef | null) => void
  onInputChange: (content: SerializedEditorState) => void
  onSubmit: (content: SerializedEditorState, useVaultSearch: boolean) => void
  onFocus: () => void
  onBlur: () => void
  onMentionablesChange: (mentionables: Mentionable[]) => void
  isFocused: boolean
  modelId?: string
  onModelChange?: (modelId: string) => void
  reasoningLevel?: ReasoningLevel
  onReasoningChange?: (level: ReasoningLevel) => void
}

export default function UserMessageItem({
  message,
  chatUserInputRef,
  onInputChange,
  onSubmit,
  onFocus,
  onBlur,
  onMentionablesChange,
  isFocused,
  modelId,
  onModelChange,
  reasoningLevel,
  onReasoningChange,
}: UserMessageItemProps) {
  const localInputRef = useRef<ChatUserInputRef | null>(null)

  const handleRegisterRef = (ref: ChatUserInputRef | null) => {
    localInputRef.current = ref
    chatUserInputRef(ref)
  }

  const handleExpand = () => {
    if (isFocused) return
    onFocus()
    requestAnimationFrame(() => {
      localInputRef.current?.focus()
    })
  }

  return (
    <div className="smtcmp-chat-messages-user">
      <ChatUserInput
        ref={handleRegisterRef}
        initialSerializedEditorState={message.content}
        onChange={onInputChange}
        onSubmit={onSubmit}
        onFocus={onFocus}
        onBlur={onBlur}
        mentionables={message.mentionables}
        setMentionables={onMentionablesChange}
        modelId={modelId}
        onModelChange={onModelChange}
        reasoningLevel={reasoningLevel}
        onReasoningChange={onReasoningChange}
        compact={!isFocused}
        onToggleCompact={handleExpand}
      />
      {message.similaritySearchResults && (
        <SimilaritySearchResults
          similaritySearchResults={message.similaritySearchResults}
        />
      )}
    </div>
  )
}
