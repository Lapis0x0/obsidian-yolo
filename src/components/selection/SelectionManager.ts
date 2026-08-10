import { Editor } from 'obsidian'

import {
  getSelectionVisualLineRects,
  trimRangeEndWhitespace,
} from './selectionRangeGeometry'

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

type RangeSnapshot = {
  startContainer: Node
  startOffset: number
  endContainer: Node
  endOffset: number
}

export class SelectionManager {
  private debounceTimer: number | null = null
  private currentSelection: SelectionInfo | null = null
  private lastRangeSnapshot: RangeSnapshot | null = null
  private onSelectionChange:
    | ((selection: SelectionInfo | null) => void)
    | null = null
  private isEnabled = true
  private minSelectionLength = 6
  private debounceDelay = 150
  private editorContainer: HTMLElement | null = null
  private readonly ownerDocument: Document
  private readonly ownerWindow: Window

  constructor(
    editorContainer: HTMLElement,
    options?: {
      enabled?: boolean
      minSelectionLength?: number
      debounceDelay?: number
    },
  ) {
    this.editorContainer = editorContainer
    this.ownerDocument = editorContainer.ownerDocument
    this.ownerWindow = this.ownerDocument.defaultView ?? window
    if (options) {
      this.isEnabled = options.enabled ?? true
      this.minSelectionLength = options.minSelectionLength ?? 6
      this.debounceDelay = options.debounceDelay ?? 300
    }
  }

  init(callback: (selection: SelectionInfo | null) => void): void {
    this.onSelectionChange = callback
    this.ownerDocument.addEventListener(
      'selectionchange',
      this.handleSelectionChange,
    )
  }

  destroy(): void {
    if (this.debounceTimer !== null) {
      this.ownerWindow.clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.ownerDocument.removeEventListener(
      'selectionchange',
      this.handleSelectionChange,
    )
    this.onSelectionChange = null
    this.currentSelection = null
    this.lastRangeSnapshot = null
  }

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled
    if (!enabled) {
      this.clearSelection()
    }
  }

  clearSelection(): void {
    this.currentSelection = null
    this.lastRangeSnapshot = null
    this.onSelectionChange?.call(null, null)
  }

  getCurrentSelection(): SelectionInfo | null {
    return this.currentSelection
  }

  private handleSelectionChange = (): void => {
    if (this.debounceTimer !== null) {
      this.ownerWindow.clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = this.ownerWindow.setTimeout(() => {
      this.debounceTimer = null
      this.processSelection()
    }, this.debounceDelay)
  }

  private processSelection(): void {
    if (!this.isEnabled) {
      return
    }

    const selection = this.ownerWindow.getSelection()
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

      // Echo guard: if the new range is semantically identical to the last
      // forwarded selection, skip the callback. This prevents highlight
      // decorations (or other sync side-effects) from re-triggering a
      // selectionchange echo that would cause widget flicker.
      // We compare against an immutable snapshot, not a live Range — the
      // browser may sync a stored Range to new endpoints, which would
      // produce false positives.
      const prev = this.lastRangeSnapshot
      if (
        prev &&
        range.startContainer === prev.startContainer &&
        range.startOffset === prev.startOffset &&
        range.endContainer === prev.endContainer &&
        range.endOffset === prev.endOffset
      ) {
        return
      }

      const effectiveRange = trimRangeEndWhitespace(range)
      const rects = getSelectionVisualLineRects(effectiveRange)

      if (rects.length === 0) {
        this.clearSelection()
        return
      }

      // Use the last line's rect for multi-line selections
      const rect = rects[rects.length - 1]
      const isMultiLine = rects.length > 1 || text.includes('\n')

      this.currentSelection = {
        text,
        range: effectiveRange,
        rect,
        isMultiLine,
      }
      this.lastRangeSnapshot = {
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
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
            '.yolo-quick-ask-overlay-root, .yolo-quick-ask-overlay',
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
