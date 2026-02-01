import { Editor } from 'obsidian'

export type SelectionInfo = {
  text: string
  range: Range
  rect: DOMRect
  isMultiLine: boolean
}

export type SelectionAction = {
  id: string
  label: string
  icon: string
  handler: (selection: SelectionInfo, editor: Editor) => void | Promise<void>
}

export class SelectionManager {
  private debounceTimer: number | null = null
  private currentSelection: SelectionInfo | null = null
  private onSelectionChange:
    | ((selection: SelectionInfo | null) => void)
    | null = null
  private isEnabled = true
  private minSelectionLength = 6
  private debounceDelay = 150
  private editorContainer: HTMLElement | null = null

  constructor(
    editorContainer: HTMLElement,
    options?: {
      enabled?: boolean
      minSelectionLength?: number
      debounceDelay?: number
    },
  ) {
    this.editorContainer = editorContainer
    if (options) {
      this.isEnabled = options.enabled ?? true
      this.minSelectionLength = options.minSelectionLength ?? 6
      this.debounceDelay = options.debounceDelay ?? 300
    }
  }

  init(callback: (selection: SelectionInfo | null) => void): void {
    this.onSelectionChange = callback
    document.addEventListener('selectionchange', this.handleSelectionChange)
  }

  destroy(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    document.removeEventListener('selectionchange', this.handleSelectionChange)
    this.onSelectionChange = null
    this.currentSelection = null
  }

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled
    if (!enabled) {
      this.clearSelection()
    }
  }

  clearSelection(): void {
    this.currentSelection = null
    this.onSelectionChange?.call(null, null)
  }

  getCurrentSelection(): SelectionInfo | null {
    return this.currentSelection
  }

  private handleSelectionChange = (): void => {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null
      this.processSelection()
    }, this.debounceDelay)
  }

  private processSelection(): void {
    if (!this.isEnabled) {
      return
    }

    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) {
      this.clearSelection()
      return
    }

    const text = selection.toString().trim()

    // Check minimum length
    if (!this.shouldShowIndicator(text, selection)) {
      this.clearSelection()
      return
    }

    try {
      const range = selection.getRangeAt(0)
      const rects = range.getClientRects()

      if (rects.length === 0) {
        this.clearSelection()
        return
      }

      // Use the last line's rect for multi-line selections
      const rect = rects[rects.length - 1]
      const isMultiLine = rects.length > 1 || text.includes('\n')

      this.currentSelection = {
        text,
        range,
        rect,
        isMultiLine,
      }

      this.onSelectionChange?.call(null, this.currentSelection)
    } catch (error) {
      console.error('Error processing selection:', error)
      this.clearSelection()
    }
  }

  private shouldShowIndicator(text: string, selection: Selection): boolean {
    // Check text length
    if (!text || text.length < this.minSelectionLength) {
      return false
    }

    // Check if selection is within the editor
    try {
      const range = selection.getRangeAt(0)
      const container = range.commonAncestorContainer
      return this.isInEditor(container)
    } catch {
      return false
    }
  }

  private isInEditor(node: Node): boolean {
    if (!this.editorContainer) {
      return false
    }

    let current: Node | null = node
    while (current) {
      if (current instanceof HTMLElement) {
        if (
          current.closest(
            '.smtcmp-quick-ask-overlay-root, .smtcmp-quick-ask-overlay',
          )
        ) {
          return false
        }
      }
      if (current === this.editorContainer) {
        return true
      }
      current = current.parentNode
    }
    return false
  }

  updateOptions(options: {
    enabled?: boolean
    minSelectionLength?: number
    debounceDelay?: number
  }): void {
    if (options.enabled !== undefined) {
      this.isEnabled = options.enabled
      if (!this.isEnabled) {
        this.clearSelection()
      }
    }
    if (options.minSelectionLength !== undefined) {
      this.minSelectionLength = options.minSelectionLength
    }
    if (options.debounceDelay !== undefined) {
      this.debounceDelay = options.debounceDelay
    }
  }
}
