import { MessageCircle, PenLine } from 'lucide-react'
import React, { useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'

type ViewToggleProps = {
  activeView: 'chat' | 'composer'
  onChangeView: (view: 'chat' | 'composer') => void
  showComposer?: boolean
  disabled?: boolean
}

const ViewToggle: React.FC<ViewToggleProps> = ({
  activeView,
  onChangeView,
  showComposer = true,
  disabled = false,
}) => {
  const { t } = useLanguage()
  const [hoveredView, setHoveredView] = useState<'chat' | 'composer' | null>(
    null,
  )
  const toggleRef = useRef<HTMLDivElement | null>(null)

  const chatLabel = t('sidebar.tabs.chat', 'Chat')
  const composerLabel = t('sidebar.tabs.composer', 'Composer')

  const expandedView = showComposer ? hoveredView || activeView : 'chat'
  const isActiveExpanded = expandedView === activeView

  return (
    <div
      ref={toggleRef}
      className={`yolo-view-toggle${showComposer ? '' : ' yolo-view-toggle--single'}`}
      data-expanded-view={expandedView}
      data-active-expanded={isActiveExpanded ? 'true' : 'false'}
    >
      <button
        type="button"
        className={`yolo-view-toggle-button ${
          activeView === 'chat' ? 'yolo-view-toggle-button--active' : ''
        } ${
          expandedView === 'chat' ? 'yolo-view-toggle-button--expanded' : ''
        }`}
        onClick={() => onChangeView('chat')}
        onMouseEnter={() => !disabled && setHoveredView('chat')}
        onMouseLeave={() => setHoveredView(null)}
        disabled={disabled}
        aria-pressed={activeView === 'chat'}
      >
        <span className="yolo-view-toggle-button-icon" aria-hidden="true">
          <MessageCircle size={16} strokeWidth={2} />
        </span>
        <span className="yolo-view-toggle-button-label">{chatLabel}</span>
      </button>
      {showComposer ? (
        <button
          type="button"
          className={`yolo-view-toggle-button ${
            activeView === 'composer' ? 'yolo-view-toggle-button--active' : ''
          } ${
            expandedView === 'composer'
              ? 'yolo-view-toggle-button--expanded'
              : ''
          }`}
          onClick={() => onChangeView('composer')}
          onMouseEnter={() => !disabled && setHoveredView('composer')}
          onMouseLeave={() => setHoveredView(null)}
          disabled={disabled}
          aria-pressed={activeView === 'composer'}
        >
          <span className="yolo-view-toggle-button-icon" aria-hidden="true">
            <PenLine size={16} strokeWidth={2} />
          </span>
          <span className="yolo-view-toggle-button-label">{composerLabel}</span>
        </button>
      ) : null}
      <div
        className={`yolo-view-toggle-indicator${showComposer ? '' : ' yolo-view-toggle-indicator--single'}`}
        data-active-view={activeView}
      />
    </div>
  )
}

export default ViewToggle
