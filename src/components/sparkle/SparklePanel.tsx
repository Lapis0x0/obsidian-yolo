import React, { useEffect, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { usePlugin } from '../../contexts/plugin-context'
import { openPluginSettingsTab } from '../../utils/openPluginSettingsTab'

import SimilarNotesSection from './SimilarNotesSection'

/**
 * Body of the standalone Sparkle pane: writing assistance for the note you
 * are in. Its settings live on the plugin settings page; the pane header's
 * gear (registered by `SparkleView`) jumps there.
 */
const SparklePanel: React.FC = () => {
  const app = useApp()
  const plugin = usePlugin()
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

  return (
    <div className="yolo-sparkle-panel" ref={containerRef}>
      <div className="yolo-sparkle-view">
        <SimilarNotesSection
          visible={visible}
          onOpenKnowledgeBaseSettings={() =>
            openPluginSettingsTab(app, plugin, 'knowledge')
          }
        />
      </div>
    </div>
  )
}

export default SparklePanel
