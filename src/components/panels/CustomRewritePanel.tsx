import { Editor } from 'obsidian'
import React, { useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { ObsidianButton } from '../common/ObsidianButton'
import { ObsidianSetting } from '../common/ObsidianSetting'
import { ObsidianTextArea } from '../common/ObsidianTextArea'
import { ReactFloatingPanel } from '../common/ReactFloatingPanel'

export type CustomRewritePanelProps = {
  editor: Editor
  onClose: () => void
}

function CustomRewritePanelBody({ editor, onClose }: CustomRewritePanelProps) {
  const plugin = usePlugin()
  const { t } = useLanguage()
  const [instruction, setInstruction] = useState('')

  const handleConfirm = async () => {
    onClose()
    await plugin.customRewrite(
      editor,
      instruction.trim().length > 0 ? instruction : undefined,
    )
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      // Shift+Enter 作为确定
      void handleConfirm()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    // Enter 默认换行，保持原行为（不拦截）
  }

  return (
    <>
      {/* 输入区占满剩余空间 */}
      <div className="smtcmp-instruction-editor-container">
        <ObsidianTextArea
          value={instruction}
          placeholder={t('chat.customRewritePromptPlaceholder') ?? ''}
          onChange={(v) => setInstruction(v)}
          inputClassName="smtcmp-instruction-textarea"
          autoFocus
          onKeyDown={handleKeyDown}
        />
      </div>

      {/* 底部轻量工具条 */}
      <ObsidianSetting>
        <ObsidianButton
          text={t('common.confirm')}
          onClick={handleConfirm}
          cta
        />
        <ObsidianButton text={t('common.cancel')} onClick={onClose} />
      </ObsidianSetting>
    </>
  )
}

export class CustomRewritePanel {
  private panel: ReactFloatingPanel<CustomRewritePanelProps>

  constructor({
    plugin,
    editor,
    position,
  }: {
    plugin: any
    editor: Editor
    position?: { x: number; y: number }
  }) {
    this.panel = new ReactFloatingPanel<CustomRewritePanelProps>({
      Component: CustomRewritePanelBody,
      props: { editor },
      plugin,
      options: {
        title: plugin.t('commands.customRewrite'),
        initialPosition: position,
        closeOnEscape: true,
        closeOnOutsideClick: true,
        width: 420,
        height: 260,
        minimal: true,
      },
    })
  }

  open() {
    this.panel.open()
  }

  close() {
    this.panel.close()
  }
}
