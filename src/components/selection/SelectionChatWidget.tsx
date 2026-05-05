import { Editor, Platform } from 'obsidian'
import { useEffect, useRef, useState } from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider } from '../../contexts/language-context'
import { PluginProvider } from '../../contexts/plugin-context'
import { SettingsProvider } from '../../contexts/settings-context'
import type { PdfSelectionResult } from '../../features/editor/selection-chat/getPdfSelectionData'
import SmartComposerPlugin from '../../main'

import type {
  SelectionActionMode,
  SelectionActionRewriteBehavior,
} from './SelectionActionsMenu'
import { SelectionActionsMenu } from './SelectionActionsMenu'
import { SelectionIndicator, getIndicatorPosition } from './SelectionIndicator'
import type { SelectionInfo } from './SelectionManager'

// ─── Discriminated union for widget options ──────────────────────────────────

type MarkdownWidgetOptions = {
  source: 'markdown'
  plugin: SmartComposerPlugin
  editor: Editor
  selection: SelectionInfo
  /** The .cm-editor element — used as host and for scroll listeners. */
  hostEl: HTMLElement
  onClose: () => void
  onAction: (
    actionId: string,
    selection: SelectionInfo,
    instruction: string,
    mode: SelectionActionMode,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) => void | Promise<void>
}

type PdfWidgetOptions = {
  source: 'pdf'
  plugin: SmartComposerPlugin
  selection: SelectionInfo
  pdfData: Extract<PdfSelectionResult, { kind: 'data' }>
  /** The PDF leaf content element — used as host and for scroll listeners. */
  hostEl: HTMLElement
  onClose: () => void
  onAction: (
    actionId: string,
    instruction: string,
    mode: SelectionActionMode,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) => void | Promise<void>
}

type SelectionChatWidgetOptions = MarkdownWidgetOptions | PdfWidgetOptions

// ─── Body component (source-agnostic) ───────────────────────────────────────

type SelectionChatWidgetBodyProps = {
  plugin: SmartComposerPlugin
  selection: SelectionInfo
  hostEl: HTMLElement
  source: 'markdown' | 'pdf'
  onClose: () => void
  onAction: (
    actionId: string,
    instruction: string,
    mode: SelectionActionMode,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) => void | Promise<void>
}

function SelectionChatWidgetBody({
  plugin: _plugin,
  selection,
  hostEl,
  source,
  onClose,
  onAction,
}: SelectionChatWidgetBodyProps) {
  const isMobile = !Platform.isDesktop
  const [showMenu, setShowMenu] = useState(false)
  const [menuPinned, setMenuPinned] = useState(false)
  const [isHoveringIndicator, setIsHoveringIndicator] = useState(false)
  const [isHoveringMenu, setIsHoveringMenu] = useState(false)
  const hideTimeoutRef = useRef<number | null>(null)
  const showTimeoutRef = useRef<number | null>(null)
  const [indicatorPosition, setIndicatorPosition] = useState({
    left: 0,
    top: 0,
  })

  useEffect(() => {
    // Calculate indicator position for menu positioning
    setIndicatorPosition(getIndicatorPosition(selection, hostEl, 8))
  }, [hostEl, selection])

  useEffect(() => {
    if (isMobile && menuPinned) {
      setShowMenu(true)
      return
    }

    const isHovering = isHoveringIndicator || isHoveringMenu

    if (hideTimeoutRef.current !== null) {
      window.clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }

    if (showTimeoutRef.current !== null) {
      window.clearTimeout(showTimeoutRef.current)
      showTimeoutRef.current = null
    }

    if (isHovering) {
      // Show menu after a short delay when hovering
      showTimeoutRef.current = window.setTimeout(() => {
        setShowMenu(true)
        showTimeoutRef.current = null
      }, 80)
    } else {
      // Hide menu after a delay when not hovering
      hideTimeoutRef.current = window.setTimeout(() => {
        setShowMenu(false)
        hideTimeoutRef.current = null
      }, 300)
    }

    return () => {
      if (hideTimeoutRef.current !== null) {
        window.clearTimeout(hideTimeoutRef.current)
      }
      if (showTimeoutRef.current !== null) {
        window.clearTimeout(showTimeoutRef.current)
      }
    }
  }, [isHoveringIndicator, isHoveringMenu, isMobile, menuPinned])

  const handleAction = async (
    actionId: string,
    instruction: string,
    mode: SelectionActionMode,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) => {
    onClose()
    await onAction(actionId, instruction, mode, rewriteBehavior)
  }

  const handleIndicatorPress = () => {
    if (!isMobile) {
      return
    }
    setMenuPinned((current) => {
      const next = !current
      setShowMenu(next)
      return next
    })
  }

  return (
    <>
      <SelectionIndicator
        selection={selection}
        containerEl={hostEl}
        onHoverChange={setIsHoveringIndicator}
        onPress={isMobile ? handleIndicatorPress : undefined}
      />
      <SelectionActionsMenu
        selection={selection}
        containerEl={hostEl}
        indicatorPosition={indicatorPosition}
        visible={showMenu || (isMobile && menuPinned)}
        onAction={handleAction}
        onHoverChange={setIsHoveringMenu}
        source={source}
      />
    </>
  )
}

// ─── Widget class ─────────────────────────────────────────────────────────────

export class SelectionChatWidget {
  private static overlayRoot: HTMLElement | null = null
  private static readonly INTERACTION_GUARD_MS = 750
  private readonly isMobile = !Platform.isDesktop
  private root: Root | null = null
  private overlayContainer: HTMLDivElement | null = null
  private cleanupListeners: (() => void) | null = null
  private cleanupCallbacks: (() => void)[] = []
  private overlayHost: HTMLElement | null = null
  private currentSelection: SelectionInfo
  private scrollThrottle: number | null = null
  private preserveUntil = 0

