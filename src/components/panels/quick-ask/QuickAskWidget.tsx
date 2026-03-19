import { EditorView } from '@codemirror/view'
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
import type { QuickAskSelectionScope } from '../../../features/editor/quick-ask/quickAsk.types'
import type { Mentionable } from '../../../types/mentionable'
import {
  clearDynamicStyleClass,
  updateDynamicStyleClass,
} from '../../../utils/dom/dynamicStyleManager'

import { QuickAskPanel } from './QuickAskPanel'

export class QuickAskOverlay {
  private static overlayRoot: HTMLElement | null = null
  private static currentInstance: QuickAskOverlay | null = null

  private root: Root | null = null
  private overlayContainer: HTMLDivElement | null = null
  private cleanupListeners: (() => void) | null = null
  private cleanupCallbacks: (() => void)[] = []
  private overlayHost: HTMLElement | null = null
  private rafId: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private isClosing = false
  private closeAnimationTimeout: number | null = null
  private dockAnimationTimeout: number | null = null
  private containerRef: React.RefObject<HTMLDivElement> =
    React.createRef<HTMLDivElement>()
  private hasBlockingOverlay = false
  private hasUserDragged = false
  private isDockedTopRight = false
  // Drag state - when set, use fixed position instead of anchor-based
  private dragPosition: { x: number; y: number } | null = null
  // Resize state - when set, override panel size
  private resizeSize: { width: number; height: number } | null = null
  private pos: number | null = null

  constructor(
    private readonly options: {
      plugin: SmartComposerPlugin
      editor: Editor
      view: EditorView
      contextText: string
      fileTitle: string
      sourceFilePath?: string
      initialPrompt?: string
      initialMentionables?: Mentionable[]
      initialMode?: 'ask' | 'edit' | 'edit-direct'
      initialInput?: string
      editContextText?: string
      editSelectionFrom?: { line: number; ch: number }
      selectionScope?: QuickAskSelectionScope
      autoSend?: boolean
      onClose: () => void
    },
  ) {}

  mount(pos: number): void {
    this.pos = pos
    QuickAskOverlay.currentInstance = this
    this.mountOverlay()
    this.setupGlobalListeners()
    this.schedulePositionUpdate()
  }

