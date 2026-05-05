import cx from 'clsx'
import { ChevronDown, ChevronUp, Eye } from 'lucide-react'
import {
  PropsWithChildren,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useState,
} from 'react'

import { useApp } from '../../contexts/app-context'
import { useDarkModeContext } from '../../contexts/dark-mode-context'
import { useLanguage } from '../../contexts/language-context'
import {
  openMarkdownFile,
  openPdfFileAtPage,
  readTFileContent,
} from '../../utils/obsidian'

import { ObsidianMarkdown } from './ObsidianMarkdown'

// Defer react-syntax-highlighter (refractor + prism langs, ~600KB) until a
// reference block actually renders highlighted code. esbuild keeps the bytes
// in main.js but skips top-level evaluation until the dynamic import resolves.
const LazySyntaxHighlighterWrapper = lazy(() =>
  import('./SyntaxHighlighterWrapper').then((mod) => ({
    default: mod.MemoizedSyntaxHighlighterWrapper,
  })),
)

export default function MarkdownReferenceBlock({
  filename,
  startLine,
  endLine,
  language,
  previewContent,
}: PropsWithChildren<{
  filename: string
  startLine: number
  endLine: number
  language?: string
  /** For PDF references: assistant-provided excerpt (vault read is not plain text). */
  previewContent?: string
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

  const isPdf = filename.toLowerCase().endsWith('.pdf')

  useEffect(() => {
    async function fetchBlockContent() {
      if (isPdf) {
        const initial = (previewContent ?? '').trim()
        setBlockContent(
          initial.length > 0
            ? initial
            : t('chat.pdfReferenceNoPreview', '（PDF：点击标题打开对应页）'),
        )
        setCollapsed(initial.split('\n').length > 2)
        return
      }
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

    void fetchBlockContent()
  }, [filename, startLine, endLine, app.vault, isPdf, previewContent, t])

  const handleOpenFile = () => {
    if (isPdf) {
      openPdfFileAtPage(app, filename, startLine)
      return
    }
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
      <div className={cx('smtcmp-code-block', filename && 'has-filename')}>
        <div className="smtcmp-code-block-header">
          {filename && (
            <div
              className="smtcmp-code-block-header-filename"
              onClick={handleOpenFile}
            >
              {isPdf
                ? startLine === endLine
                  ? `${filename} · p.${startLine}`
                  : `${filename} · p.${startLine}–${endLine}`
                : filename}
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
              {isPreviewMode ? 'Show raw text' : 'Show formatted text'}
            </button>
          </div>
        </div>
        {isPreviewMode ? (
          <div className="smtcmp-code-block-obsidian-markdown">
            <ObsidianMarkdown content={displayContent} scale="sm" />
          </div>
        ) : (
          <Suspense
            fallback={
              <pre
                className={cx(
                  'smtcmp-syntax-highlighter',
                  filename
                    ? 'smtcmp-syntax-highlighter--with-filename'
                    : 'smtcmp-syntax-highlighter--standalone',
                  language === 'markdown'
                    ? 'smtcmp-syntax-highlighter--markdown'
                    : null,
                )}
              >
                {displayContent}
              </pre>
            }
          >
            <LazySyntaxHighlighterWrapper
              isDarkMode={isDarkMode}
              language={language}
              hasFilename={!!filename}
              wrapLines={wrapLines}
            >
              {displayContent}
            </LazySyntaxHighlighterWrapper>
          </Suspense>
        )}
      </div>
    )
  )
}
