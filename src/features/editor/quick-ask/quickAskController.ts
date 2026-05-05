import type { Extension } from '@codemirror/state'
import { StateEffect } from '@codemirror/state'
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import type { Editor, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian'

import {
  QuickAskCapabilities,
  QuickAskOverlay,
} from '../../../components/panels/quick-ask'
import type SmartComposerPlugin from '../../../main'
import type { SmartComposerSettings } from '../../../settings/schema/setting.types'
import type { Mentionable } from '../../../types/mentionable'
import { getPdfLeafContentEl } from '../selection-chat/getPdfSelectionData'
import { pdfSelectionHighlightController } from '../selection-highlight/pdfSelectionHighlightController'
import { selectionHighlightController } from '../selection-highlight/selectionHighlightController'

import { createCmAnchor, createPdfAnchor } from './quickAsk.anchor'
import type {
  QuickAskLaunchMode,
  QuickAskSelectionScope,
  QuickAskShowOptions,
} from './quickAsk.types'

type QuickAskWidgetPayload = {
  pos: number
  options: {
    plugin: SmartComposerPlugin
    capabilities: QuickAskCapabilities
    anchor: ReturnType<typeof createCmAnchor>
    contextText: string
    fileTitle: string
    sourceFilePath?: string
    initialPrompt?: string
    initialMentionables?: Mentionable[]
    initialMode?: QuickAskLaunchMode
    initialInput?: string
    editContextText?: string
    editSelectionFrom?: { line: number; ch: number }
    selectionScope?: QuickAskSelectionScope
    selectionAnchor?: { from: number; to: number }
    autoSend?: boolean
    onClose: () => void
  }
}

type QuickAskWidgetState = {
  view: EditorView
  pos: number
  close: (restoreFocus?: boolean) => void
} | null

type QuickAskControllerDeps = {
  plugin: SmartComposerPlugin
  getSettings: () => SmartComposerSettings
  getActiveMarkdownView: () => MarkdownView | null
  getEditorView: (editor: Editor) => EditorView | null
  getActiveFileTitle: () => string
  closeSmartSpace: (restoreFocus?: boolean) => void
}

const DEFAULT_QUICK_ASK_CONTEXT_BEFORE_CHARS = 5000
const DEFAULT_QUICK_ASK_CONTEXT_AFTER_CHARS = 2000
export const QUICK_ASK_CURSOR_MARKER = '<<CURSOR>>'

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
  private pdfQuickAskInstance: {
    overlay: QuickAskOverlay
    leaf: WorkspaceLeaf
  } | null = null
  private highlightTakeoverToken = 0
  /** id of the current quickask highlight, so we can clear it on close */
  private currentHighlightId: string | null = null
  /** id of the current quickask PDF highlight, so we can clear it on close */
  private currentPdfHighlightId: string | null = null

  constructor(private readonly deps: QuickAskControllerDeps) {}

  close(restoreFocus = true) {
    // Destroy PDF instance if present
    if (this.pdfQuickAskInstance) {
      const { overlay } = this.pdfQuickAskInstance
      this.pdfQuickAskInstance = null
      overlay.destroy()
    }

    if (this.currentPdfHighlightId) {
      pdfSelectionHighlightController.clearById(this.currentPdfHighlightId)
      this.currentPdfHighlightId = null
    }

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
    this.showWithOptions(editor, view)
  }

  showWithAutoSend(
    editor: Editor,
    view: EditorView,
    options: {
      prompt: string
      mentionables?: Mentionable[]
      selectionScope?: QuickAskSelectionScope
    },
  ) {
    this.showWithOptions(editor, view, {
      initialMode: 'chat',
      autoSend: true,
      initialPrompt: options.prompt,
      initialMentionables: options.mentionables,
      selectionScope: options.selectionScope,
    })
  }

  showWithOptions(
    editor: Editor,
    view: EditorView,
    options?: QuickAskShowOptions,
  ) {
    const selection = view.state.selection.main
    const pos = selection.head
    const selectionAnchor =
      selection.empty || selection.from === selection.to
        ? undefined
        : { from: selection.from, to: selection.to }

    // Get context text around cursor with marker
    const continuationOptions = this.deps.getSettings().continuationOptions
    const beforeChars = Math.max(
      0,
      continuationOptions?.quickAskContextBeforeChars ??
        DEFAULT_QUICK_ASK_CONTEXT_BEFORE_CHARS,
    )
    const afterChars = Math.max(
      0,
      continuationOptions?.quickAskContextAfterChars ??
        DEFAULT_QUICK_ASK_CONTEXT_AFTER_CHARS,
    )
    const doc = view.state.doc
    const beforeStart = Math.max(0, pos - beforeChars)
    const afterEnd = Math.min(doc.length, pos + afterChars)
    const before = doc.sliceString(beforeStart, pos)
    const after = doc.sliceString(pos, afterEnd)
    const contextText =
      before.length > 0 || after.length > 0
        ? `${before}${QUICK_ASK_CURSOR_MARKER}${after}`
        : ''
    const fileTitle = this.deps.getActiveFileTitle()
    const sourceFilePath = this.deps.getActiveMarkdownView()?.file?.path
    const initialPrompt = options?.initialPrompt
    const initialMentionables = options?.initialMentionables
    const initialMode = options?.initialMode
    const initialInput = options?.initialInput
    const editContextText = options?.editContextText
    const editSelectionFrom = options?.editSelectionFrom
    const selectionScope = options?.selectionScope
    const autoSend = options?.autoSend

    // Close any existing Quick Ask panel (CM or PDF)
    this.close(false)
    // Also close Smart Space if open
    this.deps.closeSmartSpace(false)

    const close = (restoreFocus = true) => {
      const isCurrentView =
        !this.quickAskWidgetState || this.quickAskWidgetState.view === view

      if (isCurrentView) {
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
            initialPrompt,
            initialMentionables,
            initialMode,
            initialInput,
            editContextText,
            editSelectionFrom,
            selectionScope,
            selectionAnchor,
            autoSend,
            onClose: () => close(true),
          },
        }),
      ],
    })

    this.quickAskWidgetState = { view, pos, close }
    this.deferSelectionHighlightTakeover(view, ++this.highlightTakeoverToken)
  }

  /**
   * Launch a Quick Ask overlay from a PDF selection.
   * Bypasses the CodeMirror ViewPlugin path entirely.
   */
  showFromPdf(args: {
    leaf: WorkspaceLeaf
    range: Range
    file: TFile
    pageNumber: number
    contextText?: string
    initialMentionables?: Mentionable[]
    initialPrompt?: string
    initialMode?: QuickAskLaunchMode
    initialInput?: string
    autoSend?: boolean
  }): void {
    const hostEl = getPdfLeafContentEl(args.leaf)
    if (!hostEl) {
      // PDF leaf DOM not in expected shape — refuse to mount rather than
      // falling back to document.body (would float in wrong coordinate space).
      return
    }

    const anchor = createPdfAnchor(args.range, hostEl)
    if (!anchor.isValid()) {
      return
    }

    // Close any existing Quick Ask (CM or PDF) and Smart Space
    this.close(false)
    this.deps.closeSmartSpace(false)

    const capabilities: QuickAskCapabilities = {
      edit: false,
      editor: null,
      view: null,
    }

    const onClose = () => {
      const instance = this.pdfQuickAskInstance
      if (instance) {
        this.pdfQuickAskInstance = null
        instance.overlay.destroy()
      }
      if (this.currentPdfHighlightId) {
        pdfSelectionHighlightController.clearById(this.currentPdfHighlightId)
        this.currentPdfHighlightId = null
      }
    }

    const overlay = new QuickAskOverlay({
      plugin: this.deps.plugin,
      anchor,
      capabilities,
      contextText: args.contextText ?? '',
      fileTitle: args.file.basename,
      sourceFilePath: args.file.path,
      initialPrompt: args.initialPrompt,
      initialMentionables: args.initialMentionables,
      initialMode: args.initialMode ?? 'chat',
      initialInput: args.initialInput,
      autoSend: args.autoSend,
      onClose,
    })

    this.pdfQuickAskInstance = { overlay, leaf: args.leaf }
    overlay.mount()

    // Mirror Markdown's persistence: register a 'sync' highlight on the PDF
    // leaf so the selected range stays visually highlighted while the Quick
    // Ask floats. Cleared in close()/onClose. Gated by the same setting.
    if (
      this.deps.getSettings().continuationOptions.persistSelectionHighlight ??
      true
    ) {
      const id = `quickask:${crypto.randomUUID()}`
      this.currentPdfHighlightId = id
      pdfSelectionHighlightController.addHighlight(
        args.leaf,
        id,
        { range: args.range, pageNumber: args.pageNumber, file: args.file },
        'sync',
        'quickask',
      )
    }
  }

  /**
   * If the owning PDF leaf is no longer in the workspace, drop the lingering
   * Quick Ask instance.  Caller (SelectionChatController) drives this from
   * `layout-change`.
   */
  pruneOrphanedPdfInstance(activePdfLeaves: Set<WorkspaceLeaf>): void {
    const instance = this.pdfQuickAskInstance
    if (!instance) return
    if (!activePdfLeaves.has(instance.leaf)) {
      this.pdfQuickAskInstance = null
      instance.overlay.destroy()
    }
  }

  private deferSelectionHighlightTakeover(view: EditorView, token: number) {
    if (
      !(
        this.deps.getSettings().continuationOptions.persistSelectionHighlight ??
        true
      )
    ) {
      return
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (token !== this.highlightTakeoverToken) {
          return
        }

        const selection = view.state.selection.main
        if (
          selection.empty ||
          view.hasFocus ||
          this.quickAskWidgetState?.view !== view
        ) {
          return
        }

        const id = `quickask:${crypto.randomUUID()}`
        this.currentHighlightId = id
        selectionHighlightController.addHighlight(
          view,
          id,
          { from: selection.from, to: selection.to },
          'sync',
          'quickask',
        )
      })
    })
  }

  createTriggerExtension(): Extension {
    return [
      quickAskOverlayPlugin,
      EditorView.domEventHandlers({
        beforeinput: (event, view) => {
          // Check if Quick Ask feature is enabled (default: true)
          const enableQuickAsk =
            this.deps.getSettings().continuationOptions?.enableQuickAsk ?? true
          if (!enableQuickAsk) {
            return false
          }

          if (event.defaultPrevented) {
            return false
          }

          // Get trigger string from settings (default: @)
          const triggerStr =
            this.deps.getSettings().continuationOptions?.quickAskTrigger ?? '@'

          const inputEvent = event
          if (inputEvent.inputType !== 'insertText') {
            return false
          }
          if (inputEvent.isComposing) {
            return false
          }

          // Determine what character the user is typing
          const typedChar = inputEvent.data ?? ''

          // Only proceed if the typed character could be part of the trigger
          if (typedChar.length !== 1) {
            return false
          }

          const selection = view.state.selection.main
          if (!selection.empty) {
            return false
          }

          // Check if cursor is at an empty line or at line start
          const line = view.state.doc.lineAt(selection.head)
          const lineTextBeforeCursor = line.text.slice(
            0,
            selection.head - line.from,
          )

          // Build the potential trigger sequence: existing text + new character
          const potentialSequence = lineTextBeforeCursor + typedChar

          // Check if the potential sequence matches the trigger string
          if (potentialSequence !== triggerStr) {
            // Check if it could be a partial match (for multi-char triggers)
            if (
              triggerStr.length > 1 &&
              triggerStr.startsWith(potentialSequence)
            ) {
              // Allow the character to be typed, it might complete the trigger later
              return false
            }
            return false
          }

          const markdownView = this.deps.getActiveMarkdownView()
          const editor = markdownView?.editor
          if (!editor) {
            return false
          }

          const activeView = this.deps.getEditorView(editor)
          if (activeView && activeView !== view) {
            return false
          }

          // Prevent default input
          event.preventDefault()
          event.stopPropagation()

          // Clear the trigger characters from the line before showing panel
          if (lineTextBeforeCursor.length > 0) {
            // Delete the partial trigger that was already typed
            const deleteFrom = line.from
            const deleteTo = selection.head
            view.dispatch({
              changes: { from: deleteFrom, to: deleteTo },
              selection: { anchor: deleteFrom },
            })
          }

          // Show Quick Ask panel
          this.show(editor, view)
          return true
        },
      }),
    ]
  }
}
