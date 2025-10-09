import clsx from 'clsx'
import { ChevronDown, ChevronUp, Eye } from 'lucide-react'
import { PropsWithChildren, useEffect, useMemo, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useDarkModeContext } from '../../contexts/dark-mode-context'
import { useLanguage } from '../../contexts/language-context'
import { openMarkdownFile, readTFileContent } from '../../utils/obsidian'

import { ObsidianMarkdown } from './ObsidianMarkdown'
import { MemoizedSyntaxHighlighterWrapper } from './SyntaxHighlighterWrapper'

export default function MarkdownReferenceBlock({
  filename,
  startLine,
  endLine,
  language,
}: PropsWithChildren<{
  filename: string
  startLine: number
  endLine: number
  language?: string
}>) {
  const app = useApp()
  const { isDarkMode } = useDarkModeContext()
  const { t } = useLanguage()

  const [isPreviewMode, setIsPreviewMode] = useState(true)
  const [blockContent, setBlockContent] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  const wrapLines = useMemo(() => {
    return !language || ['markdown'].includes(language)
  }, [language])

  useEffect(() => {
    async function fetchBlockContent() {
      const file = app.vault.getFileByPath(filename)
      if (!file) {
        setBlockContent(null)
        return
      }
      const fileContent = await readTFileContent(file, app.vault)
      const content = fileContent
        .split('\n')
        .slice(startLine - 1, endLine)
        .join('\n')
      setBlockContent(content)
      // default collapse when more than 2 lines
      const totalLines = content.split('\n').length
      setCollapsed(totalLines > 2)
    }

    fetchBlockContent()
  }, [filename, startLine, endLine, app.vault])

  const handleOpenFile = () => {
    openMarkdownFile(app, filename, startLine)
  }

  const lines = useMemo(
    () => (blockContent ? blockContent.split('\n') : []),
    [blockContent],
  )
  const displayContent = useMemo(
    () => (collapsed ? lines.slice(0, 3).join('\n') : (blockContent ?? '')),
    [collapsed, lines, blockContent],
  )

  const canCollapse = lines.length > 3

  return (
    blockContent && (
      <div className={clsx('smtcmp-code-block', filename && 'has-filename')}>
        <div className="smtcmp-code-block-header">
          {filename && (
            <div
              className="smtcmp-code-block-header-filename"
              onClick={handleOpenFile}
            >
              {filename}
            </div>
          )}
          <div className="smtcmp-code-block-header-button-container smtcmp-code-block-header-button-container--spaced">
            {canCollapse && (
              <button
                className="clickable-icon smtcmp-code-block-header-button"
                onClick={() => setCollapsed((v) => !v)}
              >
                {collapsed ? (
                  <>
                    <ChevronDown size={12} />
                    <span>{t('chat.showMore', 'Show more')}</span>
                  </>
                ) : (
                  <>
                    <ChevronUp size={12} />
                    <span>{t('chat.showLess', 'Show less')}</span>
                  </>
                )}
              </button>
            )}
            <button
              className="clickable-icon smtcmp-code-block-header-button"
              onClick={() => {
                setIsPreviewMode(!isPreviewMode)
              }}
            >
              <Eye size={12} />
              {isPreviewMode ? 'View Raw Text' : 'View Formatted'}
            </button>
          </div>
        </div>
        {isPreviewMode ? (
          <div className="smtcmp-code-block-obsidian-markdown">
            <ObsidianMarkdown content={displayContent} scale="sm" />
          </div>
        ) : (
          <MemoizedSyntaxHighlighterWrapper
            isDarkMode={isDarkMode}
            language={language}
            hasFilename={!!filename}
            wrapLines={wrapLines}
          >
            {displayContent}
          </MemoizedSyntaxHighlighterWrapper>
        )}
      </div>
    )
  )
}
