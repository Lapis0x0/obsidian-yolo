import { EditorView } from '@codemirror/view'
import {
  App,
  Editor,
  type EventRef,
  MarkdownView,
  Notice,
  type WorkspaceLeaf,
} from 'obsidian'

import { ChatView } from '../../../ChatView'
import type {
  SelectionActionMode,
  SelectionActionRewriteBehavior,
} from '../../../components/selection/SelectionActionsMenu'
import { SelectionChatWidget } from '../../../components/selection/SelectionChatWidget'
import {
  SelectionInfo,
  SelectionManager,
} from '../../../components/selection/SelectionManager'
import type SmartComposerPlugin from '../../../main'
import { SmartComposerSettings } from '../../../settings/schema/setting.types'
import type {
  Mentionable,
  MentionableBlock,
  MentionableBlockData,
} from '../../../types/mentionable'
import { getMentionableBlockData } from '../../../utils/obsidian'
import type { QuickAskSelectionScope } from '../quick-ask/quickAsk.types'
import type { QuickAskLaunchMode } from '../quick-ask/quickAsk.types'
import { pdfSelectionHighlightController } from '../selection-highlight/pdfSelectionHighlightController'
import { selectionHighlightController } from '../selection-highlight/selectionHighlightController'

import type { PdfSelectionResult } from './getPdfSelectionData'
import { getPdfLeafContentEl } from './getPdfSelectionData'
import { PdfSelectionManager } from './PdfSelectionManager'

export type PendingSelectionRewrite = {
  editor: Editor
  selectedText: string
  from: { line: number; ch: number }
  to: { line: number; ch: number }
}

type SelectionChatControllerDeps = {
  plugin: SmartComposerPlugin
  app: App
  getSettings: () => SmartComposerSettings
  t: (key: string, fallback?: string) => string
  getEditorView: (editor: Editor) => EditorView | null
  showQuickAskWithOptions: (
    editor: Editor,
    view: EditorView,
    options: {
      initialPrompt?: string
      initialMentionables?: Mentionable[]
      initialMode?: QuickAskLaunchMode
      initialInput?: string
      editContextText?: string
      editSelectionFrom?: { line: number; ch: number }
      selectionScope?: QuickAskSelectionScope
      autoSend?: boolean
    },
  ) => void
  showQuickAskWithAutoSend: (
    editor: Editor,
    view: EditorView,
    options: {
      prompt: string
      mentionables: Mentionable[]
      selectionScope?: QuickAskSelectionScope
    },
  ) => void
  /**
   * Show a Quick Ask overlay from a PDF selection.
   * Does not require an editor — handles anchor and context internally.
   */
  showQuickAskFromPdf: (args: {
    leaf: WorkspaceLeaf
    range: Range
    file: import('obsidian').TFile
    pageNumber: number
    initialMentionables?: Mentionable[]
    initialPrompt?: string
    initialMode?: QuickAskLaunchMode
    autoSend?: boolean
  }) => void
  /**
   * Drop any PDF Quick Ask instance whose owning leaf is no longer in
   * `activePdfLeaves`.  Called from `layout-change` to avoid orphan overlays.
   */
  pruneOrphanedQuickAskPdfInstance: (
    activePdfLeaves: Set<WorkspaceLeaf>,
  ) => void
  openChatWithSelectionAndPrefill: (
    selectedBlock: MentionableBlockData,
    text: string,
  ) => Promise<void>
  addSelectionToSidebarChat: (
    selectedBlock: MentionableBlockData,
  ) => Promise<void>
  openChatWithSelectionAndSend: (
    selectedBlock: MentionableBlockData,
    text: string,
  ) => Promise<void>
  isSmartSpaceOpen: () => boolean
}

