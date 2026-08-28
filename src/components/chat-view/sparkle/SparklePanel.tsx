import { Scope } from 'obsidian'
import React, { useEffect, useRef, useState } from 'react'

import { useApp } from '../../../contexts/app-context'
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
      {/* 设置是主视图的下一层，不是并列的另一个页签——头部图标已经用
          齿轮 ⇄ ← 这么说了，正文必须说同一件事。所以过渡用位移语汇：从右边
          推进来是「进下一层」，从左边推进来是「退回上一层」。key 换树，
          入场动画随之重放。

          位移之外不碰 opacity：淡入是「内容变了」的语汇，归相似笔记自己的
          .yolo-sparkle-section-body（换笔记时重放）。两层各说各的事，同时
          发生也不会叠成一次读不懂的双重淡入。 */}
      <div className="yolo-sparkle-view" key={view} data-view={view}>
        {view === 'settings' ? (
          <SparkleSettings onNavigateChat={onNavigateChat} />
        ) : (
          <SimilarNotesSection
            visible={visible}
            onOpenKnowledgeBaseSettings={() =>
              openPluginSettingsTab(app, plugin, 'knowledge')
            }
          />
        )}
      </div>
    </div>
  )
}

export default SparklePanel
