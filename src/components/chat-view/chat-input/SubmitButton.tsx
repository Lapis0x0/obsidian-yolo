import { ArrowUp, Square } from 'lucide-react'

import { useLanguage } from '../../../contexts/language-context'

type SubmitButtonProps = {
  onClick: () => void
  /**
   * True while a conversation run is in flight. The button takes one of two
   * forms depending on whether the input has content:
   * - empty input → stop button (clicking aborts the run)
   * - non-empty input → send button (clicking enqueues the message for
   *   injection at the next safe boundary)
   */
  isGenerating?: boolean
  onAbort?: () => void
  /**
   * True when the input is empty. While idle this disables the send button;
   * while generating this is what makes the button render as a stop button
   * instead of a queueing-send button.
   */
  disabled?: boolean
}

export function SubmitButton({
  onClick,
  isGenerating = false,
  onAbort,
  disabled = false,
}: SubmitButtonProps) {
  const { t } = useLanguage()
  const sendLabel = t('chat.sendMessage', 'Chat')
  const queueLabel = t(
    'chat.queueMessage.tooltip',
    '加入排队，等当前回合完成后继续',
  )
  const stopLabel = t('chat.stopGeneration', 'Stop generation')

  if (isGenerating && disabled) {
    return (
      <button
        type="button"
        className="yolo-chat-user-input-submit-button-circle is-stop"
        onClick={() => onAbort?.()}
        aria-label={stopLabel}
      >
        <Square size={12} fill="currentColor" strokeWidth={0} />
      </button>
    )
  }

  const label = isGenerating ? queueLabel : sendLabel
  return (
    <button
      type="button"
      className={`yolo-chat-user-input-submit-button-circle${
        isGenerating ? ' is-queueing' : ''
      }`}
      disabled={!isGenerating && disabled}
      onClick={() => {
        if (!isGenerating && disabled) return
        onClick()
      }}
      aria-label={label}
    >
      <ArrowUp size={16} strokeWidth={2.5} />
    </button>
  )
}
