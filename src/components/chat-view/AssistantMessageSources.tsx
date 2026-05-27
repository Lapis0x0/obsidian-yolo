import { ChevronDown, ChevronUp } from 'lucide-react'
import { memo, useCallback, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { CitationSource } from '../../core/agent/citationRegistry'
import { openMarkdownFile, openPdfFileAtPage } from '../../utils/obsidian'

const SNIPPET_PREVIEW_MAX = 120

function formatLineRange(source: CitationSource): string {
  if (source.startLine === source.endLine) {
    return `L${source.startLine}`
  }
  return `L${source.startLine}-${source.endLine}`
}

function formatSimilarity(value: number | undefined): string | null {
  if (value === undefined || Number.isNaN(value)) {
    return null
  }
  return `${(value * 100).toFixed(0)}%`
}

const AssistantMessageSources = memo(function AssistantMessageSources({
  sources,
}: {
  sources: CitationSource[]
}) {
  const app = useApp()
  const { t } = useLanguage()
  const [isExpanded, setIsExpanded] = useState(false)

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev)
  }, [])

  if (sources.length === 0) {
    return null
  }

  const label = t('chat.vaultSources', 'Vault sources ({count})').replace(
    '{count}',
    String(sources.length),
  )

  return (
    <div
      className={`yolo-assistant-message-metadata${
        isExpanded ? ' is-expanded' : ''
      }`}
    >
      <button
        type="button"
        className="yolo-assistant-message-metadata-toggle"
        onClick={handleToggle}
      >
        <span>{label}</span>
        {isExpanded ? (
          <ChevronUp className="yolo-assistant-message-metadata-toggle-icon" />
        ) : (
          <ChevronDown className="yolo-assistant-message-metadata-toggle-icon" />
        )}
      </button>
      {isExpanded && (
        <div className="yolo-assistant-message-metadata-content">
          <div className="yolo-assistant-message-metadata-annotations">
            {sources.map((source) => {
              const similarity = formatSimilarity(source.similarity)
              const snippetPreview = source.snippet
                ? source.snippet.length > SNIPPET_PREVIEW_MAX
                  ? `${source.snippet.slice(0, SNIPPET_PREVIEW_MAX)}…`
                  : source.snippet
                : ''
              const lineRange = formatLineRange(source)
              return (
                <div key={source.ordinal}>
                  <span className="yolo-url-citation-text">
                    [{source.ordinal}]{' '}
                    <a
                      href="#"
                      onClick={(event) => {
                        event.preventDefault()
                        if (
                          source.path.toLowerCase().endsWith('.pdf') &&
                          source.page != null
                        ) {
                          openPdfFileAtPage(app, source.path, source.page)
                          return
                        }
                        openMarkdownFile(app, source.path, source.startLine)
                      }}
                    >
                      {source.path} {lineRange}
                    </a>
                    {similarity ? ` · ${similarity}` : ''}
                  </span>
                  {snippetPreview ? (
                    <div className="yolo-vault-source-snippet">
                      {snippetPreview}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})

export default AssistantMessageSources