  destroy(): void {
    // Clear current instance reference
    if (QuickAskOverlay.currentInstance === this) {
      QuickAskOverlay.currentInstance = null
    }

    if (this.closeAnimationTimeout !== null) {
      window.clearTimeout(this.closeAnimationTimeout)
      this.closeAnimationTimeout = null
    }

    if (this.dockAnimationTimeout !== null) {
      window.clearTimeout(this.dockAnimationTimeout)
      this.dockAnimationTimeout = null
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
    const overlayRoot = QuickAskOverlay.overlayRoot
    if (overlayRoot && overlayRoot.childElementCount === 0) {
      const host = overlayRoot.parentElement
      overlayRoot.remove()
      QuickAskOverlay.overlayRoot = null
      host?.classList.remove('smtcmp-quick-ask-overlay-host')
    }
    this.pos = null
  }

  private static getOverlayRoot(host: HTMLElement): HTMLElement {
    if (
      QuickAskOverlay.overlayRoot &&
      QuickAskOverlay.overlayRoot.parentElement !== host
    ) {
      QuickAskOverlay.overlayRoot.parentElement?.classList.remove(
        'smtcmp-quick-ask-overlay-host',
      )
      QuickAskOverlay.overlayRoot.remove()
      QuickAskOverlay.overlayRoot = null
    }

    if (QuickAskOverlay.overlayRoot) return QuickAskOverlay.overlayRoot

    const root = document.createElement('div')
    root.className = 'smtcmp-quick-ask-overlay-root'
    host.appendChild(root)
    host.classList.add('smtcmp-quick-ask-overlay-host')
    QuickAskOverlay.overlayRoot = root
    return root
  }

  // Static method: trigger close animation from outside
  static closeCurrentWithAnimation(): boolean {
    if (QuickAskOverlay.currentInstance) {
      QuickAskOverlay.currentInstance.closeWithAnimation()
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
    const overlayHost = this.resolveOverlayHost()
    this.overlayHost = overlayHost

    const overlayRoot = QuickAskOverlay.getOverlayRoot(overlayHost)
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
                    fileTitle={this.options.fileTitle}
                    sourceFilePath={this.options.sourceFilePath}
                    initialPrompt={this.options.initialPrompt}
                    initialMentionables={this.options.initialMentionables}
                    initialMode={this.options.initialMode}
                    initialInput={this.options.initialInput}
                    editContextText={this.options.editContextText}
                    editSelectionFrom={this.options.editSelectionFrom}
                    selectionScope={this.options.selectionScope}
                    autoSend={this.options.autoSend}
                    onClose={this.closeWithAnimation}
                    containerRef={this.containerRef}
                    onOverlayStateChange={this.handleOverlayStateChange}
                    onDragOffset={this.handleDragOffset}
                    onResize={this.handleResize}
                    onDockToTopRight={this.handleDockToTopRight}
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

  private resolveOverlayHost(): HTMLElement {
    const viewDom = this.options.view.dom
    if (!viewDom) {
      return document.body
    }

    const workspaceRoot =
      viewDom.closest('.workspace') ?? viewDom.closest('.app-container')
    if (workspaceRoot instanceof HTMLElement) {
      return workspaceRoot
    }

    const leafContent = viewDom.closest('.workspace-leaf-content')
    if (leafContent instanceof HTMLElement) {
      return leafContent
    }

    const workspaceLeaf = viewDom.closest('.workspace-leaf')
    if (workspaceLeaf instanceof HTMLElement) {
      return workspaceLeaf
    }

    return viewDom
  }

  private getMinimumTopOffset(margin: number): number {
    return margin
  }

  private getDockReferenceRect(): DOMRect {
    const viewDom = this.options.view.dom
    const leafContent = viewDom?.closest('.workspace-leaf-content')
    if (leafContent instanceof HTMLElement) {
      return leafContent.getBoundingClientRect()
    }

    const scrollRect = this.options.view.scrollDOM?.getBoundingClientRect()
    if (scrollRect) {
      return scrollRect
    }

    const viewRect = viewDom?.getBoundingClientRect()
    if (viewRect) {
      return viewRect
    }

    return (
      this.overlayHost?.getBoundingClientRect() ??
      document.body.getBoundingClientRect()
    )
  }

  private getPanelHeight(): number | null {
    const rect = this.containerRef.current?.getBoundingClientRect()
    if (!rect || !Number.isFinite(rect.height)) return null
    if (rect.height <= 0) return null
    return rect.height
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

  updatePosition(pos?: number): void {
    if (typeof pos === 'number') {
      this.pos = pos
    }
    this.schedulePositionUpdate()
  }

  private updateOverlayPosition() {
    if (!this.overlayContainer || this.pos === null) return

    if (this.isDockedTopRight && !this.hasUserDragged) {
      this.dockToTopRight()
      return
    }

    // If panel has been dragged, use drag position instead
    if (this.dragPosition) {
      this.updateDragPosition()
      return
    }

    const anchorRect = this.options.view.coordsAtPos(this.pos)
    if (!anchorRect) {
      return
    }

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

  private handleDockToTopRight = () => {
    if (this.hasUserDragged) return
    this.isDockedTopRight = true
    this.dockToTopRight()
  }

  private handleDragOffset = (x: number, y: number) => {
    this.hasUserDragged = true
    this.isDockedTopRight = false
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

    const measuredWidth = this.getPanelWidth()

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
      measuredWidth ??
      Math.max(120, Math.min(editorContentWidth, viewportWidth - margin * 2))

    const panelHeight = this.resizeSize?.height
    const measuredHeight = this.getPanelHeight()
    const minTop = this.getMinimumTopOffset(margin)
    const minLeft = margin
    const maxLeft = Math.max(minLeft, hostRect.width - margin - panelWidth)
    const effectiveHeight = panelHeight ?? measuredHeight ?? 0
    const maxTop = Math.max(minTop, hostRect.height - margin - effectiveHeight)
    const nextLeft = Math.min(
      maxLeft,
      Math.max(minLeft, Math.round(this.dragPosition.x - hostRect.left)),
    )
    const nextTop = Math.min(
      maxTop,
      Math.max(minTop, Math.round(this.dragPosition.y - hostRect.top)),
    )

    updateDynamicStyleClass(
      this.overlayContainer,
      'smtcmp-quick-ask-overlay-pos',
      {
        width: panelWidth,
        ...(panelHeight ? { height: panelHeight } : {}),
        left: nextLeft,
        top: nextTop,
      },
    )
  }

  private dockToTopRight() {
    if (!this.overlayContainer) return

    this.startDockAnimation()

    const hostRect =
      this.overlayHost?.getBoundingClientRect() ??
      document.body.getBoundingClientRect()
    const dockRect = this.getDockReferenceRect()

    const measuredWidth = this.getPanelWidth()

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

    const panelWidth =
      this.resizeSize?.width ??
      measuredWidth ??
      Math.max(120, Math.min(editorContentWidth, viewportWidth - margin * 2))

    const left = Math.min(
      dockRect.right - margin - panelWidth,
      hostRect.right - margin - panelWidth,
    )
    const top = Math.max(
      hostRect.top + this.getMinimumTopOffset(margin),
      dockRect.top + margin,
    )

    this.dragPosition = { x: left, y: top }
    this.updateDragPosition()
  }

  private startDockAnimation() {
    if (!this.overlayContainer) return
    this.overlayContainer.classList.add('smtcmp-quick-ask-overlay--docking')

    if (this.dockAnimationTimeout !== null) {
      window.clearTimeout(this.dockAnimationTimeout)
    }

    this.dockAnimationTimeout = window.setTimeout(() => {
      this.dockAnimationTimeout = null
      this.overlayContainer?.classList.remove(
        'smtcmp-quick-ask-overlay--docking',
      )
    }, 220)
  }

  private getPanelWidth(): number | null {
    const rect = this.containerRef.current?.getBoundingClientRect()
    if (!rect || !Number.isFinite(rect.width)) return null
    if (rect.width <= 0) return null
    return rect.width
  }
}
