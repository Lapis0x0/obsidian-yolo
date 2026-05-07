import { App } from '../../runtime/react-compat'
import { useState } from 'react'

import { ReactModal } from '../common/ReactModal'

type AgentModeWarningModalOptions = {
  title: string
  description: string
  risks: [string, string, string]
  checkboxLabel: string
  confirmText: string
  cancelText: string
  onConfirm: () => void
}

type AgentModeWarningModalProps = Omit<AgentModeWarningModalOptions, 'title'>

export class AgentModeWarningModal extends ReactModal<AgentModeWarningModalProps> {
  constructor(app: App, options: AgentModeWarningModalOptions) {
    super({
      app,
      Component: AgentModeWarningModalComponent,
      props: {
        description: options.description,
        risks: options.risks,
        checkboxLabel: options.checkboxLabel,
        confirmText: options.confirmText,
        cancelText: options.cancelText,
        onConfirm: options.onConfirm,
      },
      options: {
        title: options.title,
      },
    })
  }
}

function AgentModeWarningModalComponent({
  description,
  risks,
  checkboxLabel,
  confirmText,
  cancelText,
  onConfirm,
  onClose,
}: AgentModeWarningModalProps & { onClose: () => void }) {
  const [confirmed, setConfirmed] = useState(false)

  const renderRisk = (risk: string) => {
    const matched = risk.match(/^([^:：]+)([:：]\s*)(.+)$/)
    if (!matched) return risk

    return (
      <>
        <strong className="smtcmp-agent-mode-warning-risk-title">{`${matched[1]}${matched[2]}`}</strong>
        <span>{matched[3]}</span>
      </>
    )
  }

  return (
    <div className="smtcmp-agent-mode-warning-modal">
      <p className="smtcmp-agent-mode-warning-description">{description}</p>
      <ol className="smtcmp-agent-mode-warning-list">
        {risks.map((risk, index) => (
          <li key={`${index}-${risk}`}>{renderRisk(risk)}</li>
        ))}
      </ol>
      <label className="smtcmp-agent-mode-warning-checkbox">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => {
            setConfirmed(event.target.checked)
          }}
        />
        <span>{checkboxLabel}</span>
      </label>
      <div className="modal-button-container smtcmp-agent-mode-warning-actions">
        <button
          type="button"
          className="mod-warning smtcmp-agent-mode-warning-confirm"
          disabled={!confirmed}
          onClick={() => {
            if (!confirmed) return
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
