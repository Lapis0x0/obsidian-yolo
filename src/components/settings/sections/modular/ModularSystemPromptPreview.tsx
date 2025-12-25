import React, { useState } from 'react'
import { Copy, Check } from 'lucide-react'

import { ObsidianSetting } from '../../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../../common/ObsidianTextArea'
import { ObsidianButton } from '../../../common/ObsidianButton'
import { useLanguage } from '../../../../contexts/language-context'

interface ModularSystemPromptPreviewProps {
  systemPrompt: string
  className?: string
}

const ModularSystemPromptPreview: React.FC<ModularSystemPromptPreviewProps> = ({
  systemPrompt,
  className = '',
}) => {
  const { t } = useLanguage()
  const [copied, setCopied] = useState(false)

  // 复制到剪贴板
  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(systemPrompt)
      setCopied(true)

      // 2秒后恢复按钮状态
      setTimeout(() => {
        setCopied(false)
      }, 2000)
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)

      // 备用方案：创建临时textare
      const textArea = document.createElement('textarea')
      textArea.value = systemPrompt
      textArea.style.position = 'fixed'
      textArea.style.left = '-999999px'
      textArea.style.top = '-999999px'
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()

      try {
        document.execCommand('copy')
        setCopied(true)
        setTimeout(() => {
          setCopied(false)
        }, 2000)
      } catch (fallbackError) {
        console.error('Fallback copy failed:', fallbackError)
      } finally {
        document.body.removeChild(textArea)
      }
    }
  }

  // 计算字符统计
  const getCharacterStats = () => {
    if (!systemPrompt) {
      return {
        chars: 0,
        words: 0,
        lines: 0,
        chineseChars: 0,
        englishWords: 0,
      }
    }

    const chars = systemPrompt.length
    const lines = systemPrompt.split('\n').length

    // 计算中文字数
    const chineseChars = (systemPrompt.match(/[\u4e00-\u9fff]/g) || []).length

    // 计算英文单词数（排除中文字符）
    const englishOnly = systemPrompt.replace(/[\u4e00-\u9fff]/g, '')
    const englishWords = englishOnly
      .split(/\s+/)
      .filter(word => word.length > 0).length

    const words = chineseChars + englishWords

    return {
      chars,
      words,
      lines,
      chineseChars,
      englishWords,
    }
  }

  const stats = getCharacterStats()

  return (
    <div className={`smtcmp-preview-mode ${className}`}>
      {/* 预览模式头部 */}
      <div className="smtcmp-preview-header">
        <h3 className="smtcmp-preview-title">
          {t('settings.systemPreview.title') || '预览模式'}
        </h3>

        <div className="smtcmp-preview-stats">
          <span className="smtcmp-preview-stat">
            {t('settings.systemPreview.totalChars') || '总字符'}: {stats.chars}
          </span>
          <span className="smtcmp-preview-stat">
            {t('settings.systemPreview.totalWords') || '总字数'}: {stats.words}
          </span>
          <span className="smtcmp-preview-stat">
            {t('settings.systemPreview.totalLines') || '总行数'}: {stats.lines}
          </span>
          <span className="smtcmp-preview-stat">
            {t('settings.systemPreview.chineseChars') || '中文'}: {stats.chineseChars}
          </span>
          <span className="smtcmp-preview-stat">
            {t('settings.systemPreview.englishWords') || '英文'}: {stats.englishWords}
          </span>
        </div>
      </div>

      {/* 预览内容标题和描述 */}
      <div className="smtcmp-preview-content-header">
        <h4 className="smtcmp-preview-content-title">
          {t('settings.systemPreview.previewContent') || '系统提示词预览'}
        </h4>
        <p className="smtcmp-preview-content-desc">
          {t('settings.systemPreview.previewDesc') || '这是所有启用的提示词模块按顺序组合后的最终内容'}
        </p>
      </div>

      {/* 预览内容 */}
      <div className="smtcmp-preview-textarea-wrapper">
        <ObsidianTextArea
          value={systemPrompt}
          onChange={() => {}}
          disabled={true}
          containerClassName="smtcmp-preview-textarea"
          inputClassName="smtcmp-preview-textarea-input"
          placeholder={t('settings.systemPreview.previewEmpty') || '没有启用的提示词模块'}
        />
      </div>

      {/* 操作按钮 */}
      <div className="smtcmp-preview-actions">
        <ObsidianButton
          text={copied ?
            (t('settings.systemPreview.copied') || '已复制') :
            (t('settings.systemPreview.copyToClipboard') || '复制到剪贴板')
          }
          onClick={handleCopyToClipboard}
          disabled={!systemPrompt}
        />

        {systemPrompt && (
          <div className="smtcmp-preview-tips">
            <span className="smtcmp-preview-tip">
              {t('settings.systemPreview.previewTip') || '提示：此内容将作为系统提示词发送给AI模型'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

export default ModularSystemPromptPreview