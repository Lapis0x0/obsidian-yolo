import { App } from 'obsidian'
import { useState } from 'react'

import { ReactModal } from '../common/ReactModal'

type AcknowledgementModalOptions = {
  title: string
  messages: readonly string[]
  items?: readonly string[]
  checkboxLabel?: string
  confirmText: string
  cancelText: string
  confirmTone?: 'cta' | 'warning'
  centered?: boolean
  onConfirm: () => void
  onDismiss?: () => void
}

type AcknowledgementModalProps = Omit<
  AcknowledgementModalOptions,
  'title' | 'centered' | 'onDismiss'
>

export class AcknowledgementModal extends ReactModal<AcknowledgementModalProps> {
  private readonly wasConfirmed: () => boolean
  private readonly onDismiss?: () => void

  constructor(app: App, options: AcknowledgementModalOptions) {
    let confirmed = false
    super({
      app,
      Component: AcknowledgementModalComponent,
      props: {
        messages: options.messages,
        items: options.items,
        checkboxLabel: options.checkboxLabel,
        confirmText: options.confirmText,
        cancelText: options.cancelText,
        confirmTone: options.confirmTone,
        onConfirm: () => {
          confirmed = true
          options.onConfirm()
        },
      },
      options: {
        title: options.title,
        className: options.centered
          ? 'yolo-acknowledgement-modal--centered'
          : undefined,
      },
    })
    this.wasConfirmed = () => confirmed
    this.onDismiss = options.onDismiss
  }

  override onClose() {
    super.onClose()
    if (!this.wasConfirmed()) this.onDismiss?.()
  }
}

function AcknowledgementModalComponent({
  messages,
  items,
  checkboxLabel,
  confirmText,
  cancelText,
  confirmTone = 'cta',
  onConfirm,
  onClose,
}: AcknowledgementModalProps & { onClose: () => void }) {
  const [confirmed, setConfirmed] = useState(false)

  const renderItem = (item: string) => {
    const matched = item.match(/^([^:：]+)([:：]\s*)(.+)$/)
    if (!matched) return item

    return (
      <>
        <strong className="yolo-acknowledgement-modal-item-title">{`${matched[1]}${matched[2]}`}</strong>
        <span>{matched[3]}</span>
      </>
    )
  }

  return (
    <div className="yolo-acknowledgement-modal">
      <div className="yolo-acknowledgement-modal-messages">
        {messages.map((message, index) => (
          <p key={`${index}-${message}`}>{message}</p>
        ))}
      </div>
      {items?.length ? (
        <ol className="yolo-acknowledgement-modal-list">
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>{renderItem(item)}</li>
          ))}
        </ol>
      ) : null}
      {checkboxLabel ? (
        <label className="yolo-acknowledgement-modal-checkbox">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked)
            }}
          />
          <span>{checkboxLabel}</span>
        </label>
      ) : null}
      <div className="modal-button-container yolo-acknowledgement-modal-actions">
        <button
          type="button"
          className={`${confirmTone === 'warning' ? 'mod-warning' : 'mod-cta'} yolo-acknowledgement-modal-confirm`}
          disabled={Boolean(checkboxLabel) && !confirmed}
          onClick={() => {
            if (checkboxLabel && !confirmed) return
            try {
              onConfirm()
            } finally {
              onClose()
            }
          }}
        >
          {confirmText}
        </button>
        <button type="button" className="mod-cancel" onClick={onClose}>
          {cancelText}
        </button>
      </div>
    </div>
  )
}
