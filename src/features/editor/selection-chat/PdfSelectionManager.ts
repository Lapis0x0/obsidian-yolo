/**
 * PdfSelectionManager.ts
 *
 * Mirrors the interface of SelectionManager but targets Obsidian's PDF view.
 * Listens to document `selectionchange` events, filters to PDF-leaf selections,
 * and calls back with a PdfSelectionResult (three-state discriminated union).
 *
 * Lifecycle:
 *   1. Construct with `app` (used to reverse-look up the owning leaf from DOM).
 *   2. Call `init(callback)` to start listening.
 *   3. Call `destroy()` to remove the listener.
 */

import type { App } from 'obsidian'

import { PdfSelectionResult, getPdfSelectionData } from './getPdfSelectionData'

type PdfSelectionCallback = (result: PdfSelectionResult) => void

export class PdfSelectionManager {
  private debounceTimer: number | null = null
  private onSelectionChange: PdfSelectionCallback | null = null
  private isEnabled = true
  private debounceDelay: number
  private app: App

  constructor(
    app: App,
    options?: {
      enabled?: boolean
      debounceDelay?: number
    },
  ) {
    this.app = app
    this.isEnabled = options?.enabled ?? true
    this.debounceDelay = options?.debounceDelay ?? 300
  }

  init(callback: PdfSelectionCallback): void {
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
  }

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled
    if (!enabled) {
      this.onSelectionChange?.({ kind: 'empty' })
    }
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

    const result = getPdfSelectionData(this.app)
    this.onSelectionChange?.(result)
  }
}
