import type { Extension } from '@codemirror/state'
import { StateEffect } from '@codemirror/state'
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import type { Editor, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian'

import {
  QuickAskCapabilities,
  QuickAskOverlay,
} from '../../../components/panels/quick-ask'
import type YoloPlugin from '../../../main'
import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { Mentionable } from '../../../types/mentionable'
import { getPdfLeafContentEl } from '../selection-chat/getPdfSelectionData'
import { getReadingViewRenderer } from '../selection-chat/readingViewSections'
import { pdfSelectionHighlightController } from '../selection-highlight/pdfSelectionHighlightController'
import { readingSelectionHighlightController } from '../selection-highlight/readingSelectionHighlightController'
import { selectionHighlightController } from '../selection-highlight/selectionHighlightController'

import {
  type QuickAskAnchor,
  createCmAnchor,
  createPdfAnchor,
  createReadingAnchor,
} from './quickAsk.anchor'
import { buildQuickAskContextText } from './quickAsk.context'
import { createQuickAskTriggerExtension } from './quickAsk.trigger'
import type {
  QuickAskLaunchMode,
  QuickAskSelectionScope,
  QuickAskShowOptions,
} from './quickAsk.types'

type QuickAskWidgetPayload = {
  pos: number
  options: {
    plugin: YoloPlugin
    capabilities: QuickAskCapabilities
    anchor: ReturnType<typeof createCmAnchor>
    contextText: string
    fileTitle: string
    sourceFilePath?: string
    getSurfaceContext?: () => string | Promise<string>
    initialPrompt?: string
    initialMentionables?: Mentionable[]
    initialMode?: QuickAskLaunchMode
    initialInput?: string
    selectionScope?: QuickAskSelectionScope
    isRewriteEntry?: boolean
    selectionAnchor?: { from: number; to: number }
    autoSend?: boolean
    initialAssistantId?: string
    onClose: () => void
  }
}

type QuickAskWidgetState = {
  view: EditorView
  pos: number
  close: (restoreFocus?: boolean) => void
} | null

/**
 * A selection on a rendered, non-editable surface Quick Ask can open from:
 * a PDF page or a Markdown view in reading mode.
 */
export type ReadOnlyQuickAskSource =
  | {
      kind: 'pdf'
      leaf: WorkspaceLeaf
      range: Range
      file: TFile
      pageNumber: number
    }
  | { kind: 'reading'; leaf: WorkspaceLeaf; range: Range; file: TFile }

export type ReadOnlyQuickAskArgs = {
  source: ReadOnlyQuickAskSource
  contextText?: string
  initialMentionables?: Mentionable[]
  initialPrompt?: string
  initialMode?: QuickAskLaunchMode
  initialInput?: string
  autoSend?: boolean
  initialAssistantId?: string
}

type QuickAskControllerDeps = {
  plugin: YoloPlugin
  getSettings: () => YoloSettings
  getActiveMarkdownView: () => MarkdownView | null
  getEditorView: (editor: Editor) => EditorView | null
  getActiveFileTitle: () => string
}

const quickAskWidgetEffect = StateEffect.define<QuickAskWidgetPayload | null>()

const quickAskOverlayPlugin = ViewPlugin.fromClass(
  class {
    private overlay: QuickAskOverlay | null = null
    private pos: number | null = null
    private selectionAnchor: { from: number; to: number } | null = null

    constructor(_view: EditorView) {}

    update(update: ViewUpdate) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (!effect.is(quickAskWidgetEffect)) continue
          const payload = effect.value
          if (!payload) {
            this.overlay?.destroy()
            this.overlay = null
            this.pos = null
            continue
          }
          this.overlay?.destroy()
          this.pos = payload.pos
          this.selectionAnchor = payload.options.selectionAnchor ?? null
          this.overlay = new QuickAskOverlay(payload.options)
          this.overlay.mount(payload.pos)
        }
      }

      if (this.overlay && this.pos !== null && update.docChanged) {
        this.pos = update.changes.mapPos(this.pos)
        if (this.selectionAnchor) {
          this.selectionAnchor = {
            from: update.changes.mapPos(this.selectionAnchor.from, -1),
            to: update.changes.mapPos(this.selectionAnchor.to, 1),
          }
        }
        this.overlay.updatePosition(this.pos, this.selectionAnchor)
      }
    }

    destroy() {
      this.overlay?.destroy()
      this.overlay = null
      this.pos = null
      this.selectionAnchor = null
    }
  },
)

