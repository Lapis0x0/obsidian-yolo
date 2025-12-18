import { EditorView, WidgetType } from '@codemirror/view'
import { Editor } from 'obsidian'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import { AppProvider } from '../../../contexts/app-context'
import { LanguageProvider } from '../../../contexts/language-context'
import { McpProvider } from '../../../contexts/mcp-context'
import { PluginProvider } from '../../../contexts/plugin-context'
import { RAGProvider } from '../../../contexts/rag-context'
import { SettingsProvider } from '../../../contexts/settings-context'
import SmartComposerPlugin from '../../../main'
import {
  clearDynamicStyleClass,
  updateDynamicStyleClass,
} from '../../../utils/dom/dynamicStyleManager'

import { QuickAskPanel } from './QuickAskPanel'

export class QuickAskWidget extends WidgetType {
  private static overlayRoot: HTMLElement | null = null
  private static currentInstance: QuickAskWidget | null = null

  private root: Root | null = null
  private overlayContainer: HTMLDivElement | null = null
  private anchor: HTMLSpanElement | null = null
  private cleanupListeners: (() => void) | null = null
  private cleanupCallbacks: (() => void)[] = []
  private overlayHost: HTMLElement | null = null
  private rafId: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private isClosing = false
  private closeAnimationTimeout: number | null = null
  private containerRef: React.RefObject<HTMLDivElement> =
    React.createRef<HTMLDivElement>()
  private hasBlockingOverlay = false
  // Drag state - when set, use fixed position instead of anchor-based
  private dragPosition: { x: number; y: number } | null = null
  // Resize state - when set, override panel size
  private resizeSize: { width: number; height: number } | null = null

  constructor(
    private readonly options: {
      plugin: SmartComposerPlugin
      editor: Editor
      view: EditorView
      contextText: string
      onClose: () => void
    },
  ) {
    super()
  }

  eq(): boolean {
    return false
  }

  toDOM(): HTMLElement {
    const anchor = document.createElement('span')
    anchor.className = 'smtcmp-quick-ask-inline-anchor'
    anchor.setAttribute('aria-hidden', 'true')
    this.anchor = anchor

    // Save current instance reference
    QuickAskWidget.currentInstance = this

    this.mountOverlay()
    this.setupGlobalListeners()
    this.schedulePositionUpdate()

    return anchor
  }

  destroy(): void {
    // Clear current instance reference
    if (QuickAskWidget.currentInstance === this) {
      QuickAskWidget.currentInstance = null
    }

    if (this.closeAnimationTimeout !== null) {
      window.clearTimeout(this.closeAnimationTimeout)
      this.closeAnimationTimeout = null
    }

    if (this.cleanupListeners) {
      this.cleanupListeners()
      this.cleanupListeners = null
    }
    for (const cleanup of this.cleanupCallbacks) {
      try {
        cleanup()
      } catch {
        // ignore cleanup errors
      }
    }
    this.cleanupCallbacks = []

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }

    this.resizeObserver?.disconnect()
    this.resizeObserver = null

