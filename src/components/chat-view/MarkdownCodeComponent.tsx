import { Check, CopyIcon, Eye, Loader2, Play } from 'lucide-react'
import { PropsWithChildren, useMemo, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useDarkModeContext } from '../../contexts/dark-mode-context'
import { useLanguage } from '../../contexts/language-context'
import { openMarkdownFile } from '../../utils/obsidian'

import { ObsidianMarkdown } from './ObsidianMarkdown'
import { MemoizedSyntaxHighlighterWrapper } from './SyntaxHighlighterWrapper'

export default function MarkdownCodeComponent({
  onApply,
  isApplying,
  language,
  filename,
  children,
}: PropsWithChildren<{
  onApply: (blockToApply: string) => void
  isApplying: boolean
  language?: string
  filename?: string
}>) {
  const app = useApp()
  const { isDarkMode } = useDarkModeContext()
  const { t } = useLanguage()

  const [isPreviewMode, setIsPreviewMode] = useState(true)
  const [copied, setCopied] = useState(false)

  const wrapLines = useMemo(() => {
    return !language || ['markdown'].includes(language)
  }, [language])

  const codeContent = useMemo(() => {
    if (typeof children === 'string') {
      return children
    }
    if (typeof children === 'number' || typeof children === 'boolean') {
      return String(children)
    }
    if (Array.isArray(children)) {
      return children
        .map((child) => {
          if (typeof child === 'string') return child
          if (typeof child === 'number' || typeof child === 'boolean') {
            return String(child)
          }
          if (child && typeof child === 'object' && 'props' in child) {
            const nested = (child as { props?: { children?: unknown } }).props
              ?.children
            return typeof nested === 'string' ? nested : ''
          }
          return ''
        })
        .join('')
    }
    if (children && typeof children === 'object' && 'props' in children) {
      const nested = (children as { props?: { children?: unknown } }).props
        ?.children
      if (typeof nested === 'string') {
        return nested
      }
    }
    return ''
  }, [children])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy text: ', err)
    }
  }

  const handleOpenFile = () => {
    if (filename) {
      openMarkdownFile(app, filename)
    }
  }

  return (
    <div className="smtcmp-code-block">
      <div className="smtcmp-code-block-header">
        {filename && (
          <div
            className="smtcmp-code-block-header-filename"
            onClick={handleOpenFile}
          >
            {filename}
          </div>
        )}
        <div className="smtcmp-code-block-header-button-container">
          <button
            className="clickable-icon smtcmp-code-block-header-button"
            onClick={() => {
              setIsPreviewMode(!isPreviewMode)
            }}
          >
            <Eye size={12} />
            {isPreviewMode
              ? t('chat.codeBlock.showRawText', 'Show raw text')
              : t('chat.codeBlock.showFormattedText', 'Show formatted text')}
          </button>
          <button
            className="clickable-icon smtcmp-code-block-header-button"
            onClick={() => {
              void handleCopy()
            }}
          >
            {copied ? (
              <>
                <Check size={10} />
                <span>{t('chat.codeBlock.textCopied', 'Text copied')}</span>
              </>
            ) : (
              <>
                <CopyIcon size={10} />
                <span>{t('chat.codeBlock.copyText', 'Copy text')}</span>
              </>
            )}
          </button>
          <button
            className="clickable-icon smtcmp-code-block-header-button"
            onClick={
              isApplying
                ? undefined
                : () => {
                    onApply(codeContent)
                  }
            }
            aria-disabled={isApplying}
          >
            {isApplying ? (
              <>
                <Loader2 className="smtcmp-spinner" size={14} />
                <span>{t('chat.codeBlock.applying', 'Applying...')}</span>
              </>
            ) : (
              <>
                <Play size={10} />
                <span>{t('chat.codeBlock.apply', 'Apply')}</span>
              </>
            )}
          </button>
        </div>
      </div>
      {isPreviewMode ? (
        <div className="smtcmp-code-block-obsidian-markdown">
          <ObsidianMarkdown content={codeContent} scale="sm" />
        </div>
      ) : (
        <MemoizedSyntaxHighlighterWrapper
          isDarkMode={isDarkMode}
          language={language}
          hasFilename={!!filename}
          wrapLines={wrapLines}
        >
          {codeContent}
        </MemoizedSyntaxHighlighterWrapper>
      )}
    </div>
  )
}