export class QuickAskController {
  private quickAskWidgetState: QuickAskWidgetState = null
  private readOnlyQuickAskInstance: {
    overlay: QuickAskOverlay
    leaf: WorkspaceLeaf
  } | null = null
  private highlightTakeoverToken = 0
  /** id of the current quickask highlight, so we can clear it on close */
  private currentHighlightId: string | null = null
  /** Clears the current quickask highlight on a read-only surface. */
  private clearReadOnlyHighlight: (() => void) | null = null

  constructor(private readonly deps: QuickAskControllerDeps) {}

  private focusExistingQuickAsk(): boolean {
    return (
      this.quickAskWidgetState !== null && QuickAskOverlay.focusCurrentInput()
    )
  }

  close(restoreFocus = true) {
    // Destroy the read-only surface instance if present
    if (this.readOnlyQuickAskInstance) {
      const { overlay } = this.readOnlyQuickAskInstance
      this.readOnlyQuickAskInstance = null
      overlay.destroy()
    }

    this.clearReadOnlyHighlightNow()

    const state = this.quickAskWidgetState
    if (!state) {
      return
    }

    this.highlightTakeoverToken += 1
    if (this.currentHighlightId) {
      selectionHighlightController.clearById(this.currentHighlightId)
      this.currentHighlightId = null
    }

    if (!restoreFocus) {
      this.quickAskWidgetState = null
      state.view.dispatch({ effects: quickAskWidgetEffect.of(null) })
      return
    }

    // Clear state to prevent duplicate close
    this.quickAskWidgetState = null

    // Try to trigger close animation
    const hasAnimation = QuickAskOverlay.closeCurrentWithAnimation()

    if (!hasAnimation) {
      // If no animation instance, dispatch close effect directly
      state.view.dispatch({ effects: quickAskWidgetEffect.of(null) })
      state.view.focus()
    }
  }

  show(editor: Editor, view: EditorView) {
    if (this.focusExistingQuickAsk()) return

    void this.showWithOptionsAfterWarmup(editor, view, undefined, true).catch(
      (error: unknown) => {
        console.error('[YOLO] Failed to open Quick Ask:', error)
      },
    )
  }

  showWithAutoSend(
    editor: Editor,
    view: EditorView,
    options: {
      prompt: string
      mentionables?: Mentionable[]
      selectionScope?: QuickAskSelectionScope
      initialAssistantId?: string
    },
  ) {
    this.showWithOptions(editor, view, {
      initialMode: 'ask',
      autoSend: true,
      initialPrompt: options.prompt,
      initialMentionables: options.mentionables,
      selectionScope: options.selectionScope,
      initialAssistantId: options.initialAssistantId,
    })
  }

  showWithOptions(
    editor: Editor,
    view: EditorView,
    options?: QuickAskShowOptions,
  ) {
    void this.showWithOptionsAfterWarmup(editor, view, options).catch(
      (error: unknown) => {
        console.error('[YOLO] Failed to open Quick Ask:', error)
      },
    )
  }

