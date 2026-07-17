import {
  type KeyboardEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { AssistantToolMessageGroup, ChatMessage } from '../../types/chat'
import {
  parseGroupFromEdit,
  serializeGroupForEdit,
} from '../../utils/chat/assistant-group-edit-parser'

type AssistantGroupEditorProps = {
  messages: AssistantToolMessageGroup
  onSave: (replacementMessages: ChatMessage[]) => void
  onCancel: () => void
  disabled?: boolean
  minHeight?: number | null
}

export default function AssistantGroupEditor({
  messages,
  onSave,
  onCancel,
  disabled = false,
  minHeight = null,
}: AssistantGroupEditorProps) {
  const { t } = useLanguage()
  const initialValue = useMemo(
    () => serializeGroupForEdit(messages),
    [messages],
  )
  const [value, setValue] = useState(initialValue)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    setValue(initialValue)
  }, [initialValue])

  const syncHeight = useCallback(() => {
    if (!textareaRef.current) return
    textareaRef.current.setCssProps({
      '--yolo-assistant-editor-height': 'auto',
    })
    textareaRef.current.setCssProps({
      '--yolo-assistant-editor-height': `${textareaRef.current.scrollHeight}px`,
    })
  }, [])

  useLayoutEffect(() => {
    syncHeight()
  }, [syncHeight, value])

  useLayoutEffect(() => {
    textareaRef.current?.focus({ preventScroll: true })
  }, [])

  const isDirty = useMemo(() => value !== initialValue, [value, initialValue])

  const handleSave = () => {
    if (disabled) return
    const { retainedMessages } = parseGroupFromEdit(value, messages)
    onSave(retainedMessages)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      handleSave()
    }
  }

  const handleWheel = (event: WheelEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget
    const canScroll = target.scrollHeight > target.clientHeight
    if (!canScroll) return
    const atTop = target.scrollTop <= 0
    const atBottom =
      Math.ceil(target.scrollTop + target.clientHeight) >= target.scrollHeight
    const isScrollingUp = event.deltaY < 0
    const isScrollingDown = event.deltaY > 0

    if ((atTop && isScrollingUp) || (atBottom && isScrollingDown)) {
      return
    }
    event.stopPropagation()
  }

  return (
    <div
      className="yolo-assistant-group-editor"
      style={minHeight ? { minHeight } : undefined}
    >
      <textarea
        ref={textareaRef}
        className="yolo-assistant-group-editor-textarea"
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
        }}
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
        disabled={disabled}
      />
      <div className="yolo-assistant-editor-buttons">
        <button type="button" onClick={onCancel} disabled={disabled}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          className="mod-cta"
          onClick={handleSave}
          disabled={disabled || !isDirty}
        >
          {t('common.save', 'Save')}
        </button>
      </div>
    </div>
  )
}