export class SelectionChatController {
  private readonly plugin: SmartComposerPlugin
  private readonly app: App
  private readonly getSettings: () => SmartComposerSettings
  private readonly t: (key: string, fallback?: string) => string
  private readonly getEditorView: (editor: Editor) => EditorView | null
  private readonly showQuickAskWithOptions: (
    editor: Editor,
    view: EditorView,
    options: {
      initialPrompt?: string
      initialMentionables?: Mentionable[]
      initialMode?: QuickAskLaunchMode
      initialInput?: string
      editContextText?: string
      editSelectionFrom?: { line: number; ch: number }
      selectionScope?: QuickAskSelectionScope
      autoSend?: boolean
    },
  ) => void
  private readonly showQuickAskWithAutoSend: (
    editor: Editor,
    view: EditorView,
    options: {
      prompt: string
      mentionables: Mentionable[]
      selectionScope?: QuickAskSelectionScope
    },
  ) => void
  private readonly showQuickAskFromPdf: SelectionChatControllerDeps['showQuickAskFromPdf']
  private readonly pruneOrphanedQuickAskPdfInstance: SelectionChatControllerDeps['pruneOrphanedQuickAskPdfInstance']
  private readonly openChatWithSelectionAndPrefill: (
    selectedBlock: MentionableBlockData,
    text: string,
  ) => Promise<void>
  private readonly addSelectionToSidebarChat: (
    selectedBlock: MentionableBlockData,
  ) => Promise<void>
  private readonly openChatWithSelectionAndSend: (
    selectedBlock: MentionableBlockData,
    text: string,
  ) => Promise<void>
  private readonly isSmartSpaceOpen: () => boolean

  private selectionManager: SelectionManager | null = null
  private pdfSelectionManager: PdfSelectionManager | null = null
  /**
   * Single shared widget instance (markdown or pdf source).
   * Only one widget can exist at a time because SelectionChatWidget uses a
   * static overlayRoot; concurrent widgets would corrupt each other's DOM.
   */
  private selectionChatWidget: SelectionChatWidget | null = null
  /**
   * The PDF leaf the current `selectionChatWidget` belongs to, when its source
   * is `'pdf'`.  Used by `layout-change` to drop the widget if the leaf was
   * closed.  Always null when the widget's source is `'markdown'`.
   */
  private currentWidgetPdfLeaf: WorkspaceLeaf | null = null
  /**
   * Stable identity of the most recent PDF selection we've synced to chat
   * (file + page + content).  Used to skip the addHighlight + sync + remount
   * cycle when PdfSelectionManager re-fires for the same logical selection,
   * which would otherwise leave the chat mention pointing at a stale
   * highlight id and cause the highlight to disappear on next reconcile.
   */
  private lastSyncedPdfKey: string | null = null
  private pendingSelectionRewrite: PendingSelectionRewrite | null = null
  private enableSelectionChat = true
  private layoutChangeEventRef: EventRef | null = null

  constructor(deps: SelectionChatControllerDeps) {
    this.plugin = deps.plugin
    this.app = deps.app
    this.getSettings = deps.getSettings
    this.t = deps.t
    this.getEditorView = deps.getEditorView
    this.showQuickAskWithOptions = deps.showQuickAskWithOptions
    this.showQuickAskWithAutoSend = deps.showQuickAskWithAutoSend
    this.showQuickAskFromPdf = deps.showQuickAskFromPdf
    this.pruneOrphanedQuickAskPdfInstance =
      deps.pruneOrphanedQuickAskPdfInstance
    this.openChatWithSelectionAndPrefill = deps.openChatWithSelectionAndPrefill
    this.addSelectionToSidebarChat = deps.addSelectionToSidebarChat
    this.openChatWithSelectionAndSend = deps.openChatWithSelectionAndSend
    this.isSmartSpaceOpen = deps.isSmartSpaceOpen
  }

  isActive(): boolean {
    return this.enableSelectionChat
  }

  clearPendingSelectionRewrite() {
    this.pendingSelectionRewrite = null
  }

  consumePendingSelectionRewrite(): PendingSelectionRewrite | null {
    const pending = this.pendingSelectionRewrite
    this.pendingSelectionRewrite = null
    return pending
  }

  initialize() {
    const enableSelectionChat =
      this.getSettings().continuationOptions?.enableSelectionChat ?? true
    this.enableSelectionChat = enableSelectionChat

    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }

    if (this.selectionManager) {
      this.selectionManager.destroy()
      this.selectionManager = null
    }

