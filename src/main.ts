import {
  type Extension,
  Prec,
  EditorSelection,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
  keymap,
} from '@codemirror/view'
import { minimatch } from 'minimatch'
import {
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
} from 'obsidian'

import { ApplyView, ApplyViewState } from './ApplyView'
import { ChatView } from './ChatView'
import { ChatProps } from './components/chat-view/Chat'
import { InstallerUpdateRequiredModal } from './components/modals/InstallerUpdateRequiredModal'
import { CustomContinueWidget } from './components/panels/CustomContinuePanel'
import { SelectionManager } from './components/selection/SelectionManager'
import type { SelectionInfo } from './components/selection/SelectionManager'
import { SelectionChatWidget } from './components/selection/SelectionChatWidget'
import { APPLY_VIEW_TYPE, CHAT_VIEW_TYPE } from './constants'
import { getChatModelClient } from './core/llm/manager'
import { McpManager } from './core/mcp/mcpManager'
import { RAGEngine } from './core/rag/ragEngine'
import { DatabaseManager } from './database/DatabaseManager'
import { PGLiteAbortedException } from './database/exception'
import type { VectorManager } from './database/modules/vector/VectorManager'
import { createTranslationFunction } from './i18n'
import {
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
  SmartComposerSettings,
  smartComposerSettingsSchema,
} from './settings/schema/setting.types'
import { parseSmartComposerSettings } from './settings/schema/settings'
import { SmartComposerSettingTab } from './settings/SettingTab'
import { ConversationOverrideSettings } from './types/conversation-settings.types'
import {
  getMentionableBlockData,
  getNestedFiles,
  readMultipleTFiles,
  readTFileContent,
} from './utils/obsidian'

type InlineSuggestionGhostPayload = { from: number; text: string } | null

const inlineSuggestionGhostEffect =
  StateEffect.define<InlineSuggestionGhostPayload>()

class InlineSuggestionGhostWidget extends WidgetType {
  constructor(private readonly text: string) {
    super()
  }

  eq(other: InlineSuggestionGhostWidget) {
    return this.text === other.text
  }

  ignoreEvent(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'smtcmp-ghost-text'
    span.textContent = this.text
    return span
  }
}

const inlineSuggestionGhostField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(value, tr) {
    let decorations = value.map(tr.changes)

    for (const effect of tr.effects) {
      if (effect.is(inlineSuggestionGhostEffect)) {
        const payload = effect.value
        if (!payload) {
          decorations = Decoration.none
          continue
        }
        const widget = Decoration.widget({
          widget: new InlineSuggestionGhostWidget(payload.text),
          side: 1,
        }).range(payload.from)
        decorations = Decoration.set([widget])
      }
    }

    if (tr.docChanged) {
      decorations = Decoration.none
    }

    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

const inlineSuggestionExtensionViews = new WeakSet<EditorView>()

type CustomContinueWidgetPayload = {
  pos: number
  options: {
    plugin: SmartComposerPlugin
    editor: Editor
    view: EditorView
    onClose: () => void
  }
}

const customContinueWidgetEffect =
  StateEffect.define<CustomContinueWidgetPayload | null>()

const customContinueWidgetField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    let updated = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(customContinueWidgetEffect)) {
        updated = Decoration.none
        const payload = effect.value
        if (payload) {
          updated = Decoration.set([
            Decoration.widget({
              widget: new CustomContinueWidget(payload.options),
              side: 1,
              block: false,
            }).range(payload.pos),
          ])
        }
      }
    }
    return updated
  },
  provide: (field) => EditorView.decorations.from(field),
})

export default class SmartComposerPlugin extends Plugin {
  settings: SmartComposerSettings
  initialChatProps?: ChatProps // TODO: change this to use view state like ApplyView
  settingsChangeListeners: ((newSettings: SmartComposerSettings) => void)[] = []
  mcpManager: McpManager | null = null
  dbManager: DatabaseManager | null = null
  ragEngine: RAGEngine | null = null
  private dbManagerInitPromise: Promise<DatabaseManager> | null = null
  private ragEngineInitPromise: Promise<RAGEngine> | null = null
  private timeoutIds: ReturnType<typeof setTimeout>[] = [] // Use ReturnType instead of number
  private pgliteResourcePath?: string
  private isContinuationInProgress = false
  private autoUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private isAutoUpdating = false
  private activeAbortControllers: Set<AbortController> = new Set()
  private tabCompletionTimer: ReturnType<typeof setTimeout> | null = null
  private tabCompletionAbortController: AbortController | null = null
  private activeInlineSuggestion: {
    source: 'tab' | 'continuation'
    editor: Editor
    view: EditorView
    fromOffset: number
    text: string
  } | null = null
  private tabCompletionSuggestion: {
    editor: Editor
    view: EditorView
    text: string
    cursorOffset: number
  } | null = null
  private continuationInlineSuggestion: {
    editor: Editor
    view: EditorView
    text: string
    fromOffset: number
    startPos: ReturnType<Editor['getCursor']>
  } | null = null
  private tabCompletionPending: {
    editor: Editor
    cursorOffset: number
  } | null = null
  private customContinueWidgetState: {
    view: EditorView
    pos: number
    close: () => void
  } | null = null
  private lastSmartSpaceSlash:
    | { view: EditorView; pos: number; timestamp: number }
    | null = null
  // Selection chat state
  private selectionManager: any | null = null
  private selectionChatWidget: any | null = null
  private pendingSelectionRewrite: {
    editor: Editor
    selectedText: string
    from: { line: number; ch: number }
    to: { line: number; ch: number }
  } | null = null
  // Model list cache for provider model fetching
  private modelListCache: Map<
    string,
    { models: string[]; timestamp: number }
  > = new Map()

  // Get cached model list for a provider
  getCachedModelList(providerId: string): string[] | null {
    const cached = this.modelListCache.get(providerId)
    if (cached) {
      return cached.models
    }
    return null
  }

  // Set model list cache for a provider
  setCachedModelList(providerId: string, models: string[]): void {
    this.modelListCache.set(providerId, {
      models,
      timestamp: Date.now(),
    })
  }

  // Clear all model list cache (called when settings modal closes)
  clearModelListCache(): void {
    this.modelListCache.clear()
  }

  private resolvePgliteResourcePath(): string {
    if (!this.pgliteResourcePath) {
      // manifest.dir 已经包含完整的插件目录路径（相对于 vault）
      // 例如：.obsidian/plugins/obsidian-smart-composer 或 .obsidian/plugins/yolo
      const pluginDir = this.manifest.dir
      if (pluginDir) {
        this.pgliteResourcePath = normalizePath(`${pluginDir}/vendor/pglite`)
      } else {
        // 如果 manifest.dir 不存在，使用 manifest.id 作为后备
        const configDir = this.app.vault.configDir
        this.pgliteResourcePath = normalizePath(
          `${configDir}/plugins/${this.manifest.id}/vendor/pglite`,
        )
      }
    }
    return this.pgliteResourcePath
  }

  // Compute a robust panel anchor position just below the caret line
  private getCaretPanelPosition(
    editor: Editor,
    dy = 8,
  ): { x: number; y: number } | undefined {
    try {
      const cm: any = (editor as any).cm
      const head: number | undefined = cm?.state?.selection?.main?.head
      if (cm?.coordsAtPos && typeof head === 'number') {
        const rect = cm.coordsAtPos(head)
        if (rect) {
          const base = rect.bottom ?? rect.top
          if (typeof base === 'number') {
            const y = base + dy
            return { x: rect.left, y }
          }
        }
      }
    } catch {
      // ignore
    }
    return undefined
  }

