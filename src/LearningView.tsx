import { ItemView, WorkspaceLeaf } from 'obsidian'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import {
  type LearningUiHost,
  LearningUiHostProvider,
} from './components/learning-view/LearningUiHost'
import {
  type LearningViewPluginAdapter,
  createLearningUiHost,
} from './components/learning-view/LearningViewAdapter'
import { LearningWorkspace } from './components/learning-view/LearningWorkspace'
import { LEARNING_VIEW_TYPE } from './constants'
import { LanguageProvider } from './contexts/language-context'

/**
 * LearningView
 * ────────────
 * Independent Obsidian view that hosts the Learning Mode workspace. Modeled
 * on `src/ChatView.tsx`:
 *   - provides the Learning-specific host and language boundary
 *   - reuses the same pop-out / window-migrated / host-rebuild plumbing so
 *     the view survives moves between the main window and pop-out windows
 *
 * The React tree is intentionally thin: a single `<LearningWorkspace />`
 * owns all learning-mode state. Persistence (which project is open) lives
 * in Obsidian's per-leaf view state.
 */
export class LearningView extends ItemView {
  private root: Root | null = null
  private mountedHost: HTMLElement | null = null
  private mountedDoc: Document | null = null
  private hostObserver: MutationObserver | null = null
  private windowMigratedDisposer: (() => void) | null = null
  private rebuildScheduled = false
  private rebuildRafId: number | null = null
  private isClosed = false
  private readonly learningHost: LearningUiHost

  constructor(leaf: WorkspaceLeaf, plugin: LearningViewPluginAdapter) {
    super(leaf)
    this.learningHost = createLearningUiHost(plugin)
  }

  getViewType(): string {
    return LEARNING_VIEW_TYPE
  }

  getIcon(): string {
    return 'graduation-cap'
  }

  getDisplayText(): string {
    return this.learningHost.t('learning.wizard.modeLabel', 'Learning mode')
  }

  async onOpen(): Promise<void> {
    this.isClosed = false
    await this.render()

    // Pop-out / host rebuild handling (same three-signal pattern as ChatView).
    this.windowMigratedDisposer = this.containerEl.onWindowMigrated(() => {
      this.scheduleRebuildCheck()
    })
    this.registerEvent(
      this.learningHost.app.workspace.on('window-open', () => {
        this.scheduleRebuildCheck()
      }),
    )
    this.registerEvent(
      this.learningHost.app.workspace.on('window-close', () => {
        this.scheduleRebuildCheck()
      }),
    )
    this.registerEvent(
      this.learningHost.app.workspace.on('layout-change', () => {
        this.scheduleRebuildCheck()
      }),
    )
    this.hostObserver = new MutationObserver(() => {
      this.scheduleRebuildCheck()
    })
    this.hostObserver.observe(this.containerEl, { childList: true })
  }

  onClose(): Promise<void> {
    this.isClosed = true
    if (this.rebuildRafId !== null) {
      window.cancelAnimationFrame(this.rebuildRafId)
      this.rebuildRafId = null
    }
    this.rebuildScheduled = false
    this.hostObserver?.disconnect()
    this.hostObserver = null
    this.windowMigratedDisposer?.()
    this.windowMigratedDisposer = null
    this.root?.unmount()
    this.root = null
    this.mountedHost = null
    this.mountedDoc = null
    return Promise.resolve()
  }

  private scheduleRebuildCheck(): void {
    if (this.isClosed) return
    if (this.rebuildScheduled) return
    this.rebuildScheduled = true
    this.rebuildRafId = window.requestAnimationFrame(() => {
      this.rebuildRafId = null
      this.rebuildScheduled = false
      if (this.isClosed) return
      const expectedHost = this.containerEl.children[1] as
        | HTMLElement
        | undefined
      if (!expectedHost) return
      const hostChanged = expectedHost !== this.mountedHost
      const docChanged = expectedHost.ownerDocument !== this.mountedDoc
      if (!hostChanged && !docChanged) return
      void this.rebuild()
    })
  }

  private async rebuild(): Promise<void> {
    const newHost = this.containerEl.children[1] as HTMLElement | undefined
    if (!newHost) return
    this.root?.unmount()
    this.root = createRoot(newHost)
    this.mountedHost = newHost
    this.mountedDoc = newHost.ownerDocument
    await this.render()
  }

  render(): Promise<void> {
    if (!this.root) {
      const host = this.containerEl.children[1] as HTMLElement
      this.root = createRoot(host)
      this.mountedHost = host
      this.mountedDoc = host.ownerDocument
    }

    this.root.render(
      <LearningUiHostProvider host={this.learningHost}>
        <LanguageProvider>
          <React.StrictMode>
            <LearningWorkspace />
          </React.StrictMode>
        </LanguageProvider>
      </LearningUiHostProvider>,
    )
    return Promise.resolve()
  }
}