    if (this.pdfSelectionManager) {
      this.pdfSelectionManager.destroy()
      this.pdfSelectionManager = null
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (view) {
      const editorContainer = view.containerEl.querySelector('.cm-editor')
      if (editorContainer) {
        this.selectionManager = new SelectionManager(
          editorContainer as HTMLElement,
          {
            enabled: true,
            minSelectionLength: 0,
            debounceDelay: 150,
          },
        )

        this.selectionManager.init((selection: SelectionInfo | null) => {
          this.handleSelectionChange(selection, view.editor)
        })
      }
    }

    // PDF selection sync — works on both desktop and mobile.
    this.pdfSelectionManager = new PdfSelectionManager(this.app, {
      enabled: enableSelectionChat,
      debounceDelay: 150,
    })
    this.pdfSelectionManager.init((result) => {
      this.handlePdfSelectionChange(result)
    })

    // Prune highlight entries for PDF leaves that get closed. initialize() can
    // be called multiple times (settings reload), so unregister the previous
    // listener before adding a new one to avoid accumulating callbacks.
    if (this.layoutChangeEventRef) {
      this.app.workspace.offref(this.layoutChangeEventRef)
      this.layoutChangeEventRef = null
    }
    this.layoutChangeEventRef = this.app.workspace.on('layout-change', () => {
      pdfSelectionHighlightController.pruneDetachedLeaves(this.app)

      // Drop our PDF cursor-chat widget if its leaf was closed.
      const activePdfLeaves = new Set(this.app.workspace.getLeavesOfType('pdf'))
      if (
        this.currentWidgetPdfLeaf &&
        !activePdfLeaves.has(this.currentWidgetPdfLeaf)
      ) {
        this.destroyCurrentWidget()
        this.lastSyncedPdfKey = null
      }

      // Drop the PDF Quick Ask overlay if its leaf was closed.
      this.pruneOrphanedQuickAskPdfInstance(activePdfLeaves)
    })
    this.plugin.registerEvent(this.layoutChangeEventRef)
  }