  private closeCustomContinueWidget() {
    const state = this.customContinueWidgetState
    if (!state) return
    
    // 先清除状态，避免重复关闭
    this.customContinueWidgetState = null
    
    // Clear pending selection rewrite if user closes without submitting
    this.pendingSelectionRewrite = null
    
    // 尝试触发关闭动画
    const hasAnimation = CustomContinueWidget.closeCurrentWithAnimation()
    
    if (!hasAnimation) {
      // 如果没有动画实例，直接分发关闭效果
      state.view.dispatch({ effects: customContinueWidgetEffect.of(null) })
    }
    // 如果有动画，widget 会在动画结束后自己调用 onClose 来分发关闭效果
    
    state.view.focus()
  }

  private showCustomContinueWidget(editor: Editor, view: EditorView) {
    const selection = view.state.selection.main
    const pos = selection.head

    this.closeCustomContinueWidget()

    const close = () => {
      // 检查是否是当前的 widget（允许状态为 null，因为可能在动画期间被清除）
      if (this.customContinueWidgetState && this.customContinueWidgetState.view !== view) {
        return
      }
      this.customContinueWidgetState = null
      view.dispatch({ effects: customContinueWidgetEffect.of(null) })
      view.focus()
    }

    view.dispatch({
      effects: [
        customContinueWidgetEffect.of(null),
        customContinueWidgetEffect.of({
          pos,
          options: {
            plugin: this,
            editor,
            view,
            onClose: close,
          },
        }),
      ],
    })

    this.customContinueWidgetState = { view, pos, close }
  }

  // Selection Chat methods
  private initializeSelectionManager() {
    // Clean up existing manager
    if (this.selectionManager) {
      this.selectionManager.destroy()
      this.selectionManager = null
    }

    // Get the active editor container
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) return

    const editorContainer = view.containerEl.querySelector('.cm-editor')
    if (!editorContainer) return

    // Create new selection manager
    this.selectionManager = new SelectionManager(editorContainer as HTMLElement, {
      enabled: true,
      minSelectionLength: 6,
      debounceDelay: 300,
    })