  constructor(private readonly options: SelectionChatWidgetOptions) {
    this.currentSelection = options.selection
  }

  mount(): void {
    this.overlayHost = this.options.hostEl
    const overlayRoot = SelectionChatWidget.getOverlayRoot(this.overlayHost)
    const overlayContainer = document.createElement('div')
    overlayContainer.className = 'smtcmp-selection-chat-overlay'
    overlayRoot.appendChild(overlayContainer)
    this.overlayContainer = overlayContainer

    this.root = createRoot(overlayContainer)
    this.render()

    this.setupGlobalListeners()
  }

  destroy(): void {
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

    this.root?.unmount()
    this.root = null
    if (this.overlayContainer?.parentNode) {
      this.overlayContainer.parentNode.removeChild(this.overlayContainer)
    }
    this.overlayContainer = null

    const overlayRoot = SelectionChatWidget.overlayRoot
    if (overlayRoot && overlayRoot.childElementCount === 0) {
      const host = overlayRoot.parentElement
      overlayRoot.remove()
      SelectionChatWidget.overlayRoot = null
      host?.classList.remove('smtcmp-selection-chat-overlay-host')
    }

    if (this.scrollThrottle !== null) {
      window.clearTimeout(this.scrollThrottle)
      this.scrollThrottle = null
    }
  }

  shouldPreserveOnSelectionLoss(): boolean {
    return this.isMobile && Date.now() < this.preserveUntil
  }

  private static getOverlayRoot(host: HTMLElement): HTMLElement {
    if (
      SelectionChatWidget.overlayRoot &&
      SelectionChatWidget.overlayRoot.parentElement !== host
    ) {
      SelectionChatWidget.overlayRoot.parentElement?.classList.remove(
        'smtcmp-selection-chat-overlay-host',
      )
      SelectionChatWidget.overlayRoot.remove()
      SelectionChatWidget.overlayRoot = null
    }

    if (SelectionChatWidget.overlayRoot) return SelectionChatWidget.overlayRoot

    const root = document.createElement('div')
    root.className = 'smtcmp-selection-chat-overlay-root'
    host.appendChild(root)
    host.classList.add('smtcmp-selection-chat-overlay-host')
    SelectionChatWidget.overlayRoot = root
    return root
  }

  private handleClose = () => {
    this.options.onClose()
  }

  private setupGlobalListeners(): void {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return

      const isInsideOverlay = this.overlayContainer?.contains(target) ?? false
      if (isInsideOverlay) {
        if (this.isMobile) {
          this.preserveUntil =
            Date.now() + SelectionChatWidget.INTERACTION_GUARD_MS
        }
        return
      }

      // Close if clicking outside
      this.handleClose()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        this.handleClose()
      }
    }

    // Recompute position when the host scrolls; close only if selection is invalid
    const handleScroll = () => {
      if (this.scrollThrottle !== null) {
        return
      }
      this.scrollThrottle = window.setTimeout(() => {
        this.scrollThrottle = null
        this.refreshSelectionPosition()
      }, 80)
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    this.options.hostEl.addEventListener('scroll', handleScroll, true)

    this.cleanupListeners = () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
      this.options.hostEl.removeEventListener('scroll', handleScroll, true)
      this.cleanupListeners = null
    }
  }

  private refreshSelectionPosition(): void {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) {
      this.handleClose()
      return
    }

    const range = selection.getRangeAt(0)
    if (!this.isInsideHost(range.commonAncestorContainer)) {
      this.handleClose()
      return
    }

    const rects = range.getClientRects()
    const text = selection.toString().trim()
    if (!rects.length || !text) {
      this.handleClose()
      return
    }

    const rect = rects[rects.length - 1]
    const isMultiLine = rects.length > 1 || text.includes('\n')

    this.currentSelection = {
      text,
      range,
      rect,
      isMultiLine,
    }
    this.render()
  }

  private isInsideHost(node: Node): boolean {
    let current: Node | null = node
    while (current) {
      if (current === this.options.hostEl) {
        return true
      }
      current = current.parentNode
    }
    return false
  }

  private buildOnAction(): (
    actionId: string,
    instruction: string,
    mode: SelectionActionMode,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) => void | Promise<void> {
    const opts = this.options
    if (opts.source === 'markdown') {
      // For markdown, we pass the selection to the onAction callback
      return (actionId, instruction, mode, rewriteBehavior) =>
        opts.onAction(
          actionId,
          this.currentSelection,
          instruction,
          mode,
          rewriteBehavior,
        )
    }
    // For PDF, onAction doesn't need selection (it's already captured in pdfData)
    return opts.onAction
  }

  private render(): void {
    if (!this.root) return
    const onAction = this.buildOnAction()
    this.root.render(
      <PluginProvider plugin={this.options.plugin}>
        <LanguageProvider>
          <SettingsProvider
            settings={this.options.plugin.settings}
            setSettings={(newSettings) =>
              this.options.plugin.setSettings(newSettings)
            }
            addSettingsChangeListener={(listener) =>
              this.options.plugin.addSettingsChangeListener(listener)
            }
          >
            <SelectionChatWidgetBody
              plugin={this.options.plugin}
              selection={this.currentSelection}
              hostEl={this.options.hostEl}
              source={this.options.source}
              onClose={this.handleClose}
              onAction={onAction}
            />
          </SettingsProvider>
        </LanguageProvider>
      </PluginProvider>,
    )
  }
}
