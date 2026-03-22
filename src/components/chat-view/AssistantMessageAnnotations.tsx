import { ChevronDown, ChevronUp } from 'lucide-react'
import { memo, useRef, useState } from 'react'

import { Annotation } from '../../types/llm/response'

const AssistantMessageAnnotations = memo(function AssistantMessageAnnotations({
  annotations,
}: {
  annotations: Annotation[]
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const hasUserInteracted = useRef(false)

  const handleToggle = () => {
    hasUserInteracted.current = true
    setIsExpanded(!isExpanded)
  }

  return (
    <div
      className={`smtcmp-assistant-message-metadata${
        isExpanded ? ' is-expanded' : ''
      }`}
    >
      <button
        type="button"
        className="smtcmp-assistant-message-metadata-toggle"
        onClick={handleToggle}
      >
        <span>View Sources ({annotations.length})</span>
        {isExpanded ? (
          <ChevronUp className="smtcmp-assistant-message-metadata-toggle-icon" />
        ) : (
          <ChevronDown className="smtcmp-assistant-message-metadata-toggle-icon" />
        )}
      </button>
      {isExpanded && (
        <div className="smtcmp-assistant-message-metadata-content">
          <div className="smtcmp-assistant-message-metadata-annotations">
            {annotations.map((annotation, index) => {
              return (
                <div key={annotation.url_citation.url}>
                  <span className="smtcmp-url-citation-text">
                    [{index + 1}]{' '}
                    <a
                      href={annotation.url_citation.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {annotation.url_citation.title ??
                        annotation.url_citation.url}
                    </a>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})

export default AssistantMessageAnnotations