    // Initialize with callback
    this.selectionManager.init((selection: SelectionInfo | null) => {
      this.handleSelectionChange(selection, view.editor)
    })
  }

  private handleSelectionChange(selection: SelectionInfo | null, editor: Editor) {
    // Close existing widget
    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }

    // Don't show if Smart Space is active
    if (this.customContinueWidgetState) {
      return
    }

    // Show new widget if selection is valid
    if (selection) {
      this.selectionChatWidget = new SelectionChatWidget({
        plugin: this,
        editor,
        selection,
        onClose: () => {
          if (this.selectionChatWidget) {
            this.selectionChatWidget.destroy()
            this.selectionChatWidget = null
          }
        },
        onAction: async (actionId: string, sel: SelectionInfo) => {
          await this.handleSelectionAction(actionId, sel, editor)
        },
      })
      this.selectionChatWidget.mount()
    }
  }

  private async handleSelectionAction(
    actionId: string,
    selection: SelectionInfo,
    editor: Editor,
  ) {
    const selectedText = selection.text

    switch (actionId) {
      case 'add-to-chat':
        // Add selected text to chat
        await this.addTextToChat(selectedText)
        break

      case 'rewrite':
        // Trigger rewrite with selected text
        await this.rewriteSelection(editor, selectedText)
        break

      case 'explain':
        // Add selection as badge and pre-fill explanation prompt
        await this.explainSelection(editor)
        break

      default:
        console.warn('Unknown selection action:', actionId)
    }
  }

  private async addTextToChat(text: string) {
    // Get current file and editor info for context
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor
    
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    // Create mentionable block data from selection
    const data = await getMentionableBlockData(editor, view)
    if (!data) {
      new Notice('无法创建选区数据')
      return
    }

    // Get or open chat view
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({
        selectedBlock: data,
      })
      return
    }

    // Use existing chat view
    await this.app.workspace.revealLeaf(leaves[0])
    const chatView = leaves[0].view
    chatView.addSelectionToChat(data)
    chatView.focusMessage()
  }

  private async rewriteSelection(editor: Editor, selectedText: string) {
    // Show Smart Space-like input for rewrite instruction
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) return

    // Get CodeMirror view
    const cmEditor = (editor as any).cm as EditorView
    if (!cmEditor) return

    // Save selection positions before they get lost
    const from = editor.getCursor('from')
    const to = editor.getCursor('to')

    // Set pending rewrite state so continueWriting knows to call handleCustomRewrite
    this.pendingSelectionRewrite = {
      editor,
      selectedText,
      from,
      to,
    }

    // Show custom continue widget for user to input rewrite instruction
    this.showCustomContinueWidget(editor, cmEditor)
  }

  private async explainSelection(editor: Editor) {
    // Add selection as badge to chat and pre-fill explanation prompt
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    // Create mentionable block data from selection
    const data = await getMentionableBlockData(editor, view)
    if (!data) {
      new Notice('无法创建选区数据')
      return
    }

    // Get or open chat view
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({
        selectedBlock: data,
      })
      // After opening, insert the prompt
      const newLeaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
      if (newLeaves.length > 0 && newLeaves[0].view instanceof ChatView) {
        const chatView = newLeaves[0].view
        chatView.insertTextToInput(this.t('selection.actions.explain', '请深入解释') + '：')
        chatView.focusMessage()
      }
      return
    }

    // Use existing chat view
    await this.app.workspace.revealLeaf(leaves[0])
    const chatView = leaves[0].view
    chatView.addSelectionToChat(data)
    chatView.insertTextToInput(this.t('selection.actions.explain', '请深入解释') + '：')
    chatView.focusMessage()
  }

  private createCustomContinueTriggerExtension(): Extension {
    return [
      customContinueWidgetField,
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          const smartSpaceEnabled =
            this.settings.continuationOptions?.enableSmartSpace ?? true
          if (!smartSpaceEnabled) {
            this.lastSmartSpaceSlash = null
            return false
          }
          if (event.defaultPrevented) {
            this.lastSmartSpaceSlash = null
            return false
          }

          const isSlash = event.key === '/' || event.code === 'Slash'
          const isSpace =
            event.key === ' ' ||
            event.key === 'Spacebar' ||
            event.key === 'Space' ||
            event.code === 'Space'
          const handledKey = isSlash || isSpace

          if (!handledKey) {
            this.lastSmartSpaceSlash = null
            return false
          }
          if (event.altKey || event.metaKey || event.ctrlKey) {
            this.lastSmartSpaceSlash = null
            return false
          }

          const selection = view.state.selection.main
          if (!selection.empty) {
            this.lastSmartSpaceSlash = null
            return false
          }

          const markdownView =
            this.app.workspace.getActiveViewOfType(MarkdownView)
          const editor = markdownView?.editor
          if (!editor) {
            this.lastSmartSpaceSlash = null
            return false
          }
          const cm = (editor as any)?.cm
          if (cm && cm !== view) {
            this.lastSmartSpaceSlash = null
            return false
          }

          if (isSlash) {
            this.lastSmartSpaceSlash = {
              view,
              pos: selection.head,
              timestamp: Date.now(),
            }
            return false
          }

          // Space handling (either legacy single-space trigger, or slash + space)
          const now = Date.now()
          const lastSlash = this.lastSmartSpaceSlash
          let selectionAfterRemoval = selection
          let triggeredBySlashCombo = false
          if (
            lastSlash &&
            lastSlash.view === view &&
            now - lastSlash.timestamp <= 600
          ) {
            const slashChar = view.state.doc.sliceString(
              lastSlash.pos,
              lastSlash.pos + 1,
            )
            if (slashChar === '/') {
              view.dispatch({
                changes: { from: lastSlash.pos, to: lastSlash.pos + 1 },
                selection: EditorSelection.cursor(lastSlash.pos),
              })
              selectionAfterRemoval = view.state.selection.main
              triggeredBySlashCombo = true
            }
            this.lastSmartSpaceSlash = null
          } else {
            this.lastSmartSpaceSlash = null
            selectionAfterRemoval = view.state.selection.main
          }

          if (!triggeredBySlashCombo) {
            const line = view.state.doc.lineAt(selectionAfterRemoval.head)
            if (line.text.trim().length > 0) {
              return false
            }
          }

          event.preventDefault()
          event.stopPropagation()

          this.showCustomContinueWidget(editor, view)
          return true
        },
      }),
      EditorView.updateListener.of((update) => {
        const state = this.customContinueWidgetState
        if (!state || state.view !== update.view) return

        if (update.docChanged) {
          state.pos = update.changes.mapPos(state.pos)
        }

        if (update.selectionSet) {
          const head = update.state.selection.main
          if (!head.empty || head.head !== state.pos) {
            this.closeCustomContinueWidget()
          }
        }
      }),
    ]
  }

  private getActiveConversationOverrides():
    | ConversationOverrideSettings
    | undefined {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    for (const leaf of leaves) {
      const view = leaf.view
      if (
        view instanceof ChatView &&
        typeof view.getCurrentConversationOverrides === 'function'
      ) {
        return view.getCurrentConversationOverrides()
      }
    }
    return undefined
  }

  private getActiveConversationModelId(): string | undefined {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    for (const leaf of leaves) {
      const view = leaf.view
      if (
        view instanceof ChatView &&
        typeof view.getCurrentConversationModelId === 'function'
      ) {
        const modelId = view.getCurrentConversationModelId()
        if (modelId) return modelId
      }
    }
    return undefined
  }

  private resolveSamplingParams(overrides?: ConversationOverrideSettings): {
    temperature?: number
    topP?: number
    stream: boolean
  } {
    const defaultTemperature = this.settings.chatOptions.defaultTemperature
    const defaultTopP = this.settings.chatOptions.defaultTopP

    const temperature =
      typeof overrides?.temperature === 'number'
        ? overrides.temperature
        : typeof defaultTemperature === 'number'
          ? defaultTemperature
          : undefined

    const topP =
      typeof overrides?.top_p === 'number'
        ? overrides.top_p
        : typeof defaultTopP === 'number'
          ? defaultTopP
          : undefined

    const stream =
      typeof overrides?.stream === 'boolean' ? overrides.stream : true

    return { temperature, topP, stream }
  }

  private resolveContinuationParams(overrides?: ConversationOverrideSettings): {
    temperature?: number
    topP?: number
    stream: boolean
    useVaultSearch: boolean
  } {
    const continuation = this.settings.continuationOptions ?? {}
    const chatDefaults = this.settings.chatOptions ?? {}

    const temperature =
      typeof continuation.temperature === 'number'
        ? continuation.temperature
        : typeof overrides?.temperature === 'number'
          ? overrides.temperature
          : typeof chatDefaults.defaultTemperature === 'number'
            ? chatDefaults.defaultTemperature
            : undefined

    const overrideTopP = overrides?.top_p
    const topP =
      typeof continuation.topP === 'number'
        ? continuation.topP
        : typeof overrideTopP === 'number'
          ? overrideTopP
          : typeof chatDefaults.defaultTopP === 'number'
            ? chatDefaults.defaultTopP
            : undefined

    const stream =
      typeof continuation.stream === 'boolean'
        ? continuation.stream
        : typeof overrides?.stream === 'boolean'
          ? overrides.stream
          : true

    const useVaultSearch =
      typeof continuation.useVaultSearch === 'boolean'
        ? continuation.useVaultSearch
        : typeof overrides?.useVaultSearch === 'boolean'
          ? overrides.useVaultSearch
          : Boolean(this.settings.ragOptions?.enabled)

    return { temperature, topP, stream, useVaultSearch }
  }

  get t() {
    return createTranslationFunction(this.settings.language || 'en')
  }

  private cancelAllAiTasks() {
    if (this.activeAbortControllers.size === 0) {
      this.isContinuationInProgress = false
      return
    }
    for (const controller of Array.from(this.activeAbortControllers)) {
      try {
        controller.abort()
      } catch {
        // Ignore abort errors; controllers may already be settled.
      }
    }
    this.activeAbortControllers.clear()
    this.isContinuationInProgress = false
    this.tabCompletionAbortController = null
  }

  private getEditorView(editor: Editor | null | undefined): EditorView | null {
    if (!editor) return null
    const view = (editor as any)?.cm as EditorView | undefined
    return view ?? null
  }

  private ensureInlineSuggestionExtension(view: EditorView) {
    if (inlineSuggestionExtensionViews.has(view)) return
    view.dispatch({
      effects: StateEffect.appendConfig.of([
        inlineSuggestionGhostField,
        Prec.high(
          keymap.of([
            {
              key: 'Tab',
              run: (v) => this.tryAcceptInlineSuggestionFromView(v),
            },
            {
              key: 'Shift-Tab',
              run: (v) => this.tryRejectInlineSuggestionFromView(v),
            },
            {
              key: 'Escape',
              run: (v) => this.tryRejectInlineSuggestionFromView(v),
            },
          ]),
        ),
      ]),
    })
    inlineSuggestionExtensionViews.add(view)
  }

  private setInlineSuggestionGhost(
    view: EditorView,
    payload: InlineSuggestionGhostPayload,
  ) {
    this.ensureInlineSuggestionExtension(view)
    view.dispatch({ effects: inlineSuggestionGhostEffect.of(payload) })
  }

  private getTabCompletionOptions() {
    return {
      ...DEFAULT_TAB_COMPLETION_OPTIONS,
      ...(this.settings.continuationOptions.tabCompletionOptions ?? {}),
    }
  }

  private clearTabCompletionTimer() {
    if (this.tabCompletionTimer) {
      clearTimeout(this.tabCompletionTimer)
      this.tabCompletionTimer = null
    }
    this.tabCompletionPending = null
  }

  private cancelTabCompletionRequest() {
    if (!this.tabCompletionAbortController) return
    try {
      this.tabCompletionAbortController.abort()
    } catch {
      // Ignore abort errors; controller might already be closed.
    }
    this.activeAbortControllers.delete(this.tabCompletionAbortController)
    this.tabCompletionAbortController = null
  }

  private clearInlineSuggestion() {
    if (this.tabCompletionSuggestion) {
      const { view } = this.tabCompletionSuggestion
      if (view) {
        this.setInlineSuggestionGhost(view, null)
      }
      this.tabCompletionSuggestion = null
    }
    if (this.continuationInlineSuggestion) {
      const { view } = this.continuationInlineSuggestion
      if (view) {
        this.setInlineSuggestionGhost(view, null)
      }
      this.continuationInlineSuggestion = null
    }
    this.activeInlineSuggestion = null
  }

  private tryAcceptInlineSuggestionFromView(view: EditorView): boolean {
    const suggestion = this.activeInlineSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) return false

    if (suggestion.source === 'tab') {
      return this.tryAcceptTabCompletionFromView(view)
    }

    if (suggestion.source === 'continuation') {
      return this.tryAcceptContinuationFromView(view)
    }

    return false
  }

  private tryRejectInlineSuggestionFromView(view: EditorView): boolean {
    const suggestion = this.activeInlineSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) return false
    this.clearInlineSuggestion()
    return true
  }

  private scheduleTabCompletion(editor: Editor) {
    if (!this.settings.continuationOptions?.enableTabCompletion) return
    const view = this.getEditorView(editor)
    if (!view) return
    const selection = editor.getSelection()
    if (selection && selection.length > 0) return
    const cursorOffset = view.state.selection.main.head

    const options = this.getTabCompletionOptions()
    const delay = Math.max(0, options.triggerDelayMs)

    this.clearTabCompletionTimer()
    this.tabCompletionPending = { editor, cursorOffset }
    this.tabCompletionTimer = setTimeout(() => {
      if (!this.tabCompletionPending) return
      if (this.tabCompletionPending.editor !== editor) return
      void this.runTabCompletion(editor, cursorOffset)
    }, delay)
  }

  private async runTabCompletion(
    editor: Editor,
    scheduledCursorOffset: number,
  ) {
    try {
      if (!this.settings.continuationOptions?.enableTabCompletion) return
      if (this.isContinuationInProgress) return

      const view = this.getEditorView(editor)
      if (!view) return
      if (view.state.selection.main.head !== scheduledCursorOffset) return
      const selection = editor.getSelection()
      if (selection && selection.length > 0) return

      const options = this.getTabCompletionOptions()

      const cursorPos = editor.getCursor()
      const headText = editor.getRange({ line: 0, ch: 0 }, cursorPos)
      const headLength = headText.trim().length
      if (!headText || headLength === 0) return
      if (headLength < options.minContextLength) return

      const context =
        headText.length > options.maxContextChars
          ? headText.slice(-options.maxContextChars)
          : headText

      let modelId = this.settings.continuationOptions.tabCompletionModelId
      if (!modelId || modelId.length === 0) {
        modelId = this.settings.continuationOptions.continuationModelId
      }
      if (!modelId) return

      const sidebarOverrides = this.getActiveConversationOverrides()
      const { temperature, topP } =
        this.resolveContinuationParams(sidebarOverrides)

      const { providerClient, model } = getChatModelClient({
        settings: this.settings,
        modelId,
      })

      const fileTitle = this.app.workspace.getActiveFile()?.basename?.trim()
      const titleSection = fileTitle ? `File title: ${fileTitle}\n\n` : ''
      const customSystemPrompt = (
        this.settings.continuationOptions.tabCompletionSystemPrompt ?? ''
      ).trim()
      const systemPrompt =
        customSystemPrompt.length > 0
          ? customSystemPrompt
          : DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT

      const isBaseModel = Boolean((model as any).isBaseModel)
      const baseModelSpecialPrompt = (
        this.settings.chatOptions.baseModelSpecialPrompt ?? ''
      ).trim()
      const basePromptSection =
        isBaseModel && baseModelSpecialPrompt.length > 0
          ? `${baseModelSpecialPrompt}\n\n`
          : ''
      const userContent = isBaseModel
        ? `${basePromptSection}${systemPrompt}\n\n${context}\n\nPredict the next words that continue naturally.`
        : `${basePromptSection}${titleSection}Recent context:\n\n${context}\n\nProvide the next words that would help continue naturally.`

      const requestMessages = [
        ...(isBaseModel
          ? []
          : ([
              {
                role: 'system' as const,
                content: systemPrompt,
              },
            ] as const)),
        {
          role: 'user' as const,
          content: userContent,
        },
      ]

      this.cancelTabCompletionRequest()
      this.clearInlineSuggestion()
      this.tabCompletionPending = null

      const controller = new AbortController()
      this.tabCompletionAbortController = controller
      this.activeAbortControllers.add(controller)

      const baseRequest: any = {
        model: model.model,
        messages: requestMessages as unknown as any,
        stream: false,
        max_tokens: Math.max(16, Math.min(options.maxTokens, 2000)),
      }
      if (typeof options.temperature === 'number') {
        baseRequest.temperature = Math.min(Math.max(options.temperature, 0), 2)
      } else if (typeof temperature === 'number') {
        baseRequest.temperature = Math.min(Math.max(temperature, 0), 2)
      } else {
        baseRequest.temperature = DEFAULT_TAB_COMPLETION_OPTIONS.temperature
      }
      if (typeof topP === 'number') {
        baseRequest.top_p = topP
      }
      const requestTimeout = Math.max(0, options.requestTimeoutMs)
      const attempts = Math.max(0, Math.floor(options.maxRetries)) + 1

      this.cancelTabCompletionRequest()
      this.clearInlineSuggestion()
      this.tabCompletionPending = null

      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController()
        this.tabCompletionAbortController = controller
        this.activeAbortControllers.add(controller)

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        if (requestTimeout > 0) {
          timeoutHandle = setTimeout(() => controller.abort(), requestTimeout)
        }

        try {
          const response = await providerClient.generateResponse(
            model,
            baseRequest,
            { signal: controller.signal },
          )

          if (timeoutHandle) clearTimeout(timeoutHandle)

          let suggestion = response.choices?.[0]?.message?.content ?? ''
          suggestion = suggestion.replace(/\r\n/g, '\n').replace(/\s+$/, '')
          if (!suggestion.trim()) return
          if (/^[\s\n\t]+$/.test(suggestion)) return

          // Avoid leading line breaks which look awkward in ghost text
          suggestion = suggestion.replace(/^[\s\n\t]+/, '')

          // Guard against large multiline insertions
          if (suggestion.length > options.maxSuggestionLength) {
            suggestion = suggestion.slice(0, options.maxSuggestionLength)
          }

          const currentView = this.getEditorView(editor)
          if (!currentView) return
          if (currentView.state.selection.main.head !== scheduledCursorOffset)
            return
          if (editor.getSelection()?.length) return

          this.setInlineSuggestionGhost(currentView, {
            from: scheduledCursorOffset,
            text: suggestion,
          })
          this.activeInlineSuggestion = {
            source: 'tab',
            editor,
            view: currentView,
            fromOffset: scheduledCursorOffset,
            text: suggestion,
          }
          this.tabCompletionSuggestion = {
            editor,
            view: currentView,
            text: suggestion,
            cursorOffset: scheduledCursorOffset,
          }
          return
        } catch (error) {
          if (timeoutHandle) clearTimeout(timeoutHandle)

          const aborted =
            controller.signal.aborted || error?.name === 'AbortError'
          if (attempt < attempts - 1 && aborted) {
            this.activeAbortControllers.delete(controller)
            this.tabCompletionAbortController = null
            continue
          }
          if (error?.name === 'AbortError') {
            return
          }
          console.error('Tab completion failed:', error)
          return
        } finally {
          if (this.tabCompletionAbortController === controller) {
            this.activeAbortControllers.delete(controller)
            this.tabCompletionAbortController = null
          } else {
            this.activeAbortControllers.delete(controller)
          }
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') return
      console.error('Tab completion failed:', error)
    } finally {
      if (this.tabCompletionAbortController) {
        this.activeAbortControllers.delete(this.tabCompletionAbortController)
        this.tabCompletionAbortController = null
      }
    }
  }

  private tryAcceptTabCompletionFromView(view: EditorView): boolean {
    const suggestion = this.tabCompletionSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) return false

    if (view.state.selection.main.head !== suggestion.cursorOffset) {
      this.clearInlineSuggestion()
      return false
    }

    const editor = suggestion.editor
    if (this.getEditorView(editor) !== view) {
      this.clearInlineSuggestion()
      return false
    }

    if (editor.getSelection()?.length) {
      this.clearInlineSuggestion()
      return false
    }

    const cursor = editor.getCursor()
    const suggestionText = suggestion.text
    this.clearInlineSuggestion()
    editor.replaceRange(suggestionText, cursor, cursor)

    const parts = suggestionText.split('\n')
    const endCursor =
      parts.length === 1
        ? { line: cursor.line, ch: cursor.ch + parts[0].length }
        : {
            line: cursor.line + parts.length - 1,
            ch: parts[parts.length - 1].length,
          }
    editor.setCursor(endCursor)
    this.scheduleTabCompletion(editor)
    return true
  }

  private tryAcceptContinuationFromView(view: EditorView): boolean {
    const suggestion = this.continuationInlineSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) {
      this.clearInlineSuggestion()
      return false
    }

    const active = this.activeInlineSuggestion
    if (!active || active.source !== 'continuation') return false

    const { editor, text, startPos } = suggestion
    if (!text || text.length === 0) {
      this.clearInlineSuggestion()
      return false
    }

    if (this.getEditorView(editor) !== view) {
      this.clearInlineSuggestion()
      return false
    }

    if (editor.getSelection()?.length) {
      this.clearInlineSuggestion()
      return false
    }

    const insertionText = text
    this.clearInlineSuggestion()
    editor.replaceRange(insertionText, startPos, startPos)

    const parts = insertionText.split('\n')
    const endCursor =
      parts.length === 1
        ? { line: startPos.line, ch: startPos.ch + parts[0].length }
        : {
            line: startPos.line + parts.length - 1,
            ch: parts[parts.length - 1].length,
          }
    editor.setCursor(endCursor)
    this.scheduleTabCompletion(editor)
    return true
  }

  private handleTabCompletionEditorChange(editor: Editor) {
    this.clearTabCompletionTimer()
    this.cancelTabCompletionRequest()

    if (!this.settings.continuationOptions?.enableTabCompletion) {
      this.clearInlineSuggestion()
      return
    }

    if (this.isContinuationInProgress) {
      this.clearInlineSuggestion()
      return
    }

    this.clearInlineSuggestion()
    this.scheduleTabCompletion(editor)
  }

  private async handleCustomRewrite(
    editor: Editor,
    customPrompt?: string,
    preSelectedText?: string,
    preSelectionFrom?: { line: number; ch: number },
  ) {
    // Use pre-selected text if provided (from Selection Chat), otherwise get current selection
    const selected = preSelectedText ?? editor.getSelection()
    if (!selected || selected.trim().length === 0) {
      new Notice('请先选择要改写的文本。')
      return
    }

    // Use pre-saved selection start position if provided, otherwise get current
    const from = preSelectionFrom ?? editor.getCursor('from')

    const notice = new Notice('正在生成改写...', 0)
    let controller: AbortController | null = null
    try {
      const sidebarOverrides = this.getActiveConversationOverrides()
      const {
        temperature,
        topP,
        stream: streamPreference,
      } = this.resolveContinuationParams(sidebarOverrides)

      const rewriteModelId =
        this.settings.continuationOptions?.continuationModelId ??
        this.settings.chatModelId

      const { providerClient, model } = getChatModelClient({
        settings: this.settings,
        modelId: rewriteModelId,
      })

      const systemPrompt =
        'You are an intelligent assistant that rewrites ONLY the provided markdown text according to the instruction. Preserve the original meaning, structure, and any markdown (links, emphasis, code) unless explicitly told otherwise. Output ONLY the rewritten text without code fences or extra explanations.'

      const instruction = (customPrompt ?? '').trim()
      const isBaseModel = Boolean((model as any).isBaseModel)
      const baseModelSpecialPrompt = (
        this.settings.chatOptions.baseModelSpecialPrompt ?? ''
      ).trim()
      const basePromptSection =
        isBaseModel && baseModelSpecialPrompt.length > 0
          ? `${baseModelSpecialPrompt}\n\n`
          : ''
      const requestMessages = [
        ...(isBaseModel
          ? []
          : ([{ role: 'system' as const, content: systemPrompt }] as const)),
        {
          role: 'user' as const,
          content: `${basePromptSection}Instruction:\n${instruction}\n\nSelected text:\n${selected}\n\nRewrite the selected text accordingly. Output only the rewritten text.`,
        },
      ] as const

      controller = new AbortController()
      this.activeAbortControllers.add(controller)

      const rewriteRequestBase: any = {
        model: model.model,
        messages: requestMessages as unknown as any,
      }
      if (typeof temperature === 'number') {
        rewriteRequestBase.temperature = temperature
      }
      if (typeof topP === 'number') {
        rewriteRequestBase.top_p = topP
      }

      const stripFences = (s: string) => {
        const lines = (s ?? '').split('\n')
        if (lines.length > 0 && lines[0].startsWith('```')) lines.shift()
        if (lines.length > 0 && lines[lines.length - 1].startsWith('```'))
          lines.pop()
        return lines.join('\n')
      }

      let rewritten = ''
      if (streamPreference) {
        const streamIterator = await providerClient.streamResponse(
          model,
          { ...rewriteRequestBase, stream: true },
          { signal: controller.signal },
        )
        let accumulated = ''
        for await (const chunk of streamIterator) {
          const delta = chunk?.choices?.[0]?.delta
          const piece = delta?.content ?? ''
          if (!piece) continue
          accumulated += piece
        }
        rewritten = stripFences(accumulated).trim()
      } else {
        const response = await providerClient.generateResponse(
          model,
          { ...rewriteRequestBase, stream: false },
          { signal: controller.signal },
        )
        rewritten = stripFences(
          response.choices?.[0]?.message?.content ?? '',
        ).trim()
      }
      if (!rewritten) {
        notice.setMessage('未生成改写内容。')
        this.registerTimeout(() => notice.hide(), 1200)
        return
      }

      // Open ApplyView with a preview diff and let user choose; ApplyView will close back to doc
      const activeFile = this.app.workspace.getActiveFile()
      if (!activeFile) {
        notice.setMessage('未找到当前文件。')
        this.registerTimeout(() => notice.hide(), 1200)
        return
      }

      const head = editor.getRange({ line: 0, ch: 0 }, from)
      const originalContent = await readTFileContent(activeFile, this.app.vault)
      const tail = originalContent.slice(head.length + selected.length)
      const newContent = head + rewritten + tail

      await this.app.workspace.getLeaf(true).setViewState({
        type: APPLY_VIEW_TYPE,
        active: true,
        state: {
          file: activeFile,
          originalContent,
          newContent,
        } satisfies ApplyViewState,
      })

      notice.setMessage('改写结果已生成。')
      this.registerTimeout(() => notice.hide(), 1200)
    } catch (error) {
      if (error?.name === 'AbortError') {
        notice.setMessage('已取消生成。')
        this.registerTimeout(() => notice.hide(), 1000)
      } else {
        console.error(error)
        notice.setMessage('改写失败。')
        this.registerTimeout(() => notice.hide(), 1200)
      }
    } finally {
      if (controller) this.activeAbortControllers.delete(controller)
    }
  }

  async onload() {
    await this.loadSettings()

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this))
    this.registerView(APPLY_VIEW_TYPE, (leaf) => new ApplyView(leaf))

    this.registerEditorExtension(this.createCustomContinueTriggerExtension())

    // This creates an icon in the left ribbon.
    this.addRibbonIcon('wand-sparkles', this.t('commands.openChat'), () =>
      this.openChatView(),
    )

    // This adds a simple command that can be triggered anywhere
    this.addCommand({
      id: 'open-new-chat',
      name: this.t('commands.openChat'),
      callback: () => this.openChatView(true),
    })

    // Global ESC to cancel any ongoing AI continuation/rewrite
    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Do not prevent default so other ESC behaviors (close modals, etc.) still work
        this.cancelAllAiTasks()
      }
    })

    this.addCommand({
      id: 'add-selection-to-chat',
      name: this.t('commands.addSelectionToChat'),
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.addSelectionToChat(editor, view)
      },
    })

    // Auto update: listen to vault file changes and schedule incremental index updates
    this.registerEvent(
      this.app.vault.on('create', (file) => this.onVaultFileChanged(file)),
    )
    this.registerEvent(
      this.app.vault.on('modify', (file) => this.onVaultFileChanged(file)),
    )
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.onVaultFileChanged(file)),
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.onVaultFileChanged(file)
        if (oldPath) this.onVaultPathChanged(oldPath)
      }),
    )

    this.addCommand({
      id: 'rebuild-vault-index',
      name: this.t('commands.rebuildVaultIndex'),
      callback: async () => {
        const notice = new Notice(this.t('notices.rebuildingIndex'), 0)
        try {
          const ragEngine = await this.getRAGEngine()
          await ragEngine.updateVaultIndex(
            { reindexAll: true },
            (queryProgress) => {
              if (queryProgress.type === 'indexing') {
                const { completedChunks, totalChunks } =
                  queryProgress.indexProgress
                notice.setMessage(
                  `Indexing chunks: ${completedChunks} / ${totalChunks}${
                    queryProgress.indexProgress.waitingForRateLimit
                      ? '\n(waiting for rate limit to reset)'
                      : ''
                  }`,
                )
              }
            },
          )
          notice.setMessage(this.t('notices.rebuildComplete'))
        } catch (error) {
          console.error(error)
          notice.setMessage(this.t('notices.rebuildFailed'))
        } finally {
          this.registerTimeout(() => {
            notice.hide()
          }, 1000)
        }
      },
    })

    this.addCommand({
      id: 'update-vault-index',
      name: this.t('commands.updateVaultIndex'),
      callback: async () => {
        const notice = new Notice(this.t('notices.updatingIndex'), 0)
        try {
          const ragEngine = await this.getRAGEngine()
          await ragEngine.updateVaultIndex(
            { reindexAll: false },
            (queryProgress) => {
              if (queryProgress.type === 'indexing') {
                const { completedChunks, totalChunks } =
                  queryProgress.indexProgress
                notice.setMessage(
                  `Indexing chunks: ${completedChunks} / ${totalChunks}${
                    queryProgress.indexProgress.waitingForRateLimit
                      ? '\n(waiting for rate limit to reset)'
                      : ''
                  }`,
                )
              }
            },
          )
          notice.setMessage(this.t('notices.indexUpdated'))
        } catch (error) {
          console.error(error)
          notice.setMessage(this.t('notices.indexUpdateFailed'))
        } finally {
          this.registerTimeout(() => {
            notice.hide()
          }, 1000)
        }
      },
    })
    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new SmartComposerSettingTab(this.app, this))

    // removed templates JSON migration

    // Handle tab completion trigger
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        try {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView)
          const editor = view?.editor
          if (!editor) return
          this.handleTabCompletionEditorChange(editor)
          // Update selection manager with new editor container
          this.initializeSelectionManager()
        } catch (err) {
          console.error('Editor change handler error:', err)
        }
      }),
    )

    // Initialize selection chat
    this.initializeSelectionManager()
  }

  onunload() {
    this.closeCustomContinueWidget()
    
    // Selection chat cleanup
    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }
    if (this.selectionManager) {
      this.selectionManager.destroy()
      this.selectionManager = null
    }
    
    // clear all timers
    this.timeoutIds.forEach((id) => clearTimeout(id))
    this.timeoutIds = []

    // RagEngine cleanup
    this.ragEngine?.cleanup()
    this.ragEngine = null

    // Promise cleanup
    this.dbManagerInitPromise = null
    this.ragEngineInitPromise = null

    // DatabaseManager cleanup
    this.dbManager?.cleanup()
    this.dbManager = null

    // McpManager cleanup
    this.mcpManager?.cleanup()
    this.mcpManager = null
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer)
      this.autoUpdateTimer = null
    }
    // Ensure all in-flight requests are aborted on unload
    this.cancelAllAiTasks()
    this.clearTabCompletionTimer()
    this.cancelTabCompletionRequest()
    this.clearInlineSuggestion()
  }

  async loadSettings() {
    this.settings = parseSmartComposerSettings(await this.loadData())
    await this.saveData(this.settings) // Save updated settings
  }

  async setSettings(newSettings: SmartComposerSettings) {
    const validationResult = smartComposerSettingsSchema.safeParse(newSettings)

    if (!validationResult.success) {
      new Notice(`Invalid settings:
${validationResult.error.issues.map((v) => v.message).join('\n')}`)
      return
    }

    this.settings = newSettings
    await this.saveData(newSettings)
    this.ragEngine?.setSettings(newSettings)
    this.settingsChangeListeners.forEach((listener) => listener(newSettings))
  }

  addSettingsChangeListener(
    listener: (newSettings: SmartComposerSettings) => void,
  ) {
    this.settingsChangeListeners.push(listener)
    return () => {
      this.settingsChangeListeners = this.settingsChangeListeners.filter(
        (l) => l !== listener,
      )
    }
  }

  async openChatView(openNewChat = false) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor
    if (!view || !editor) {
      this.activateChatView(undefined, openNewChat)
      return
    }
    const selectedBlockData = await getMentionableBlockData(editor, view)
    this.activateChatView(
      {
        selectedBlock: selectedBlockData ?? undefined,
      },
      openNewChat,
    )
  }

  async activateChatView(chatProps?: ChatProps, openNewChat = false) {
    // chatProps is consumed in ChatView.tsx
    this.initialChatProps = chatProps

    const leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]

    await (leaf ?? this.app.workspace.getRightLeaf(false))?.setViewState({
      type: CHAT_VIEW_TYPE,
      active: true,
    })

    if (openNewChat && leaf && leaf.view instanceof ChatView) {
      leaf.view.openNewChat(chatProps?.selectedBlock)
    }

    this.app.workspace.revealLeaf(
      this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0],
    )
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    const data = await getMentionableBlockData(editor, view)
    if (!data) return

    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({
        selectedBlock: data,
      })
      return
    }

    // bring leaf to foreground (uncollapse sidebar if it's collapsed)
    await this.app.workspace.revealLeaf(leaves[0])

    const chatView = leaves[0].view
    chatView.addSelectionToChat(data)
    chatView.focusMessage()
  }

  async getDbManager(): Promise<DatabaseManager> {
    if (this.dbManager) {
      return this.dbManager
    }

    if (!this.dbManagerInitPromise) {
      this.dbManagerInitPromise = (async () => {
        try {
          this.dbManager = await DatabaseManager.create(
            this.app,
            this.resolvePgliteResourcePath(),
          )
          return this.dbManager
        } catch (error) {
          this.dbManagerInitPromise = null
          if (error instanceof PGLiteAbortedException) {
            new InstallerUpdateRequiredModal(this.app).open()
          }
          throw error
        }
      })()
    }

    // if initialization is running, wait for it to complete instead of creating a new initialization promise
    return this.dbManagerInitPromise
  }

  async tryGetVectorManager(): Promise<VectorManager | null> {
    try {
      const dbManager = await this.getDbManager()
      return dbManager.getVectorManager()
    } catch (error) {
      console.warn(
        '[Smart Composer] Failed to initialize vector manager, skip vector-dependent operations.',
        error,
      )
      return null
    }
  }

  async getRAGEngine(): Promise<RAGEngine> {
    if (this.ragEngine) {
      return this.ragEngine
    }

    if (!this.ragEngineInitPromise) {
      this.ragEngineInitPromise = (async () => {
        try {
          const dbManager = await this.getDbManager()
          this.ragEngine = new RAGEngine(
            this.app,
            this.settings,
            dbManager.getVectorManager(),
          )
          return this.ragEngine
        } catch (error) {
          this.ragEngineInitPromise = null
          throw error
        }
      })()
    }

    return this.ragEngineInitPromise
  }

  async getMcpManager(): Promise<McpManager> {
    if (this.mcpManager) {
      return this.mcpManager
    }

    try {
      this.mcpManager = new McpManager({
        settings: this.settings,
        registerSettingsListener: (
          listener: (settings: SmartComposerSettings) => void,
        ) => this.addSettingsChangeListener(listener),
      })
      await this.mcpManager.initialize()
      return this.mcpManager
    } catch (error) {
      this.mcpManager = null
      throw error
    }
  }

  private registerTimeout(callback: () => void, timeout: number): void {
    const timeoutId = setTimeout(callback, timeout)
    this.timeoutIds.push(timeoutId)
  }

  // ===== Auto Update helpers =====
  private onVaultFileChanged(file: TAbstractFile) {
    try {
      // 使用严格类型判断，避免通过 any 访问 path
      if (file instanceof TFile || file instanceof TFolder) {
        this.onVaultPathChanged(file.path)
      }
    } catch {
      // Ignore unexpected file type changes during event handling.
    }
  }

  private onVaultPathChanged(path: string) {
    if (!this.settings?.ragOptions?.autoUpdateEnabled) return
    if (!this.isPathSelectedByIncludeExclude(path)) return
    // Check minimal interval
    const intervalMs =
      (this.settings.ragOptions.autoUpdateIntervalHours ?? 24) * 60 * 60 * 1000
    const last = this.settings.ragOptions.lastAutoUpdateAt ?? 0
    const now = Date.now()
    if (now - last < intervalMs) {
      // Still within cool-down; no action
      return
    }
    // Debounce multiple changes within a short window
    if (this.autoUpdateTimer) clearTimeout(this.autoUpdateTimer)
    this.autoUpdateTimer = setTimeout(() => void this.runAutoUpdate(), 3000)
  }

  private isPathSelectedByIncludeExclude(path: string): boolean {
    const { includePatterns = [], excludePatterns = [] } =
      this.settings?.ragOptions ?? {}
    // Exclude has priority
    if (excludePatterns.some((p) => minimatch(path, p))) return false
    if (!includePatterns || includePatterns.length === 0) return true
    return includePatterns.some((p) => minimatch(path, p))
  }

  private async runAutoUpdate() {
    if (this.isAutoUpdating) return
    this.isAutoUpdating = true
    try {
      const ragEngine = await this.getRAGEngine()
      await ragEngine.updateVaultIndex({ reindexAll: false }, undefined)
      await this.setSettings({
        ...this.settings,
        ragOptions: {
          ...this.settings.ragOptions,
          lastAutoUpdateAt: Date.now(),
        },
      })
      new Notice(this.t('notices.indexUpdated'))
    } catch (e) {
      console.error('Auto update index failed:', e)
      new Notice(this.t('notices.indexUpdateFailed'))
    } finally {
      this.isAutoUpdating = false
      this.autoUpdateTimer = null
    }
  }

  // Public wrapper for use in React modal
  async continueWriting(
    editor: Editor,
    customPrompt?: string,
    geminiTools?: { useWebSearch?: boolean; useUrlContext?: boolean },
  ) {
    // Check if this is actually a rewrite request from Selection Chat
    if (this.pendingSelectionRewrite) {
      const { editor: rewriteEditor, selectedText, from } = this.pendingSelectionRewrite
      this.pendingSelectionRewrite = null // Clear the pending state
      
      // Pass the pre-saved selectedText and position directly to handleCustomRewrite
      // No need to re-select or check current selection
      await this.handleCustomRewrite(rewriteEditor, customPrompt, selectedText, from)
      return
    }
    return this.handleContinueWriting(editor, customPrompt, geminiTools)
  }

  // Public wrapper for use in React panel
  async customRewrite(editor: Editor, customPrompt?: string) {
    return this.handleCustomRewrite(editor, customPrompt)
  }

  private async handleContinueWriting(
    editor: Editor,
    customPrompt?: string,
    geminiTools?: { useWebSearch?: boolean; useUrlContext?: boolean },
  ) {
    let controller: AbortController | null = null
    try {
      const notice = new Notice('Generating continuation...', 0)
      const cursor = editor.getCursor()
      const selected = editor.getSelection()
      const headText = editor.getRange({ line: 0, ch: 0 }, cursor)

      // Prefer selected text as context when available; otherwise use preceding content
      const hasSelection = !!selected && selected.trim().length > 0
      const baseContext = hasSelection ? selected : headText
      const fallbackInstruction = (customPrompt ?? '').trim()
      const fileTitleCandidate =
        this.app.workspace.getActiveFile()?.basename?.trim() ?? ''

      if (!baseContext || baseContext.trim().length === 0) {
        // 没有前文时，如果既没有自定义指令也没有文件标题，则提示无法续写；
        // 否则允许基于标题或自定义指令开始写作
        if (!fallbackInstruction && !fileTitleCandidate) {
          notice.setMessage('No preceding content to continue.')
          this.registerTimeout(() => notice.hide(), 1000)
          return
        }
      }

      const referenceRuleFolders =
        this.settings.continuationOptions?.referenceRuleFolders ??
        this.settings.continuationOptions?.manualContextFolders ??
        []

      let referenceRulesSection = ''
      if (referenceRuleFolders.length > 0) {
        try {
          const referenceFilesMap = new Map<string, TFile>()
          const isSupportedReferenceFile = (file: TFile) => {
            const ext = file.extension?.toLowerCase?.() ?? ''
            return ext === 'md' || ext === 'markdown' || ext === 'txt'
          }

          for (const rawPath of referenceRuleFolders) {
            const folderPath = rawPath.trim()
            if (!folderPath) continue
            const abstract = this.app.vault.getAbstractFileByPath(folderPath)
            if (abstract instanceof TFolder) {
              for (const file of getNestedFiles(abstract, this.app.vault)) {
                if (isSupportedReferenceFile(file)) {
                  referenceFilesMap.set(file.path, file)
                }
              }
            } else if (abstract instanceof TFile) {
              if (isSupportedReferenceFile(abstract)) {
                referenceFilesMap.set(abstract.path, abstract)
              }
            }
          }

          const referenceFiles = Array.from(referenceFilesMap.values())
          if (referenceFiles.length > 0) {
            const referenceContents = await readMultipleTFiles(
              referenceFiles,
              this.app.vault,
            )
            const referenceLabel = this.t(
              'sidebar.composer.referenceRulesTitle',
              'Reference rules',
            )
            const blocks = referenceFiles.map((file, index) => {
              const content = referenceContents[index] ?? ''
              return `File: ${file.path}\n${content}`
            })
            const combinedReference = blocks.join('\n\n')
            if (combinedReference.trim().length > 0) {
              referenceRulesSection = `${referenceLabel}:\n\n${combinedReference}\n\n`
            }
          }
        } catch (error) {
          console.warn(
            'Failed to load reference rule folders for continuation',
            error,
          )
        }
      }

      // Truncate context to avoid exceeding model limits (simple char-based cap)
      const continuationCharLimit = Math.max(
        0,
        this.settings.continuationOptions?.maxContinuationChars ?? 8000,
      )
      const limitedContext =
        continuationCharLimit > 0 && baseContext.length > continuationCharLimit
          ? baseContext.slice(-continuationCharLimit)
          : continuationCharLimit === 0
            ? ''
            : baseContext

      const continuationModelId =
        this.settings.continuationOptions?.continuationModelId ??
        this.settings.chatModelId

      const sidebarOverrides = this.getActiveConversationOverrides()
      const {
        temperature,
        topP,
        stream: streamPreference,
        useVaultSearch,
      } = this.resolveContinuationParams(sidebarOverrides)

      const { providerClient, model } = getChatModelClient({
        settings: this.settings,
        modelId: continuationModelId,
      })

      const userInstruction = (customPrompt ?? '').trim()
      const instructionSection = userInstruction
        ? `Instruction:\n${userInstruction}\n\n`
        : ''

      const systemPrompt = (this.settings.systemPrompt ?? '').trim()

      const activeFileForTitle = this.app.workspace.getActiveFile()
      const fileTitle = activeFileForTitle?.basename?.trim() ?? ''
      const titleLine = fileTitle ? `File title: ${fileTitle}\n\n` : ''
      const hasContext = (baseContext ?? '').trim().length > 0

      let ragContextSection = ''
      const knowledgeBaseRaw =
        this.settings.continuationOptions?.knowledgeBaseFolders ?? []
      const knowledgeBaseFolders: string[] = []
      const knowledgeBaseFiles: string[] = []
      for (const raw of knowledgeBaseRaw) {
        const trimmed = raw.trim()
        if (!trimmed) continue
        const abstract = this.app.vault.getAbstractFileByPath(trimmed)
        if (abstract instanceof TFolder) {
          knowledgeBaseFolders.push(abstract.path)
        } else if (abstract instanceof TFile) {
          knowledgeBaseFiles.push(abstract.path)
        }
      }
      const ragGloballyEnabled = Boolean(this.settings.ragOptions?.enabled)
      if (useVaultSearch && ragGloballyEnabled) {
        try {
          const querySource = (
            baseContext ||
            userInstruction ||
            fileTitle
          ).trim()
          if (querySource.length > 0) {
            const ragEngine = await this.getRAGEngine()
            const ragResults = await ragEngine.processQuery({
              query: querySource.slice(-4000),
              scope:
                knowledgeBaseFolders.length > 0 || knowledgeBaseFiles.length > 0
                  ? {
                      folders: knowledgeBaseFolders,
                      files: knowledgeBaseFiles,
                    }
                  : undefined,
            })
            const snippetLimit = Math.max(
              1,
              Math.min(this.settings.ragOptions?.limit ?? 10, 10),
            )
            const snippets = ragResults.slice(0, snippetLimit)
            if (snippets.length > 0) {
              const formatted = snippets
                .map((snippet, index) => {
                  const content = (snippet.content ?? '').trim()
                  const truncated =
                    content.length > 600
                      ? `${content.slice(0, 600)}...`
                      : content
                  return `Snippet ${index + 1} (from ${snippet.path}):\n${truncated}`
                })
                .join('\n\n')
              if (formatted.trim().length > 0) {
                ragContextSection = `Vault snippets:\n\n${formatted}\n\n`
              }
            }
          }
        } catch (error) {
          console.warn('Continuation RAG lookup failed:', error)
        }
      }

      const limitedContextHasContent = limitedContext.trim().length > 0
      const contextSection =
        hasContext && limitedContextHasContent
          ? `Context (up to recent portion):\n\n${limitedContext}\n\n`
          : ''
      const baseModelContextSection = `${
        referenceRulesSection
      }${hasContext && limitedContextHasContent ? `${limitedContext}\n\n` : ''}${ragContextSection}`
      const combinedContextSection = `${referenceRulesSection}${contextSection}${ragContextSection}`

      const isBaseModel = Boolean((model as any).isBaseModel)
      const baseModelSpecialPrompt = (
        this.settings.chatOptions.baseModelSpecialPrompt ?? ''
      ).trim()
      const basePromptSection =
        isBaseModel && baseModelSpecialPrompt.length > 0
          ? `${baseModelSpecialPrompt}\n\n`
          : ''
      const baseModelCoreContent = `${basePromptSection}${titleLine}${instructionSection}${baseModelContextSection}`

      const userMessageContent = isBaseModel
        ? `${baseModelCoreContent}`
        : `${basePromptSection}${titleLine}${instructionSection}${combinedContextSection}`

      const requestMessages = [
        ...(!isBaseModel && systemPrompt.length > 0
          ? ([
              {
                role: 'system' as const,
                content: systemPrompt,
              },
            ] as const)
          : []),
        {
          role: 'user' as const,
          content: userMessageContent,
        },
      ] as const

      // Mark in-progress to avoid re-entrancy from keyword trigger during insertion
      this.isContinuationInProgress = true

      const view = this.getEditorView(editor)
      if (!view) {
        notice.setMessage('Unable to access editor view.')
        this.registerTimeout(() => notice.hide(), 1200)
        return
      }

      this.ensureInlineSuggestionExtension(view)
      this.clearInlineSuggestion()

      let hasClosedSmartSpaceWidget = false
      const closeSmartSpaceWidgetOnce = () => {
        if (!hasClosedSmartSpaceWidget) {
          this.closeCustomContinueWidget()
          hasClosedSmartSpaceWidget = true
        }
      }

      // Stream response and progressively update ghost suggestion
      controller = new AbortController()
      this.activeAbortControllers.add(controller)

      const baseRequest: any = {
        model: model.model,
        messages: requestMessages as unknown as any,
      }
      if (typeof temperature === 'number') {
        baseRequest.temperature = temperature
      }
      if (typeof topP === 'number') {
        baseRequest.top_p = topP
      }

      console.debug('Continuation request params', {
        overrides: sidebarOverrides,
        request: baseRequest,
        streamPreference,
        useVaultSearch,
      })

      // Insert at current cursor by default; if a selection exists, insert at selection end
      let insertStart = editor.getCursor()
      if (hasSelection) {
        const endPos = editor.getCursor('to')
        editor.setCursor(endPos)
        insertStart = endPos
      }
      const startLine = view.state.doc.line(insertStart.line + 1)
      const startOffset = startLine.from + insertStart.ch
      let suggestionText = ''

      const updateContinuationSuggestion = (text: string) => {
        this.setInlineSuggestionGhost(view, { from: startOffset, text })
        this.activeInlineSuggestion = {
          source: 'continuation',
          editor,
          view,
          fromOffset: startOffset,
          text,
        }
        this.continuationInlineSuggestion = {
          editor,
          view,
          text,
          fromOffset: startOffset,
          startPos: insertStart,
        }
      }

      if (streamPreference) {
        const streamIterator = await providerClient.streamResponse(
          model,
          { ...baseRequest, stream: true },
          { signal: controller.signal, geminiTools },
        )

        for await (const chunk of streamIterator) {
          const delta = chunk?.choices?.[0]?.delta
          const piece = delta?.content ?? ''
          if (!piece) continue

          suggestionText += piece
          closeSmartSpaceWidgetOnce()
          updateContinuationSuggestion(suggestionText)
        }
      } else {
        const response = await providerClient.generateResponse(
          model,
          { ...baseRequest, stream: false },
          { signal: controller.signal, geminiTools },
        )

        const fullText = response.choices?.[0]?.message?.content ?? ''
        if (fullText) {
          suggestionText = fullText
          closeSmartSpaceWidgetOnce()
          updateContinuationSuggestion(suggestionText)
        }
      }

      if (suggestionText.trim().length > 0) {
        notice.setMessage('Continuation suggestion ready. Press Tab to accept.')
      } else {
        this.clearInlineSuggestion()
        notice.setMessage('No continuation generated.')
      }
      this.registerTimeout(() => notice.hide(), 1200)
    } catch (error) {
      this.clearInlineSuggestion()
      if (error?.name === 'AbortError') {
        const n = new Notice('已取消生成。')
        this.registerTimeout(() => n.hide(), 1000)
      } else {
        console.error(error)
        new Notice('Failed to generate continuation.')
      }
    } finally {
      this.isContinuationInProgress = false
      if (controller) this.activeAbortControllers.delete(controller)
    }
  }

  // removed migrateToJsonStorage (templates)

  private async reloadChatView() {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      return
    }
    new Notice('Reloading "next-composer" due to migration', 1000)
    leaves[0].detach()
    await this.activateChatView()
  }
}
