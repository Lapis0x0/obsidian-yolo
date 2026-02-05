import { Editor } from 'obsidian'
import React, { useEffect, useRef, useState } from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider } from '../../contexts/language-context'
import { PluginProvider } from '../../contexts/plugin-context'
import { SettingsProvider } from '../../contexts/settings-context'
import SmartComposerPlugin from '../../main'

import type {
  SelectionActionMode,
  SelectionActionRewriteBehavior,
} from './SelectionActionsMenu'
import { SelectionActionsMenu } from './SelectionActionsMenu'
import { SelectionIndicator } from './SelectionIndicator'
import type { SelectionInfo } from './SelectionManager'

type SelectionChatWidgetProps = {
  plugin: SmartComposerPlugin
  editor: Editor
  selection: SelectionInfo
  editorContainer: HTMLElement
  onClose: () => void
  onAction: (
    actionId: string,
    selection: SelectionInfo,
    instruction: string,
    mode: SelectionActionMode,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) => void | Promise<void>
}

function SelectionChatWidgetBody({
  plugin: _plugin,
  editor: _editor,
  selection,
  editorContainer,
  onClose,
  onAction,
}: SelectionChatWidgetProps) {
  const [showMenu, setShowMenu] = useState(false)
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
    const { rect } = selection
    const containerRect = editorContainer.getBoundingClientRect()
    const offset = 8
    const isRTL = document.dir === 'rtl'

    const left = isRTL
      ? rect.left - containerRect.left - 28 - offset
      : rect.right - containerRect.left + offset
    const top = rect.bottom - containerRect.top + offset

    setIndicatorPosition({ left, top })
  }, [editorContainer, selection])

  useEffect(() => {
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
      }, 150)
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
  }, [isHoveringIndicator, isHoveringMenu])

  const handleAction = async (
    actionId: string,
    instruction: string,
    mode: SelectionActionMode,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) => {
    onClose()
    await onAction(actionId, selection, instruction, mode, rewriteBehavior)
  }

  return (
    <>
      <SelectionIndicator
        selection={selection}
        containerEl={editorContainer}
        onHoverChange={setIsHoveringIndicator}
      />
      <SelectionActionsMenu
        selection={selection}
        containerEl={editorContainer}
        indicatorPosition={indicatorPosition}
        visible={showMenu}
        onAction={handleAction}
        onHoverChange={setIsHoveringMenu}
      />
    </>
  )
}

export class SelectionChatWidget {
  private static overlayRoot: HTMLElement | null = null
  private root: Root | null = null
  private overlayContainer: HTMLDivElement | null = null
  private cleanupListeners: (() => void) | null = null
  private cleanupCallbacks: (() => void)[] = []
  private overlayHost: HTMLElement | null = null
  private currentSelection: SelectionInfo
  private scrollThrottle: number | null = null

  constructor(
    private readonly options: {
      plugin: SmartComposerPlugin
      editor: Editor
      selection: SelectionInfo
      editorContainer: HTMLElement
      onClose: () => void
      onAction: (
        actionId: string,
        selection: SelectionInfo,
        instruction: string,
        mode: SelectionActionMode,
      ) => void | Promise<void>
    },
  ) {
    this.currentSelection = options.selection
  }

  mount(): void {
    this.overlayHost = this.options.editorContainer
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
      if (this.overlayContainer?.contains(target)) return

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

    // Recompute position when the editor scrolls; close only if selection is invalid
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
    this.options.editorContainer.addEventListener('scroll', handleScroll, true)

    this.cleanupListeners = () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
      this.options.editorContainer.removeEventListener(
        'scroll',
        handleScroll,
        true,
      )
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
    if (!this.isInEditor(range.commonAncestorContainer)) {
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

  private isInEditor(node: Node): boolean {
    let current: Node | null = node
    while (current) {
      if (current === this.options.editorContainer) {
        return true
      }
      current = current.parentNode
    }
    return false
  }

  private render(): void {
    if (!this.root) return
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
              editor={this.options.editor}
              selection={this.currentSelection}
              editorContainer={this.options.editorContainer}
              onClose={this.handleClose}
              onAction={this.options.onAction}
            />
          </SettingsProvider>
        </LanguageProvider>
      </PluginProvider>,
    )
  }
}
