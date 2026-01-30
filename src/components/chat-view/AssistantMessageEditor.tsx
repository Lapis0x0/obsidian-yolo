import {
  type KeyboardEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../contexts/language-context'

type AssistantMessageEditorProps = {
  initialContent: string
  onSave: (content: string) => void
  onCancel: () => void
  disabled?: boolean
}

export default function AssistantMessageEditor({
  initialContent,
  onSave,
  onCancel,
  disabled = false,
}: AssistantMessageEditorProps) {
  const { t } = useLanguage()
  const [value, setValue] = useState(initialContent)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    setValue(initialContent)
  }, [initialContent])

  const syncHeight = useCallback(() => {
    if (!textareaRef.current) return
    textareaRef.current.setCssProps({
      '--smtcmp-assistant-editor-height': 'auto',
    })
    textareaRef.current.setCssProps({
      '--smtcmp-assistant-editor-height': `${textareaRef.current.scrollHeight}px`,
    })
  }, [])

  useEffect(() => {
    syncHeight()
  }, [syncHeight, value])

  const isDirty = useMemo(
    () => value !== initialContent,
    [value, initialContent],
  )

  const handleSave = () => {
    if (disabled) return
    onSave(value)
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
    <div className="smtcmp-assistant-message-editor">
      <textarea
        ref={textareaRef}
        className="smtcmp-assistant-message-editor-textarea"
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
        }}
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
        autoFocus
        disabled={disabled}
      />
      <div className="smtcmp-assistant-editor-buttons">
        <button onClick={onCancel} disabled={disabled}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button
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