    this.root?.unmount()
    this.root = null
    if (this.overlayContainer?.parentNode) {
      this.overlayContainer.parentNode.removeChild(this.overlayContainer)
    }
    if (this.overlayContainer) {
      clearDynamicStyleClass(this.overlayContainer)
    }
    this.overlayContainer = null
    const overlayRoot = QuickAskWidget.overlayRoot
    if (overlayRoot && overlayRoot.childElementCount === 0) {
      const host = overlayRoot.parentElement
      overlayRoot.remove()
      QuickAskWidget.overlayRoot = null
      host?.classList.remove('smtcmp-quick-ask-overlay-host')
    }
    this.anchor = null
  }

  private static getOverlayRoot(host: HTMLElement): HTMLElement {
    if (
      QuickAskWidget.overlayRoot &&
      QuickAskWidget.overlayRoot.parentElement !== host
    ) {
      QuickAskWidget.overlayRoot.parentElement?.classList.remove(
        'smtcmp-quick-ask-overlay-host',
      )
      QuickAskWidget.overlayRoot.remove()
      QuickAskWidget.overlayRoot = null
    }

    if (QuickAskWidget.overlayRoot) return QuickAskWidget.overlayRoot

    const root = document.createElement('div')
    root.className = 'smtcmp-quick-ask-overlay-root'
    host.appendChild(root)
    host.classList.add('smtcmp-quick-ask-overlay-host')
    QuickAskWidget.overlayRoot = root
    return root
  }

  // Static method: trigger close animation from outside
  static closeCurrentWithAnimation(): boolean {
    if (QuickAskWidget.currentInstance) {
      QuickAskWidget.currentInstance.closeWithAnimation()
      return true
    }
    return false
  }

  private closeWithAnimation = () => {
    if (this.isClosing) return
    this.isClosing = true
    this.hasBlockingOverlay = false

    // Add closing animation class
    if (this.overlayContainer) {
      this.overlayContainer.classList.add('closing')
    }

    // Wait for animation to complete before actually closing
    this.closeAnimationTimeout = window.setTimeout(() => {
      this.closeAnimationTimeout = null
      this.options.onClose()
    }, 200) // Match CSS animation duration
  }

  private mountOverlay() {
    // 将浮层挂载到编辑器 DOM 内部，使其层级/裁剪行为更接近正文内容，避免遮挡标题栏
    const overlayHost = this.options.view.dom ?? document.body
    this.overlayHost = overlayHost

    const overlayRoot = QuickAskWidget.getOverlayRoot(overlayHost)
    const overlayContainer = document.createElement('div')
    overlayContainer.className = 'smtcmp-quick-ask-overlay'
    overlayRoot.appendChild(overlayContainer)
    this.overlayContainer = overlayContainer

    this.root = createRoot(overlayContainer)
    this.root.render(
      <PluginProvider plugin={this.options.plugin}>
        <SettingsProvider
          settings={this.options.plugin.settings}
          setSettings={(newSettings) =>
            this.options.plugin.setSettings(newSettings)
          }
          addSettingsChangeListener={(listener) =>
            this.options.plugin.addSettingsChangeListener(listener)
          }
        >
          <LanguageProvider>
            <AppProvider app={this.options.plugin.app}>
              <RAGProvider
                getRAGEngine={() => this.options.plugin.getRAGEngine()}
              >
                <McpProvider
                  getMcpManager={() => this.options.plugin.getMcpManager()}
                >
                  <QuickAskPanel
                    plugin={this.options.plugin}
                    editor={this.options.editor}
                    view={this.options.view}
                    contextText={this.options.contextText}
                    onClose={this.closeWithAnimation}
                    containerRef={this.containerRef}
                    onOverlayStateChange={this.handleOverlayStateChange}
                    onDragOffset={this.handleDragOffset}
                    onResize={this.handleResize}
                  />
                </McpProvider>
              </RAGProvider>
            </AppProvider>
          </LanguageProvider>
        </SettingsProvider>
      </PluginProvider>,
    )

    const handleScroll = () => this.schedulePositionUpdate()
    window.addEventListener('scroll', handleScroll, true)
    this.cleanupCallbacks.push(() =>
      window.removeEventListener('scroll', handleScroll, true),
    )

    const handleResize = () => this.schedulePositionUpdate()
    window.addEventListener('resize', handleResize)
    this.cleanupCallbacks.push(() =>
      window.removeEventListener('resize', handleResize),
    )

    const scrollDom = this.options.view?.scrollDOM
    if (scrollDom) {
      scrollDom.addEventListener('scroll', handleScroll)
      this.cleanupCallbacks.push(() =>
        scrollDom.removeEventListener('scroll', handleScroll),
      )
    }

    this.resizeObserver = new ResizeObserver(() =>
      this.schedulePositionUpdate(),
    )
    if (scrollDom) this.resizeObserver.observe(scrollDom)
    this.resizeObserver.observe(overlayContainer)
  }

  private setupGlobalListeners() {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (this.hasBlockingOverlay) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      this.closeWithAnimation()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    this.cleanupListeners = () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      this.cleanupListeners = null
    }
  }

  private schedulePositionUpdate() {
    if (this.rafId !== null) return
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = null
      this.updateOverlayPosition()
    })
  }

  private updateOverlayPosition() {
    if (!this.overlayContainer || !this.anchor) return

    // If panel has been dragged, use drag position instead
    if (this.dragPosition) {
      this.updateDragPosition()
      return
    }

    if (!this.anchor.isConnected) {
      // Anchor not mounted yet, try again on next frame
      this.schedulePositionUpdate()
      return
    }
    const anchorRect = this.anchor.getBoundingClientRect()

    const hostRect =
      this.overlayHost?.getBoundingClientRect() ??
      document.body.getBoundingClientRect()

    const viewportWidth = hostRect.width
    const margin = 12
    const offsetY = 6

    const scrollDom = this.options.view.scrollDOM
    const scrollRect = scrollDom?.getBoundingClientRect()
    const sizer = scrollDom?.querySelector('.cm-sizer')
    const sizerRect = sizer?.getBoundingClientRect()

    const fallbackWidth = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--file-line-width',
      ) || '720',
      10,
    )

    const editorContentWidth =
      sizerRect?.width ?? scrollRect?.width ?? fallbackWidth
    const maxPanelWidth = Math.max(
      120,
      Math.min(editorContentWidth, viewportWidth - margin * 2),
    )

    const contentLeft =
      (sizerRect?.left ?? scrollRect?.left ?? hostRect.left + margin) -
      hostRect.left
    const contentRight = contentLeft + editorContentWidth

    let left = anchorRect.left - hostRect.left
    left = Math.min(left, contentRight - maxPanelWidth)
    left = Math.max(left, contentLeft)
    left = Math.min(left, viewportWidth - margin - maxPanelWidth)
    left = Math.max(left, margin)

    const top = anchorRect.bottom - hostRect.top + offsetY

    updateDynamicStyleClass(
      this.overlayContainer,
      'smtcmp-quick-ask-overlay-pos',
      {
        width: maxPanelWidth,
        left: Math.round(left),
        top: Math.round(top),
      },
    )
  }

  private handleOverlayStateChange = (isActive: boolean) => {
    this.hasBlockingOverlay = isActive
  }

  private handleDragOffset = (x: number, y: number) => {
    this.dragPosition = { x, y }
    this.updateDragPosition()
  }

  private handleResize = (width: number, height: number) => {
    this.resizeSize = { width, height }
    this.updateDragPosition() // Also update position when resizing
  }

  private updateDragPosition() {
    if (!this.overlayContainer || !this.dragPosition) return

    const hostRect =
      this.overlayHost?.getBoundingClientRect() ??
      document.body.getBoundingClientRect()

    // Get panel dimensions for width calculation
    const scrollDom = this.options.view.scrollDOM
    const scrollRect = scrollDom?.getBoundingClientRect()
    const sizer = scrollDom?.querySelector('.cm-sizer')
    const sizerRect = sizer?.getBoundingClientRect()

    const fallbackWidth = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--file-line-width',
      ) || '720',
      10,
    )

    const viewportWidth = hostRect.width
    const margin = 12

    const editorContentWidth =
      sizerRect?.width ?? scrollRect?.width ?? fallbackWidth

    // Use resized width if available, otherwise use default max width
    const panelWidth =
      this.resizeSize?.width ??
      Math.max(120, Math.min(editorContentWidth, viewportWidth - margin * 2))

    const panelHeight = this.resizeSize?.height

    updateDynamicStyleClass(
      this.overlayContainer,
      'smtcmp-quick-ask-overlay-pos',
      {
        width: panelWidth,
        ...(panelHeight ? { height: panelHeight } : {}),
        left: Math.round(this.dragPosition.x - hostRect.left),
        top: Math.round(this.dragPosition.y - hostRect.top),
      },
    )
  }
}
