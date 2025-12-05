import { App } from 'obsidian'
import React, { useState, useEffect } from 'react'

import { useLanguage } from '../../../../contexts/language-context'
import SmartComposerPlugin from '../../../../main'
import { ObsidianTextArea } from '../../../common/ObsidianTextArea'
import { ReactModal } from '../../../common/ReactModal'
import { PromptModule } from '../../../../settings/schema/setting.types'

type PromptEditModalComponentProps = {
  plugin: SmartComposerPlugin
  prompt: PromptModule
  onSave: (content: string) => void
}

export class PromptEditModal extends ReactModal<PromptEditModalComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin, prompt: PromptModule, onSave: (content: string) => void) {
    super({
      app: app,
      Component: PromptEditModalComponent,
      props: { plugin, prompt, onSave },
      options: {
        title: 'Edit Prompt', // Will be translated in component
      },
      plugin: plugin,
    })
  }
}

function PromptEditModalComponent({
  plugin,
  onClose,
  prompt,
  onSave,
}: PromptEditModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const [content, setContent] = useState(prompt.content)
  const [originalContent] = useState(prompt.content)
  const [isDirty, setIsDirty] = useState(false)

  // Update modal title
  React.useEffect(() => {
    const modalEl = document.querySelector('.modal .modal-title')
    if (modalEl) {
      modalEl.textContent = prompt.name
    }
  }, [prompt.name])

  // Handle content change
  const handleContentChange = (value: string) => {
    setContent(value)
    setIsDirty(value !== originalContent)
  }

  // Handle save
  const handleSubmit = () => {
    if (content !== originalContent) {
      onSave(content)
    }
    onClose()
  }

  // Handle reset
  const handleReset = () => {
    const confirmMessage = t('settings.systemPrompt.confirmResetContent') ||
      '确定要重置为原始内容吗？'
    if (confirm(confirmMessage)) {
      setContent(originalContent)
      setIsDirty(false)
    }
  }

  // Handle keyboard shortcuts - only Esc is kept
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Esc: Cancel and close
      if (e.key === 'Escape') {
        e.preventDefault()
        if (isDirty) {
          const confirmMessage = t('settings.systemPrompt.confirmDiscardChanges') ||
            '确定要放弃当前的修改吗？'
          if (confirm(confirmMessage)) {
            onClose()
          }
        } else {
          onClose()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isDirty, content, originalContent])

  return (
    <div className="smtcmp-prompt-edit-modal">
      {/* 顶部标题行 */}
      <div className="smtcmp-prompt-edit-modal-header">
        <div className="smtcmp-prompt-edit-modal-title">{prompt.name}</div>
      </div>

      {/* 主要内容区域 - 输入框占据大部分空间 */}
      <div className="smtcmp-prompt-edit-modal-content">
        <ObsidianTextArea
          value={content}
          onChange={handleContentChange}
          placeholder={t('settings.systemPrompt.promptContentPlaceholder')}
          containerClassName="smtcmp-prompt-edit-textarea-container"
          inputClassName="smtcmp-prompt-edit-textarea"
          autoFocus
        />
      </div>

      {/* 底部操作区域 - 三个按钮放在右下角 */}
      <div className="smtcmp-prompt-edit-modal-footer">
        <div className="smtcmp-prompt-edit-modal-actions">
          <button
            className="smtcmp-button smtcmp-button-secondary"
            onClick={handleReset}
            disabled={!isDirty}
          >
            {t('settings.systemPrompt.reset')}
          </button>
          <button
            className="smtcmp-button smtcmp-button-secondary"
            onClick={() => {
              if (isDirty) {
                const confirmMessage = t('settings.systemPrompt.confirmDiscardChanges') ||
                  '确定要放弃当前的修改吗？'
                if (confirm(confirmMessage)) {
                  onClose()
                }
              } else {
                onClose()
              }
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            className="smtcmp-button smtcmp-button-primary"
            onClick={handleSubmit}
            disabled={!isDirty}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}