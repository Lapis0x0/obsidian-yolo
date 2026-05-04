/**
 * toolbarButton.ts
 *
 * Injects a screenshot button into the Obsidian PDF view toolbar.
 *
 * Obsidian's PDF viewer renders a toolbar containing action buttons.
 * The toolbar DOM structure is not part of the public API and may change in
 * future Obsidian releases. This module wraps all toolbar DOM access in
 * try-catch so that injection failure does not affect the command entry point.
 *
 * Observed Obsidian DOM structure (as of Obsidian 1.x):
 *   .pdf-toolbar
 *     .pdf-toolbar-left / .pdf-toolbar-right
 *       Various button elements
 *
 * We look for `.pdf-toolbar` inside each PDF leaf's container and append a
 * button to it. A MutationObserver watches for new PDF leaves being opened.
 *
 * IMPORTANT: This file contains no desktop-only imports at the top level.
 * The feature entry (index.ts) guards against mobile before calling enable().
 */

import type SmartComposerPlugin from '../../main'

const TOOLBAR_BUTTON_ATTR = 'data-yolo-pdf-screenshot-btn'

export class PdfToolbarButtonManager {
  private observer: MutationObserver | null = null

  constructor(
    private readonly plugin: SmartComposerPlugin,
    /**
     * Callback invoked when the toolbar button is clicked.
     * Should trigger the same logic as the `capture-pdf-region` command.
     */
    private readonly onButtonClick: () => void,
  ) {}

  enable(): void {
    try {
      this.plugin.app.workspace.onLayoutReady(() => {
        this.injectAll()
        this.startObserver()
      })

      this.plugin.registerEvent(
        this.plugin.app.workspace.on('active-leaf-change', () => {
          this.injectAll()
        }),
      )

      this.plugin.register(() => {
        this.disable()
      })
    } catch (error) {
      // Toolbar injection failure must never crash the plugin
      console.warn('[YOLO] PDF toolbar button injection failed:', error)
    }
  }

  disable(): void {
    this.observer?.disconnect()
    this.observer = null
    // Remove all injected buttons
    document
      .querySelectorAll(`[${TOOLBAR_BUTTON_ATTR}]`)
      .forEach((el) => el.remove())
  }

  private startObserver(): void {
    if (this.observer) return
    try {
      this.observer = new MutationObserver(() => {
        this.injectAll()
      })
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
      })
    } catch (error) {
      console.warn('[YOLO] PDF toolbar MutationObserver failed:', error)
    }
  }

  private injectAll(): void {
    try {
      const pdfLeaves = this.plugin.app.workspace.getLeavesOfType('pdf')
      for (const leaf of pdfLeaves) {
        this.injectIntoLeaf(leaf)
      }
    } catch (error) {
      console.warn('[YOLO] PDF toolbar inject scan failed:', error)
    }
  }

  private injectIntoLeaf(leaf: { view?: { containerEl?: HTMLElement } }): void {
    try {
      const containerEl = leaf.view?.containerEl
      if (!containerEl) return

      // Skip if already injected
      if (containerEl.querySelector(`[${TOOLBAR_BUTTON_ATTR}]`)) return

      // Try known toolbar selectors; Obsidian may use different class names
      // across versions. We try multiple candidates.
      const toolbar =
        containerEl.querySelector('.pdf-toolbar-right') ??
        containerEl.querySelector('.pdf-toolbar') ??
        containerEl.querySelector('.pdf-controls')

      if (!toolbar || !(toolbar instanceof HTMLElement)) return

      const btn = this.createButton()
      toolbar.appendChild(btn)
    } catch (error) {
      // Silently ignore per-leaf injection failures
      console.warn('[YOLO] PDF toolbar button inject (leaf) failed:', error)
    }
  }

  private createButton(): HTMLElement {
    const btn = document.createElement('button')
    btn.setAttribute(TOOLBAR_BUTTON_ATTR, 'true')
    btn.className = 'yolo-pdf-toolbar-btn clickable-icon'
    btn.setAttribute('aria-label', this.plugin.t('pdf.toolbarButtonTooltip'))
    btn.title = this.plugin.t('pdf.toolbarButtonTooltip')

    // Use a simple SVG scissor / crop icon
    // eslint-disable-next-line @microsoft/sdl/no-inner-html -- static SVG markup, no user input
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="3" y1="9" x2="21" y2="9"/></svg>`

    this.plugin.registerDomEvent(btn, 'click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.onButtonClick()
    })

    return btn
  }
}