  private async showWithOptionsAfterWarmup(
    editor: Editor,
    view: EditorView,
    options?: QuickAskShowOptions,
    focusExisting = false,
  ): Promise<void> {
    await this.deps.plugin.warmupAgentService()

    if (focusExisting && this.focusExistingQuickAsk()) return

    const selection = view.state.selection.main
    const pos = selection.head
    const selectionAnchor =
      selection.empty || selection.from === selection.to
        ? undefined
        : { from: selection.from, to: selection.to }

    // Get context text around cursor with marker
    const contextText = buildQuickAskContextText(
      view,
      pos,
      this.deps.getSettings(),
    )
    const fileTitle = this.deps.getActiveFileTitle()
    const sourceFilePath = this.deps.getActiveMarkdownView()?.file?.path
    const initialPrompt = options?.initialPrompt
    const initialMentionables = options?.initialMentionables
    const initialMode = options?.initialMode
    const initialInput = options?.initialInput
    const selectionScope = options?.selectionScope
    const isRewriteEntry = options?.isRewriteEntry
    const autoSend = options?.autoSend
    const initialAssistantId = options?.initialAssistantId
    const getSurfaceContext = options?.getSurfaceContext

    // Close any existing Quick Ask panel (CM or PDF)
    this.close(false)

    const close = (restoreFocus = true) => {
      const isCurrentView =
        !this.quickAskWidgetState || this.quickAskWidgetState.view === view

      if (isCurrentView) {
        // Owned-highlight teardown — also runs on panel-initiated close paths
        // (Escape, submit + auto-close, edit?review). controller.close() does
        // the same thing for externally-triggered closes; both paths must
        // clear the highlight, otherwise the selection stays painted (and the
        // shimmer keeps running) after the panel is gone.
        this.highlightTakeoverToken += 1
        if (this.currentHighlightId) {
          selectionHighlightController.clearById(this.currentHighlightId)
          this.currentHighlightId = null
        }
        this.clearReadOnlyHighlightNow()
        this.quickAskWidgetState = null
      }
      view.dispatch({ effects: quickAskWidgetEffect.of(null) })

      if (isCurrentView) {
        if (restoreFocus) {
          view.focus()
        }
      }
    }

    const anchor = createCmAnchor(view, pos, selectionAnchor ?? null)
    const capabilities: QuickAskCapabilities = {
      edit: true,
      editor,
      view,
    }

    view.dispatch({
      effects: [
        quickAskWidgetEffect.of(null),
        quickAskWidgetEffect.of({
          pos,
          options: {
            plugin: this.deps.plugin,
            capabilities,
            anchor,
            contextText,
            fileTitle,
            sourceFilePath,
            getSurfaceContext,
            initialPrompt,
            initialMentionables,
            initialMode,
            initialInput,
            selectionScope,
            isRewriteEntry,
            selectionAnchor,
            autoSend,
            initialAssistantId,
            onClose: () => close(true),
          },
        }),
      ],
    })

    this.quickAskWidgetState = { view, pos, close }
    this.takeOverSelectionHighlight(view, ++this.highlightTakeoverToken)
  }

  /**
   * Launch a Quick Ask overlay from a selection on a read-only surface.
   * Bypasses the CodeMirror ViewPlugin path entirely.
   */
  showFromReadOnlySelection(args: ReadOnlyQuickAskArgs): void {
    void this.showFromReadOnlySelectionAfterWarmup(args).catch(
      (error: unknown) => {
        console.error('[YOLO] Failed to open Quick Ask from selection:', error)
      },
    )
  }

  private async showFromReadOnlySelectionAfterWarmup(
    args: ReadOnlyQuickAskArgs,
  ): Promise<void> {
    await this.deps.plugin.warmupAgentService()

    const { source } = args
    // Refuse to mount when the leaf DOM is not in the expected shape rather
    // than falling back to document.body (wrong coordinate space).
    const anchor = this.createReadOnlyAnchor(source)
    if (!anchor?.isValid()) {
      return
    }

    // Close any existing Quick Ask (CM or read-only surface)
    this.close(false)

    const capabilities: QuickAskCapabilities = {
      edit: false,
      editor: null,
      view: null,
    }

    const onClose = () => {
      const instance = this.readOnlyQuickAskInstance
      if (instance) {
        this.readOnlyQuickAskInstance = null
        instance.overlay.destroy()
      }
      this.clearReadOnlyHighlightNow()
    }

    const overlay = new QuickAskOverlay({
      plugin: this.deps.plugin,
      anchor,
      capabilities,
      contextText: args.contextText ?? '',
      fileTitle: source.file.basename,
      sourceFilePath: source.file.path,
      initialPrompt: args.initialPrompt,
      initialMentionables: args.initialMentionables,
      initialMode: args.initialMode ?? 'ask',
      initialInput: args.initialInput,
      autoSend: args.autoSend,
      initialAssistantId: args.initialAssistantId,
      onClose,
    })

    this.readOnlyQuickAskInstance = { overlay, leaf: source.leaf }
    overlay.mount()

    // Mirror Markdown's persistence: register a 'sync' highlight so the
    // selected range stays visually highlighted while the Quick Ask floats.
    // Cleared in close()/onClose. Gated by the same setting.
    if (
      this.deps.getSettings().continuationOptions.persistSelectionHighlight ??
      true
    ) {
      const id = `quickask:${crypto.randomUUID()}`
      if (source.kind === 'pdf') {
        pdfSelectionHighlightController.addHighlight(
          source.leaf,
          id,
          {
            range: source.range,
            pageNumber: source.pageNumber,
            file: source.file,
          },
          'sync',
          'quickask',
        )
        this.clearReadOnlyHighlight = () =>
          pdfSelectionHighlightController.clearById(id)
      } else {
        readingSelectionHighlightController.addHighlight(
          source.leaf,
          id,
          { range: source.range, file: source.file },
          'sync',
          'quickask',
        )
        this.clearReadOnlyHighlight = () =>
          readingSelectionHighlightController.clearById(id)
      }
    }
  }

