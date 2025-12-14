import { Modal } from 'obsidian'
import React, { useState } from 'react'

import { AssistantIcon } from '../../../types/assistant.types'
import {
  PRESET_EMOJIS,
  PRESET_LUCIDE_ICONS,
  renderAssistantIcon,
} from '../../../utils/assistant-icon'

export class AssistantIconPickerModal extends Modal {
  private currentIcon: AssistantIcon | undefined
  private onSelect: (icon: AssistantIcon) => void

  constructor(
    app: any,
    currentIcon: AssistantIcon | undefined,
    onSelect: (icon: AssistantIcon) => void,
  ) {
    super(app)
    this.currentIcon = currentIcon
    this.onSelect = onSelect
  }

  onOpen() {
    const { contentEl } = this

    // 创建 React 根容器
    const root = contentEl.createDiv()
    root.addClass('smtcmp-icon-picker-modal')

    // 使用 React 渲染内容
    const IconPickerContent: React.FC = () => {
      const [activeTab, setActiveTab] = useState<'lucide' | 'emoji'>('lucide')
      const [customEmoji, setCustomEmoji] = useState('')

      const handleSelect = (icon: AssistantIcon) => {
        this.onSelect(icon)
        this.close()
      }

      return (
        <div className="smtcmp-icon-picker-content">
          <h2>选择助手图标</h2>

          {/* Tab 切换 */}
          <div className="smtcmp-icon-picker-tabs">
            <button
              className={`smtcmp-icon-picker-tab ${activeTab === 'lucide' ? 'active' : ''}`}
              onClick={() => setActiveTab('lucide')}
            >
              图标库
            </button>
            <button
              className={`smtcmp-icon-picker-tab ${activeTab === 'emoji' ? 'active' : ''}`}
              onClick={() => setActiveTab('emoji')}
            >
              Emoji
            </button>
          </div>

          {/* Lucide 图标网格 */}
          {activeTab === 'lucide' && (
            <div className="smtcmp-icon-picker-grid">
              {PRESET_LUCIDE_ICONS.map((iconName) => {
                const isSelected =
                  this.currentIcon?.type === 'lucide' &&
                  this.currentIcon?.value === iconName
                return (
                  <button
                    key={iconName}
                    className={`smtcmp-icon-picker-item ${isSelected ? 'selected' : ''}`}
                    onClick={() =>
                      handleSelect({ type: 'lucide', value: iconName })
                    }
                    title={iconName}
                  >
                    <div className="smtcmp-icon-picker-item-preview">
                      {renderAssistantIcon(
                        { type: 'lucide', value: iconName },
                        20,
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {/* Emoji 网格 */}
          {activeTab === 'emoji' && (
            <div>
              {/* 自定义 Emoji 输入 */}
              <div className="smtcmp-icon-picker-custom-emoji">
                <input
                  type="text"
                  placeholder="或输入自定义 emoji..."
                  value={customEmoji}
                  onChange={(e) => setCustomEmoji(e.target.value)}
                  maxLength={4}
                  className="smtcmp-icon-picker-emoji-input"
                />
                {customEmoji && (
                  <button
                    className="smtcmp-icon-picker-confirm-btn"
                    onClick={() =>
                      handleSelect({ type: 'emoji', value: customEmoji })
                    }
                  >
                    确认
                  </button>
                )}
              </div>

              {/* 预设 Emoji 网格 */}
              <div className="smtcmp-icon-picker-grid">
                {PRESET_EMOJIS.map((emoji) => {
                  const isSelected =
                    this.currentIcon?.type === 'emoji' &&
                    this.currentIcon?.value === emoji
                  return (
                    <button
                      key={emoji}
                      className={`smtcmp-icon-picker-item ${isSelected ? 'selected' : ''}`}
                      onClick={() =>
                        handleSelect({ type: 'emoji', value: emoji })
                      }
                      title={emoji}
                    >
                      <div className="smtcmp-icon-picker-item-preview">
                        {renderAssistantIcon(
                          { type: 'emoji', value: emoji },
                          24,
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )
    }

    // 渲染 React 组件
    void import('react-dom/client')
      .then(({ createRoot }) => {
        const reactRoot = createRoot(root)
        reactRoot.render(<IconPickerContent />)

        // 在关闭时清理
        this.onClose = () => {
          reactRoot.unmount()
        }
      })
      .catch((error) => {
        console.error('Failed to load react-dom/client for icon picker', error)
      })
  }

  onClose() {
    const { contentEl } = this
    contentEl.empty()
  }
}

/**
 * 打开图标选择器
 */
export const openIconPicker = (
  app: any,
  currentIcon: AssistantIcon | undefined,
  onSelect: (icon: AssistantIcon) => void,
) => {
  new AssistantIconPickerModal(app, currentIcon, onSelect).open()
}
