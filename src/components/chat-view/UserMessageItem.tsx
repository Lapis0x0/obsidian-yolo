import { SerializedEditorState } from 'lexical'
import { Check, CopyIcon, Pencil, Trash2 } from 'lucide-react'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { ChatSelectedSkill, ChatUserMessage } from '../../types/chat'
import { UserMessageDisplaySnapshot } from '../../types/chat-timeline'
import { Mentionable } from '../../types/mentionable'
import { ReasoningLevel } from '../../types/reasoning'

import type { ChatUserInputRef } from './chat-input/ChatUserInput'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import EditableUserMessageItem from './EditableUserMessageItem'
import UserMessageCard from './UserMessageCard'

export type UserMessageItemProps = {
  message: ChatUserMessage
  chatUserInputRef: (ref: ChatUserInputRef | null) => void
  onInputChange: (content: SerializedEditorState) => void
  onSubmit: (content: SerializedEditorState) => void
  onFocus: () => void
  onBlur: () => void
  onMentionablesChange: (mentionables: Mentionable[]) => void
  onSelectedSkillsChange?: (skills: ChatSelectedSkill[]) => void
  onDelete?: () => void
  displayMentionables?: Mentionable[]
  isFocused: boolean
  isActionDisabled?: boolean
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

function UserActionButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  const labelId = useId()
  return (
    <button
      type="button"
      className="clickable-icon yolo-user-message-action-btn"
      onClick={disabled ? undefined : onClick}
      aria-labelledby={labelId}
      disabled={disabled}
    >
      {children}
      <span id={labelId} className="smtcmp-sr-only">
        {label}
      </span>
    </button>
  )
}

function UserMessageActions({
  text,
  onEdit,
  onDelete,
  isDisabled,
}: {
  text: string
  onEdit: () => void
  onDelete?: () => void
  isDisabled?: boolean
}) {
  const { t } = useLanguage()
  const [copied, setCopied] = useState(false)
  const copyResetTimerRef = useRef<number | null>(null)

  const copyLabel = t('common.copy', 'Copy')
  const editLabel = t('common.edit', 'Edit')
  const deleteLabel = t('common.delete', 'Delete')

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
        copyResetTimerRef.current = null
      }
    }
  }, [])

  const handleCopy = () => {
    if (!text) return
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        if (copyResetTimerRef.current !== null) {
          window.clearTimeout(copyResetTimerRef.current)
        }
        copyResetTimerRef.current = window.setTimeout(() => {
          setCopied(false)
          copyResetTimerRef.current = null
        }, 1500)
      })
      .catch((error) => {
        console.error('Failed to copy user message', error)
      })
  }

  return (
    <div className="yolo-user-message-actions">
      <UserActionButton
        label={copyLabel}
        onClick={copied ? () => undefined : handleCopy}
        disabled={text.length === 0}
      >
        {copied ? <Check size={12} /> : <CopyIcon size={12} />}
      </UserActionButton>
      <UserActionButton
        label={editLabel}
        onClick={onEdit}
        disabled={isDisabled}
      >
        <Pencil size={12} />
      </UserActionButton>
      {onDelete ? (
        <UserActionButton
          label={deleteLabel}
          onClick={onDelete}
          disabled={isDisabled}
        >
          <Trash2 size={12} />
        </UserActionButton>
      ) : null}
    </div>
  )
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
  onDelete,
  displayMentionables,
  isFocused,
  isActionDisabled,
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
        <>
          <UserMessageCard snapshot={snapshot} onClick={onFocus} />
          <UserMessageActions
            text={snapshot.text}
            onEdit={onFocus}
            onDelete={onDelete}
            isDisabled={isActionDisabled}
          />
        </>
      )}
    </div>
  )
}

export default memo(UserMessageItem)