  destroy() {
    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }
    if (this.selectionManager) {
      this.selectionManager.destroy()
      this.selectionManager = null
    }
    if (this.pdfSelectionManager) {
      this.pdfSelectionManager.destroy()
      this.pdfSelectionManager = null
    }
    if (this.layoutChangeEventRef) {
      this.app.workspace.offref(this.layoutChangeEventRef)
      this.layoutChangeEventRef = null
    }
    // Drop all highlights and detach PDF eventBus listeners.  Reconcile in
    // Chat.tsx only clears 'chat' owner; here we want everything gone.
    selectionHighlightController.clearAll()
    pdfSelectionHighlightController.clearAll()
  }

  // Kept for the public API surface; selection highlight reconcile is now driven
  // entirely by the chat mention list, so leaf changes need no special handling here.
  handleActiveLeafChange(_leaf: WorkspaceLeaf | null) {
    // no-op
  }

  private destroyCurrentWidget(): void {
    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }
    this.currentWidgetPdfLeaf = null
  }

  private static buildPdfSelectionKey(
    data: Extract<PdfSelectionResult, { kind: 'data' }>,
  ): string {
    return `${data.file.path}#${data.pageNumber}#${data.content}`
  }

  private handleSelectionChange(
    selection: SelectionInfo | null,
    editor: Editor,
  ) {
    if (
      !selection &&
      this.selectionChatWidget?.shouldPreserveOnSelectionLoss()
    ) {
      return
    }

    this.syncSelectionBadge(selection, editor)

    // Switching to a markdown selection invalidates any sticky PDF state.
    this.lastSyncedPdfKey = null

    this.destroyCurrentWidget()

    if (this.isSmartSpaceOpen()) {
      return
    }

    const enableSelectionChat =
      this.getSettings().continuationOptions?.enableSelectionChat ?? true
    if (!enableSelectionChat) {
      return
    }

    if (selection) {
      const currentView = this.app.workspace.getActiveViewOfType(MarkdownView)
      const hostEl = currentView?.containerEl.querySelector('.cm-editor')
      if (!hostEl) {
        return
      }

      this.selectionChatWidget = new SelectionChatWidget({
        source: 'markdown',
        plugin: this.plugin,
        editor,
        selection,
        hostEl: hostEl as HTMLElement,
        onClose: () => {
          this.destroyCurrentWidget()
        },
        onAction: (
          actionId: string,
          sel: SelectionInfo,
          instruction: string,
          mode: SelectionActionMode,
          rewriteBehavior?: SelectionActionRewriteBehavior,
        ) => {
          void this.handleSelectionAction(
            actionId,
            sel,
            editor,
            instruction,
            mode,
            rewriteBehavior,
          )
        },
      })
      this.selectionChatWidget.mount()
    }
  }

  private async handleSelectionAction(
    actionId: string,
    selection: SelectionInfo,
    editor: Editor,
    instruction: string,
    mode: SelectionActionMode,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) {
    if (mode === 'rewrite') {
      await this.rewriteSelection(
        editor,
        selection,
        instruction,
        rewriteBehavior,
      )
      return
    }

    if (mode === 'chat-input') {
      if (actionId === 'add-to-sidebar') {
        await this.addToSidebar(editor)
        return
      }
      await this.addToChatInput(editor, instruction)
      return
    }

    if (mode === 'chat-send') {
      await this.addToChatAndSend(editor, instruction)
      return
    }

    const prompt = instruction.trim()
    if (!prompt) {
      await this.openCustomAsk(editor)
      return
    }
    await this.explainSelection(editor, prompt)
  }

  private async openCustomAsk(editor: Editor) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    const mentionable = this.createSelectionMentionable(editor, view)
    if (!mentionable) {
      new Notice('无法创建选区数据')
      return
    }

    const editorView = this.getEditorView(editor)
    if (!editorView) {
      new Notice('无法获取编辑器视图')
      return
    }

    this.showQuickAskWithOptions(editor, editorView, {
      initialMode: 'chat',
      initialMentionables: [mentionable],
      selectionScope: this.createSelectionScope(mentionable, editor),
    })
  }

  private createSelectionMentionable(
    editor: Editor,
    view: MarkdownView,
  ): MentionableBlock | null {
    const data = getMentionableBlockData(editor, view)
    if (!data) {
      return null
    }

    return {
      type: 'block',
      ...data,
      source: 'selection',
    }
  }

  private createSelectionScope(
    mentionable: MentionableBlock,
    editor: Editor,
  ): QuickAskSelectionScope {
    return {
      mentionable,
      selectionFrom: editor.getCursor('from'),
    }
  }

  private syncSelectionBadge(selection: SelectionInfo | null, editor: Editor) {
    const targetLeaf = this.plugin
      .getChatLeafSessionManager()
      .resolveTargetLeaf()
    if (!(targetLeaf?.view instanceof ChatView)) {
      return
    }

    const chatView = targetLeaf.view

    if (!selection) {
      const activeMarkdownView =
        this.app.workspace.getActiveViewOfType(MarkdownView)
      if (!activeMarkdownView) {
        return
      }
      chatView.clearSelectionFromChat()
      return
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) {
      return
    }

    const data = getMentionableBlockData(editor, view)
    if (!data) {
      return
    }

    // Stamp a highlightId and pin the sync highlight immediately.
    const highlightId = crypto.randomUUID()
    const editorView = this.getEditorView(editor)
    if (editorView && this.shouldPersistSelectionHighlight()) {
      const selection = editorView.state.selection.main
      if (!selection.empty) {
        selectionHighlightController.addHighlight(
          editorView,
          highlightId,
          { from: selection.from, to: selection.to },
          'sync',
          'chat',
        )
      }
    }

    chatView.syncSelectionToChat({ ...data, highlightId })
  }

  /**
   * Called by PdfSelectionManager when the user's selection inside a PDF view
   * changes.
   */
  private handlePdfSelectionChange(result: PdfSelectionResult): void {
    // null means the selection is not inside any PDF at all.
    if (result === null) return

    const enableSelectionChat =
      this.getSettings().continuationOptions?.enableSelectionChat ?? true
    if (!enableSelectionChat) return

    if (result.kind === 'empty') {
      // Destroy the PDF widget if there was one
      this.destroyCurrentWidget()
      this.lastSyncedPdfKey = null

      // Also sync the sidebar badge (existing behaviour)
      const targetLeaf = this.plugin
        .getChatLeafSessionManager()
        .resolveTargetLeaf()
      if (targetLeaf?.view instanceof ChatView) {
        targetLeaf.view.clearSelectionFromChat()
      }
      return
    }

    // result.kind === 'data'
    // Re-firing PdfSelectionManager for the *same* logical selection (e.g.
    // because mounting our overlay nudges the selection observer) used to
    // re-run addHighlight + syncSelectionToChat.  syncSelectionMentionable
    // keys mentions by content (not by highlightId), so the re-sync was a
    // no-op while the new highlight in the registry got a fresh id — leaving
    // the chat mention pointing at the *old* id.  The next reconcile wiped
    // the new highlight, breaking persistence.  Skip the whole cycle when
    // the selection identity is unchanged.
    const selectionKey = SelectionChatController.buildPdfSelectionKey(result)
    if (
      this.lastSyncedPdfKey === selectionKey &&
      this.selectionChatWidget &&
      this.currentWidgetPdfLeaf === result.leaf
    ) {
      return
    }

    // Mount PDF widget — generate fresh highlight id only for genuinely new
    // selections.
    const highlightId = crypto.randomUUID()

    if (this.shouldPersistSelectionHighlight()) {
      pdfSelectionHighlightController.addHighlight(
        result.leaf,
        highlightId,
        {
          range: result.range,
          pageNumber: result.pageNumber,
          file: result.file,
        },
        'sync',
        'chat',
      )
    }

    const blockData: MentionableBlockData = {
      content: result.content,
      file: result.file,
      startLine: 0,
      endLine: 0,
      pageNumber: result.pageNumber,
      source: 'selection-sync',
      highlightId,
    }

    // Sync to sidebar chat badge (existing behaviour, conditional on ChatView)
    const targetLeaf = this.plugin
      .getChatLeafSessionManager()
      .resolveTargetLeaf()
    if (targetLeaf?.view instanceof ChatView) {
      targetLeaf.view.syncSelectionToChat(blockData)
    }

    // Determine host element for the PDF widget BEFORE destroying the old one.
    // If the leaf DOM is not in the expected shape, leave the existing widget
    // (whatever it is) intact rather than destroying it then bailing out.
    const leafContentEl = getPdfLeafContentEl(result.leaf)
    if (!leafContentEl) return

    // Now safe to swap widgets.
    this.destroyCurrentWidget()
    this.lastSyncedPdfKey = selectionKey
    this.currentWidgetPdfLeaf = result.leaf

    const pdfData = result

    // For multi-line selections, range.getBoundingClientRect() returns the
    // outer box (right edge = widest line's right), which would position the
    // indicator at the page edge.  We want the rect at the visual *end* of
    // the selection (last line, rightmost glyph).
    //
    // SelectionManager (markdown) just takes `rects[rects.length - 1]`
    // because CodeMirror keeps spans in document = visual order.  PDF.js's
    // textLayer behaves differently:
    //   - it inserts hidden helper spans (e.g. an `endOfContent` element)
    //     whose rect may span the full page height, so the literal last
    //     rect or the geometrically lowest rect can both be misleading;
    //   - hyphenation / column flow can put DOM-last spans at unexpected
    //     visual positions.
    // Filter to rects that look like real text glyphs (non-zero area, line
    // height under 60px), then pick the geometrically bottom-rightmost.
    const allRects = result.range.getClientRects()
    const glyphRects: DOMRect[] = []
    for (let i = 0; i < allRects.length; i += 1) {
      const r = allRects[i]
      if (r.width > 0 && r.height > 0 && r.height < 60) {
        glyphRects.push(r)
      }
    }
    let lastRect: DOMRect = result.range.getBoundingClientRect()
    if (glyphRects.length > 0) {
      lastRect = glyphRects[0]
      for (let i = 1; i < glyphRects.length; i += 1) {
        const r = glyphRects[i]
        // Treat lines as same when bottoms differ by < 2px (sub-pixel jitter).
        const onSameLine = Math.abs(r.bottom - lastRect.bottom) < 2
        if (
          r.bottom > lastRect.bottom + 1 ||
          (onSameLine && r.right > lastRect.right)
        ) {
          lastRect = r
        }
      }
    }

    this.selectionChatWidget = new SelectionChatWidget({
      source: 'pdf',
      plugin: this.plugin,
      selection: {
        text: result.content,
        range: result.range,
        rect: lastRect,
        isMultiLine:
          glyphRects.length > 1 || result.content.includes('\n'),
      },
      pdfData,
      hostEl: leafContentEl,
      onClose: () => {
        // User dismissed the indicator/menu (Esc or click outside).  Drop the
        // widget but do NOT clear lastSyncedPdfKey: the chat mention + PDF
        // highlight should persist until the underlying selection changes.
        this.destroyCurrentWidget()
      },
      onAction: (
        actionId: string,
        instruction: string,
        mode: SelectionActionMode,
        rewriteBehavior?: SelectionActionRewriteBehavior,
      ) => {
        void this.handlePdfSelectionAction(
          actionId,
          mode,
          instruction,
          rewriteBehavior,
          pdfData,
          blockData,
        )
      },
    })
    this.selectionChatWidget.mount()
  }

  /**
   * Routes a PDF selection action to the appropriate handler.
   */
  private async handlePdfSelectionAction(
    actionId: string,
    mode: SelectionActionMode,
    instruction: string,
    _rewriteBehavior: SelectionActionRewriteBehavior | undefined,
    pdfData: Extract<PdfSelectionResult, { kind: 'data' }>,
    blockData: MentionableBlockData,
  ): Promise<void> {
    // rewrite is filtered out at the menu level — this branch is unreachable
    if (mode === 'rewrite') {
      return
    }

    // Mirror the markdown chat-input/chat-send paths: register a NEW 'pinned'
    // highlight (with a fresh id, independent from the transient 'sync' one
    // currently tracked in chat).  This way subsequent selections that sweep
    // 'sync' entries on the leaf cannot wipe the pinned highlight.
    const buildPinnedBlock = (): MentionableBlockData => {
      if (this.shouldPersistSelectionHighlight()) {
        const pinnedId = crypto.randomUUID()
        pdfSelectionHighlightController.addHighlight(
          pdfData.leaf,
          pinnedId,
          {
            range: pdfData.range,
            pageNumber: pdfData.pageNumber,
            file: pdfData.file,
          },
          'pinned',
          'chat',
        )
        return { ...blockData, source: 'selection-pinned', highlightId: pinnedId }
      }
      return { ...blockData, source: 'selection-pinned' }
    }

    if (mode === 'chat-input') {
      const pinned = buildPinnedBlock()
      if (actionId === 'add-to-sidebar') {
        await this.addSelectionToSidebarChat(pinned)
        return
      }
      await this.openChatWithSelectionAndPrefill(pinned, instruction.trim())
      return
    }

    if (mode === 'chat-send') {
      await this.openChatWithSelectionAndSend(
        buildPinnedBlock(),
        instruction.trim(),
      )
      return
    }

    // mode === 'ask' — open Quick Ask with PDF selection as mentionable
    const mentionable: MentionableBlock = {
      type: 'block',
      ...blockData,
      source: 'selection',
    }
    const prompt = instruction.trim()

    this.showQuickAskFromPdf({
      leaf: pdfData.leaf,
      range: pdfData.range,
      file: pdfData.file,
      pageNumber: pdfData.pageNumber,
      initialMentionables: [mentionable],
      initialPrompt: prompt || undefined,
      initialMode: 'chat',
      autoSend: prompt.length > 0,
    })
  }

  private async rewriteSelection(
    editor: Editor,
    _selection: SelectionInfo,
    instruction: string,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) {
      new Notice('无法获取当前编辑器')
      return
    }

    const selectedText = editor.getSelection()
    if (!selectedText || selectedText.trim().length === 0) {
      new Notice('请先选择要改写的文本。')
      return
    }

    const mentionable = this.createSelectionMentionable(editor, view)
    if (!mentionable) {
      new Notice('无法创建选区数据')
      return
    }

    const editorView = this.getEditorView(editor)
    if (!editorView) {
      new Notice('无法获取编辑器视图')
      return
    }

    const behavior = rewriteBehavior ?? 'custom'
    const prompt = instruction.trim()
    if (behavior === 'preset' && !prompt) {
      new Notice('未设置改写指令。')
      return
    }

    this.showQuickAskWithOptions(editor, editorView, {
      initialMode: 'edit',
      initialPrompt: behavior === 'preset' ? prompt : undefined,
      initialInput: behavior === 'custom' ? prompt : undefined,
      initialMentionables: [mentionable],
      editContextText: selectedText,
      editSelectionFrom: editor.getCursor('from'),
      selectionScope: this.createSelectionScope(mentionable, editor),
      autoSend: behavior === 'preset',
    })
  }

  private async explainSelection(editor: Editor, prompt?: string) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    const mentionable = this.createSelectionMentionable(editor, view)
    if (!mentionable) {
      new Notice('无法创建选区数据')
      return
    }

    const editorView = this.getEditorView(editor)
    if (!editorView) {
      new Notice('无法获取编辑器视图')
      return
    }

    const basePrompt =
      prompt?.trim() || this.t('selection.actions.explain', '请深入解释')
    this.showQuickAskWithAutoSend(editor, editorView, {
      prompt: basePrompt,
      mentionables: [mentionable],
      selectionScope: this.createSelectionScope(mentionable, editor),
    })
  }

  private async addToChatInput(editor: Editor, prompt?: string) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    const data = getMentionableBlockData(editor, view)
    if (!data) {
      new Notice('无法创建选区数据')
      return
    }

    const editorView = this.getEditorView(editor)
    const highlightId = crypto.randomUUID()

    if (editorView && this.shouldPersistSelectionHighlight()) {
      const sel = editorView.state.selection.main
      if (!sel.empty) {
        selectionHighlightController.addHighlight(
          editorView,
          highlightId,
          { from: sel.from, to: sel.to },
          'pinned',
          'chat',
        )
      }
    }

    const resolvedPrompt = prompt?.trim() ?? ''
    await this.openChatWithSelectionAndPrefill(
      { ...data, source: 'selection-pinned', highlightId },
      resolvedPrompt,
    )
  }

  private async addToSidebar(editor: Editor) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    const data = getMentionableBlockData(editor, view)
    if (!data) {
      new Notice('无法创建选区数据')
      return
    }

    const editorView = this.getEditorView(editor)
    const highlightId = crypto.randomUUID()

    if (editorView && this.shouldPersistSelectionHighlight()) {
      const sel = editorView.state.selection.main
      if (!sel.empty) {
        selectionHighlightController.addHighlight(
          editorView,
          highlightId,
          { from: sel.from, to: sel.to },
          'pinned',
          'chat',
        )
      }
    }

    await this.addSelectionToSidebarChat({
      ...data,
      source: 'selection-pinned',
      highlightId,
    })
  }

  private async addToChatAndSend(editor: Editor, prompt?: string) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    const data = getMentionableBlockData(editor, view)
    if (!data) {
      new Notice('无法创建选区数据')
      return
    }

    const editorView = this.getEditorView(editor)
    const highlightId = crypto.randomUUID()

    if (editorView && this.shouldPersistSelectionHighlight()) {
      const sel = editorView.state.selection.main
      if (!sel.empty) {
        selectionHighlightController.addHighlight(
          editorView,
          highlightId,
          { from: sel.from, to: sel.to },
          'pinned',
          'chat',
        )
      }
    }

    await this.openChatWithSelectionAndSend(
      { ...data, source: 'selection-pinned', highlightId },
      prompt?.trim() ?? '',
    )
  }

  private shouldPersistSelectionHighlight(): boolean {
    return (
      this.getSettings().continuationOptions.persistSelectionHighlight ?? true
    )
  }
}
