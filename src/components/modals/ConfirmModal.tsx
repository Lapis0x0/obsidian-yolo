import { App } from 'obsidian'

import { useLanguage } from '../../contexts/language-context'
import { ReactModal } from '../common/ReactModal'

export type ConfirmModalOptions = {
  title: string
  message: string
  ctaText?: string
  cancelText?: string
  showCancel?: boolean
  onConfirm: () => void
  onCancel?: () => void
}

type ConfirmModalComponentProps = {
  message: string
  ctaText?: string
  cancelText?: string
  showCancel?: boolean
  onConfirm: () => void
  onCancel?: () => void
  settledRef: { current: boolean }
}

export class ConfirmModal extends ReactModal<ConfirmModalComponentProps> {
  // Shared between the React component and the modal's `onClose` so dismissal
  // via the close button or ESC key can fall through to onCancel.
  private settledRef = { current: false }
  private cancelHandler?: () => void

  constructor(app: App, options: ConfirmModalOptions) {
    const settledRef = { current: false }
    super({
      app: app,
      Component: ConfirmModalComponent,
      props: {
        message: options.message,
        ctaText: options.ctaText,
        cancelText: options.cancelText,
        showCancel: options.showCancel,
        onConfirm: options.onConfirm,
        onCancel: options.onCancel,
        settledRef,
      },
      options: {
        title: options.title,
      },
    })
    this.settledRef = settledRef
    this.cancelHandler = options.onCancel
  }

  onClose() {
    if (!this.settledRef.current) {
      this.settledRef.current = true
      this.cancelHandler?.()
    }
    super.onClose()
  }
}

function ConfirmModalComponent({
  message,
  ctaText,
  cancelText,
  showCancel = true,
  onConfirm,
  onCancel,
  settledRef,
  onClose,
}: ConfirmModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  return (
    <div>
      <div className="yolo-prewrap">{message}</div>
      <div className="modal-button-container">
        <button
          className="mod-warning"
          onClick={() => {
            settledRef.current = true
            try {
              onConfirm()
            } finally {
              onClose()
            }
          }}
        >
          {ctaText ?? t('common.confirm', 'Confirm')}
        </button>
        {showCancel && (
          <button
            className="mod-cancel"
            onClick={() => {
              settledRef.current = true
              try {
                onCancel?.()
              } finally {
                onClose()
              }
            }}
          >
            {cancelText ?? t('common.cancel', 'Cancel')}
          </button>
        )}
      </div>
    </div>
  )
}
