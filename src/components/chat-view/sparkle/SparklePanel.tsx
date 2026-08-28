import { ArrowLeft } from 'lucide-react'
import { Scope } from 'obsidian'
import React, { useEffect, useRef, useState } from 'react'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { openPluginSettingsTab } from '../../../utils/openPluginSettingsTab'

import SimilarNotesSection from './SimilarNotesSection'
import SparkleSettings from './SparkleSettings'

export type SparkleView = 'main' | 'settings'

/**
 * The Sparkle sidebar page: writing assistance for the note you are in, with
 * its configuration one gear away (the gear lives in the chat header, which
 * owns `view`).
 */
const SparklePanel: React.FC<{
  view: SparkleView
  onBack: () => void
  onNavigateChat?: () => void
}> = ({ view, onBack, onNavigateChat }) => {
  const app = useApp()
  const plugin = usePlugin()
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  // A collapsed sidebar or hidden window keeps this component mounted, so
  // "is anyone looking at it" has to be observed, not assumed. Uses the
  // node's own window — in an Obsidian popout that is not the global one.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const ownerWindow = element.ownerDocument.defaultView
    if (!ownerWindow) return

    const observer = new ownerWindow.IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Escape leaves the settings view. Goes through Obsidian's keymap rather
  // than a React/document handler so it also works in a popout window, whose
  // key events never reach the main document.
  useEffect(() => {
    if (view !== 'settings') return
    const scope = new Scope()
    scope.register([], 'Escape', () => {
      onBack()
      return false
    })
    app.keymap.pushScope(scope)
    return () => app.keymap.popScope(scope)
  }, [app.keymap, view, onBack])

  return (
    <div className="yolo-sparkle-panel" ref={containerRef}>
      {view === 'settings' ? (
        <>
          <div className="yolo-sparkle-settings-header">
            <button
              type="button"
              className="clickable-icon"
              aria-label={t('sparkle.settings.back', 'Back')}
              onClick={onBack}
            >
              <ArrowLeft size={16} />
            </button>
            <span className="yolo-sparkle-settings-title">
              {t('sparkle.settings.title', 'Sparkle settings')}
            </span>
          </div>
          <SparkleSettings onNavigateChat={onNavigateChat} />
        </>
      ) : (
        <SimilarNotesSection
          visible={visible}
          onOpenKnowledgeBaseSettings={() =>
            openPluginSettingsTab(app, plugin, 'knowledge')
          }
        />
      )}
    </div>
  )
}

export default SparklePanel