  private createReadOnlyAnchor(
    source: ReadOnlyQuickAskSource,
  ): QuickAskAnchor | null {
    if (source.kind === 'pdf') {
      const hostEl = getPdfLeafContentEl(source.leaf)
      return hostEl ? createPdfAnchor(source.range, hostEl) : null
    }
    const renderer = getReadingViewRenderer(source.leaf.view)
    if (!renderer) return null
    return createReadingAnchor(
      source.range,
      source.leaf.view.containerEl,
      renderer.previewEl,
      renderer.sizerEl,
    )
  }

  private clearReadOnlyHighlightNow(): void {
    const clear = this.clearReadOnlyHighlight
    this.clearReadOnlyHighlight = null
    clear?.()
  }

  /**
   * If the owning leaf is no longer in the workspace, drop the lingering
   * read-only Quick Ask instance. Caller (SelectionChatController) drives
   * this from `layout-change`.
   */
  pruneOrphanedReadOnlyInstance(openLeaves: Set<WorkspaceLeaf>): void {
    const instance = this.readOnlyQuickAskInstance
    if (!instance) return
    if (!openLeaves.has(instance.leaf)) {
      this.readOnlyQuickAskInstance = null
      instance.overlay.destroy()
    }
  }

  private takeOverSelectionHighlight(view: EditorView, token: number) {
    if (
      !(
        this.deps.getSettings().continuationOptions.persistSelectionHighlight ??
        true
      )
    ) {
      return
    }

    if (
      token !== this.highlightTakeoverToken ||
      this.quickAskWidgetState?.view !== view
    ) {
      return
    }

    const selection = view.state.selection.main
    if (selection.empty) return

    const id = `quickask:${crypto.randomUUID()}`
    this.currentHighlightId = id
    selectionHighlightController.addHighlight(
      view,
      id,
      { from: selection.from, to: selection.to },
      'sync',
      'quickask',
    )
  }

  /**
   * The Markdown-view route: the same trigger every surface uses, resolving
   * the editor to show on from the active Markdown view. `quickAskOverlayPlugin`
   * rides along because this route mounts the panel through a CodeMirror state
   * effect, so the overlay's lifetime follows the view it was opened on.
   */
  createTriggerExtension(): Extension {
    const resolveEditor = (view: EditorView): Editor | null => {
      const editor = this.deps.getActiveMarkdownView()?.editor
      if (!editor) return null
      const activeView = this.deps.getEditorView(editor)
      if (activeView && activeView !== view) return null
      return editor
    }

    return [
      quickAskOverlayPlugin,
      createQuickAskTriggerExtension({
        getSettings: () => this.deps.getSettings(),
        canTrigger: (view) => resolveEditor(view) !== null,
        show: (view) => {
          const editor = resolveEditor(view)
          if (!editor) return
          this.show(editor, view)
        },
      }),
    ]
  }
}
