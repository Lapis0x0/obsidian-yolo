import {
  EditorSelection,
  type Extension,
  Prec,
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
import { SerializedEditorState } from 'lexical'
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
import { QuickAskWidget } from './components/panels/quick-ask'
import { SmartSpaceWidget } from './components/panels/SmartSpacePanel'
import { SelectionChatWidget } from './components/selection/SelectionChatWidget'
import { SelectionManager } from './components/selection/SelectionManager'
import type { SelectionInfo } from './components/selection/SelectionManager'
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
  LLMRequestBase,
  LLMRequestNonStreaming,
  RequestMessage,
} from './types/llm/request'
import {
  MentionableFile,
  MentionableFolder,
  SerializedMentionable,
} from './types/mentionable'
import {
  getMentionableBlockData,
  getNestedFiles,
  readMultipleTFiles,
  readTFileContent,
} from './utils/obsidian'

type InlineSuggestionGhostPayload = { from: number; text: string } | null

const inlineSuggestionGhostEffect =
  StateEffect.define<InlineSuggestionGhostPayload>()

type ThinkingIndicatorPayload = {
  from: number
  label: string
  snippet?: string
} | null

const thinkingIndicatorEffect = StateEffect.define<ThinkingIndicatorPayload>()

class ThinkingIndicatorWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly snippet?: string,
  ) {
    super()
  }

  eq(other: ThinkingIndicatorWidget) {
    return this.label === other.label && this.snippet === other.snippet
  }

  ignoreEvent(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span')
    container.className = 'smtcmp-thinking-indicator-inline'

    // 创建思考动画容器
    const loader = document.createElement('span')
    loader.className = 'smtcmp-thinking-loader'

    // 图标容器
    const icon = document.createElement('span')
    icon.className = 'smtcmp-thinking-icon'

    // SVG 图标 (Sparkles)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '12')
    svg.setAttribute('height', '12')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.classList.add('smtcmp-thinking-icon-svg')

    const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path1.setAttribute(
      'd',
      'm12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z',
    )
    const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path2.setAttribute('d', 'M5 3v4')
    const path3 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path3.setAttribute('d', 'M19 17v4')
    const path4 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path4.setAttribute('d', 'M3 5h4')
    const path5 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path5.setAttribute('d', 'M17 19h4')

    svg.appendChild(path1)
    svg.appendChild(path2)
    svg.appendChild(path3)
    svg.appendChild(path4)
    svg.appendChild(path5)

    icon.appendChild(svg)

    // 文字
    const textEl = document.createElement('span')
    textEl.className = 'smtcmp-thinking-text'
    textEl.textContent = this.label

    loader.appendChild(icon)
    loader.appendChild(textEl)
    if (this.snippet) {
      const snippetEl = document.createElement('span')
      snippetEl.className = 'smtcmp-thinking-snippet'
      snippetEl.textContent = this.snippet
      loader.appendChild(snippetEl)
    }
    container.appendChild(loader)

    return container
  }
}

const thinkingIndicatorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(value, tr) {
    let decorations = value.map(tr.changes)

    for (const effect of tr.effects) {
      if (effect.is(thinkingIndicatorEffect)) {
        const payload = effect.value
        if (!payload) {
          decorations = Decoration.none
          continue
        }
        const widget = Decoration.widget({
          widget: new ThinkingIndicatorWidget(payload.label, payload.snippet),
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

type SmartSpaceWidgetPayload = {
  pos: number
  options: {
    plugin: SmartComposerPlugin
    editor: Editor
    view: EditorView
    onClose: () => void
    showQuickActions?: boolean
  }
}

const smartSpaceWidgetEffect =
  StateEffect.define<SmartSpaceWidgetPayload | null>()

const smartSpaceWidgetField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    let updated = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(smartSpaceWidgetEffect)) {
        updated = Decoration.none
        const payload = effect.value
        if (payload) {
          updated = Decoration.set([
            Decoration.widget({
              widget: new SmartSpaceWidget(payload.options),
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

type SmartSpaceDraftState = {
  instructionText?: string
  mentionables?: SerializedMentionable[]
  editorState?: SerializedEditorState
} | null

// Quick Ask Widget types and state
type QuickAskWidgetPayload = {
  pos: number
  options: {
    plugin: SmartComposerPlugin
    editor: Editor
    view: EditorView
    contextText: string
    onClose: () => void
  }
}

const quickAskWidgetEffect = StateEffect.define<QuickAskWidgetPayload | null>()

const quickAskWidgetField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    let updated = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(quickAskWidgetEffect)) {
        updated = Decoration.none
        const payload = effect.value
        if (payload) {
          updated = Decoration.set([
            Decoration.widget({
              widget: new QuickAskWidget(payload.options),
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
  private smartSpaceDraftState: SmartSpaceDraftState = null
  private smartSpaceWidgetState: {
    view: EditorView
    pos: number
    close: () => void
  } | null = null
  private lastSmartSpaceSlash: {
    view: EditorView
    pos: number
    timestamp: number
  } | null = null
  private lastSmartSpaceSpace: {
    view: EditorView
    pos: number
    timestamp: number
  } | null = null
  // Selection chat state
  private selectionManager: SelectionManager | null = null
  private selectionChatWidget: SelectionChatWidget | null = null
  private pendingSelectionRewrite: {
    editor: Editor
    selectedText: string
    from: { line: number; ch: number }
    to: { line: number; ch: number }
  } | null = null
  // Model list cache for provider model fetching
  private modelListCache: Map<string, { models: string[]; timestamp: number }> =
    new Map()
  // Quick Ask state
  private quickAskWidgetState: {
    view: EditorView
    pos: number
    close: () => void
  } | null = null

  getSmartSpaceDraftState(): SmartSpaceDraftState {
    return this.smartSpaceDraftState
  }

  setSmartSpaceDraftState(state: SmartSpaceDraftState) {
    this.smartSpaceDraftState = state
  }

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
      const view = this.getEditorView(editor)
      if (!view) return undefined
      const head = view.state.selection.main.head
      const rect = view.coordsAtPos(head)
      if (!rect) return undefined
      const base = typeof rect.bottom === 'number' ? rect.bottom : rect.top
      if (typeof base !== 'number') return undefined
      const y = base + dy
      return { x: rect.left, y }
    } catch {
      // ignore
    }
    return undefined
  }

  private closeSmartSpace() {
    const state = this.smartSpaceWidgetState
    if (!state) return

    // 先清除状态，避免重复关闭
    this.smartSpaceWidgetState = null

    // Clear pending selection rewrite if user closes without submitting
    this.pendingSelectionRewrite = null

    // 尝试触发关闭动画
    const hasAnimation = SmartSpaceWidget.closeCurrentWithAnimation()

    if (!hasAnimation) {
      // 如果没有动画实例，直接分发关闭效果
      state.view.dispatch({ effects: smartSpaceWidgetEffect.of(null) })
    }

    state.view.focus()
  }

  private showSmartSpace(
    editor: Editor,
    view: EditorView,
    showQuickActions = true,
  ) {
    const selection = view.state.selection.main
    // Use the end of selection (max of head and anchor) to always position at the visual end
    // This ensures the widget appears below the selection regardless of selection direction
    const pos = Math.max(selection.head, selection.anchor)

    this.closeSmartSpace()

    const close = () => {
      // 检查是否是当前的 widget（允许状态为 null，因为可能在动画期间被清除）
      if (
        this.smartSpaceWidgetState &&
        this.smartSpaceWidgetState.view !== view
      ) {
        return
      }
      this.smartSpaceWidgetState = null
      view.dispatch({ effects: smartSpaceWidgetEffect.of(null) })
      view.focus()
    }

    view.dispatch({
      effects: [
        smartSpaceWidgetEffect.of(null),
        smartSpaceWidgetEffect.of({
          pos,
          options: {
            plugin: this,
            editor,
            view,
            onClose: close,
            showQuickActions,
          },
        }),
      ],
    })

    this.smartSpaceWidgetState = { view, pos, close }
  }

  // Quick Ask methods
  private closeQuickAsk() {
    const state = this.quickAskWidgetState
    if (!state) return

    // Clear state to prevent duplicate close
    this.quickAskWidgetState = null

    // Try to trigger close animation
    const hasAnimation = QuickAskWidget.closeCurrentWithAnimation()

    if (!hasAnimation) {
      // If no animation instance, dispatch close effect directly
      state.view.dispatch({ effects: quickAskWidgetEffect.of(null) })
    }

    state.view.focus()
  }

  private showQuickAsk(editor: Editor, view: EditorView) {
    const selection = view.state.selection.main
    const pos = selection.head

    // Get context text (all text before cursor)
    const contextText = editor.getRange({ line: 0, ch: 0 }, editor.getCursor())

    // Close any existing Quick Ask panel
    this.closeQuickAsk()
    // Also close Smart Space if open
    this.closeSmartSpace()

    const close = () => {
      const isCurrentView =
        !this.quickAskWidgetState || this.quickAskWidgetState.view === view

      if (isCurrentView) {
        this.quickAskWidgetState = null
      }
      view.dispatch({ effects: quickAskWidgetEffect.of(null) })

      if (isCurrentView) {
        view.focus()
      }
    }

    view.dispatch({
      effects: [
        quickAskWidgetEffect.of(null),
        quickAskWidgetEffect.of({
          pos,
          options: {
            plugin: this,
            editor,
            view,
            contextText,
            onClose: close,
          },
        }),
      ],
    })

    this.quickAskWidgetState = { view, pos, close }
  }

  private createQuickAskTriggerExtension(): Extension {
    return [
      quickAskWidgetField,
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          // Check if Quick Ask feature is enabled (default: true)
          const enableQuickAsk =
            this.settings.continuationOptions?.enableQuickAsk ?? true
          if (!enableQuickAsk) {
            return false
          }

          if (event.defaultPrevented) {
            return false
          }

          // Don't trigger with modifier keys (except Shift for special chars like @)
          if (event.altKey || event.metaKey || event.ctrlKey) {
            return false
          }

          // Get trigger string from settings (default: @)
          const triggerStr =
            this.settings.continuationOptions?.quickAskTrigger ?? '@'

          // Determine what character the user is typing
          let typedChar = event.key
          // Special handling for @ which may be Shift+2 on some keyboards
          if (event.key === '2' && event.shiftKey) {
            typedChar = '@'
          }

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

          const markdownView =
            this.app.workspace.getActiveViewOfType(MarkdownView)
          const editor = markdownView?.editor
          if (!editor) {
            return false
          }

          const activeView = this.getEditorView(editor)
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
          this.showQuickAsk(editor, view)
          return true
        },
      }),
      EditorView.updateListener.of((update) => {
        const state = this.quickAskWidgetState
        if (!state || state.view !== update.view) return

        if (update.docChanged) {
          state.pos = update.changes.mapPos(state.pos)
        }
      }),
    ]
  }

  // Selection Chat methods
  private initializeSelectionManager() {
    // Check if Selection Chat is enabled
    const enableSelectionChat =
      this.settings.continuationOptions?.enableSelectionChat ?? true

    // Clean up existing manager
    if (this.selectionManager) {
      this.selectionManager.destroy()
      this.selectionManager = null
    }

    // Don't initialize if disabled
    if (!enableSelectionChat) {
      return
    }

    // Get the active editor container
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) return

    const editorContainer = view.containerEl.querySelector('.cm-editor')
    if (!editorContainer) return

    // Create new selection manager
    this.selectionManager = new SelectionManager(
      editorContainer as HTMLElement,
      {
        enabled: true,
        minSelectionLength: 6,
        debounceDelay: 300,
      },
    )

    // Initialize with callback
    this.selectionManager.init((selection: SelectionInfo | null) => {
      this.handleSelectionChange(selection, view.editor)
    })
  }

  private handleSelectionChange(
    selection: SelectionInfo | null,
    editor: Editor,
  ) {
    // Close existing widget
    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }

    // Don't show if Smart Space is active
    if (this.smartSpaceWidgetState) {
      return
    }

    // Show new widget if selection is valid
    if (selection) {
      const currentView = this.app.workspace.getActiveViewOfType(MarkdownView)
      const editorContainer =
        currentView?.containerEl.querySelector('.cm-editor')
      if (!editorContainer) {
        return
      }

      this.selectionChatWidget = new SelectionChatWidget({
        plugin: this,
        editor,
        selection,
        editorContainer: editorContainer as HTMLElement,
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
        this.rewriteSelection(editor, selectedText)
        break

      case 'explain':
        // Add selection as badge and pre-fill explanation prompt
        await this.explainSelection(editor)
        break

      default:
        console.warn('Unknown selection action:', actionId)
    }
  }

  private async addTextToChat(_text: string) {
    // Get current file and editor info for context
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor

    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    // Create mentionable block data from selection
    const data = getMentionableBlockData(editor, view)
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

  private rewriteSelection(editor: Editor, selectedText: string) {
    // Show Smart Space-like input for rewrite instruction
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) return

    // Get CodeMirror view
    const cmEditor = this.getEditorView(editor)
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
    this.showSmartSpace(editor, cmEditor, true)
  }

  private async explainSelection(editor: Editor) {
    // Add selection as badge to chat and pre-fill explanation prompt
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    // Create mentionable block data from selection
    const data = getMentionableBlockData(editor, view)
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
        chatView.insertTextToInput(
          this.t('selection.actions.explain', '请深入解释') + '：',
        )
        chatView.focusMessage()
      }
      return
    }

    // Use existing chat view
    await this.app.workspace.revealLeaf(leaves[0])
    const chatView = leaves[0].view
    chatView.addSelectionToChat(data)
    chatView.insertTextToInput(
      this.t('selection.actions.explain', '请深入解释') + '：',
    )
    chatView.focusMessage()
  }

  private createSmartSpaceTriggerExtension(): Extension {
    return [
      smartSpaceWidgetField,
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          const smartSpaceEnabled =
            this.settings.continuationOptions?.enableSmartSpace ?? true
          if (!smartSpaceEnabled) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }
          if (event.defaultPrevented) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
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
            this.lastSmartSpaceSpace = null
            return false
          }
          if (event.altKey || event.metaKey || event.ctrlKey) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }

          const selection = view.state.selection.main
          if (!selection.empty) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }

          const markdownView =
            this.app.workspace.getActiveViewOfType(MarkdownView)
          const editor = markdownView?.editor
          if (!editor) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }
          const activeView = this.getEditorView(editor)
          if (activeView && activeView !== view) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }

          if (isSlash) {
            this.lastSmartSpaceSlash = {
              view,
              pos: selection.head,
              timestamp: Date.now(),
            }
            this.lastSmartSpaceSpace = null
            return false
          }

          // Space handling (either legacy single-space trigger, or slash + space)
          const now = Date.now()
          const triggerMode =
            this.settings.continuationOptions?.smartSpaceTriggerMode ??
            'single-space'
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
              this.lastSmartSpaceSpace = null
              return false
            }

            if (triggerMode === 'off') {
              this.lastSmartSpaceSpace = null
              return false
            }

            if (triggerMode === 'double-space') {
              const lastSpace = this.lastSmartSpaceSpace
              const isDoublePress =
                lastSpace &&
                lastSpace.view === view &&
                now - lastSpace.timestamp <= 600 &&
                lastSpace.pos + 1 === selectionAfterRemoval.head &&
                view.state.doc.sliceString(lastSpace.pos, lastSpace.pos + 1) ===
                  ' '
              if (!isDoublePress || !lastSpace) {
                this.lastSmartSpaceSpace = {
                  view,
                  pos: selectionAfterRemoval.head,
                  timestamp: now,
                }
                return false
              }

              view.dispatch({
                changes: {
                  from: lastSpace.pos,
                  to: Math.min(lastSpace.pos + 1, view.state.doc.length),
                },
                selection: EditorSelection.cursor(lastSpace.pos),
              })
              selectionAfterRemoval = view.state.selection.main
              this.lastSmartSpaceSpace = null
            } else {
              this.lastSmartSpaceSpace = null
            }
          } else {
            this.lastSmartSpaceSpace = null
          }

          event.preventDefault()
          event.stopPropagation()

          this.showSmartSpace(editor, view)
          return true
        },
      }),
      EditorView.updateListener.of((update) => {
        const state = this.smartSpaceWidgetState
        if (!state || state.view !== update.view) return

        if (update.docChanged) {
          state.pos = update.changes.mapPos(state.pos)
        }

        if (update.selectionSet) {
          const head = update.state.selection.main
          if (!head.empty || head.head !== state.pos) {
            this.closeSmartSpace()
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
    if (this.isEditorWithCodeMirror(editor)) {
      const { cm } = editor
      if (cm instanceof EditorView) {
        return cm
      }
    }
    return null
  }

  private isEditorWithCodeMirror(
    editor: Editor,
  ): editor is Editor & { cm?: EditorView } {
    if (typeof editor !== 'object' || editor === null || !('cm' in editor)) {
      return false
    }
    const maybeEditor = editor as Editor & { cm?: EditorView }
    return maybeEditor.cm instanceof EditorView
  }

  private ensureInlineSuggestionExtension(view: EditorView) {
    if (inlineSuggestionExtensionViews.has(view)) return
    view.dispatch({
      effects: StateEffect.appendConfig.of([
        inlineSuggestionGhostField,
        thinkingIndicatorField,
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

  private showThinkingIndicator(
    view: EditorView,
    from: number,
    label: string,
    snippet?: string,
  ) {
    this.ensureInlineSuggestionExtension(view)
    view.dispatch({
      effects: thinkingIndicatorEffect.of({
        from,
        label,
        snippet,
      }),
    })
  }

  private hideThinkingIndicator(view: EditorView) {
    view.dispatch({ effects: thinkingIndicatorEffect.of(null) })
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

      const isBaseModel = Boolean(model.isBaseModel)
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

      const requestMessages: RequestMessage[] = [
        ...(isBaseModel
          ? []
          : [
              {
                role: 'system' as const,
                content: systemPrompt,
              },
            ]),
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

      const baseRequest: LLMRequestNonStreaming = {
        model: model.model,
        messages: requestMessages,
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
    // 立即创建并注册 AbortController
    const controller = new AbortController()
    this.activeAbortControllers.add(controller)

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
      const isBaseModel = Boolean(model.isBaseModel)
      const baseModelSpecialPrompt = (
        this.settings.chatOptions.baseModelSpecialPrompt ?? ''
      ).trim()
      const basePromptSection =
        isBaseModel && baseModelSpecialPrompt.length > 0
          ? `${baseModelSpecialPrompt}\n\n`
          : ''
      const requestMessages: RequestMessage[] = [
        ...(isBaseModel
          ? []
          : [
              {
                role: 'system' as const,
                content: systemPrompt,
              },
            ]),
        {
          role: 'user' as const,
          content: `${basePromptSection}Instruction:\n${instruction}\n\nSelected text:\n${selected}\n\nRewrite the selected text accordingly. Output only the rewritten text.`,
        },
      ]

      const rewriteRequestBase: LLMRequestBase = {
        model: model.model,
        messages: requestMessages,
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
          // 每次循环都检查是否已被中止
          if (controller.signal.aborted) {
            break
          }

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
      this.activeAbortControllers.delete(controller)
    }
  }

  async onload() {
    await this.loadSettings()

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this))
    this.registerView(APPLY_VIEW_TYPE, (leaf) => new ApplyView(leaf, this))

    this.registerEditorExtension(this.createSmartSpaceTriggerExtension())
    this.registerEditorExtension(this.createQuickAskTriggerExtension())

    // This creates an icon in the left ribbon.
    this.addRibbonIcon('wand-sparkles', this.t('commands.openChat'), () => {
      void this.openChatView()
    })

    // This adds a simple command that can be triggered anywhere
    this.addCommand({
      id: 'open-new-chat',
      name: this.t('commands.openChat'),
      callback: () => {
        void this.openChatView(true)
      },
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
        void this.addSelectionToChat(editor, view)
      },
    })

    // Register file context menu for adding file/folder to chat
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile) {
          menu.addItem((item) => {
            item
              .setTitle(this.t('commands.addFileToChat'))
              .setIcon('message-square-plus')
              .onClick(async () => {
                await this.addFileToChat(file)
              })
          })
        } else if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle(this.t('commands.addFolderToChat'))
              .setIcon('message-square-plus')
              .onClick(async () => {
                await this.addFolderToChat(file)
              })
          })
        }
      }),
    )

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
        // 预检查 PGlite 资源
        try {
          const dbManager = await this.getDbManager()
          const resourceCheck = await dbManager.checkPGliteResources()

          if (!resourceCheck.available) {
            new Notice(
              this.t(
                'notices.pgliteUnavailable',
                'PGlite resources unavailable. Please check your network connection.',
              ),
              5000,
            )
            return
          }

          if (resourceCheck.needsDownload && resourceCheck.fromCDN) {
            new Notice(
              this.t(
                'notices.downloadingPglite',
                'Downloading PGlite dependencies (~20MB). This may take a moment...',
              ),
              5000,
            )
          }
        } catch (error) {
          console.warn('Failed to check PGlite resources:', error)
          // 继续执行，让实际的加载逻辑处理错误
        }

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

    // Listen for settings changes to reinitialize Selection Chat
    this.addSettingsChangeListener((newSettings) => {
      const enableSelectionChat =
        newSettings.continuationOptions?.enableSelectionChat ?? true
      const wasEnabled = this.selectionManager !== null

      if (enableSelectionChat !== wasEnabled) {
        // Re-initialize when the setting changes
        this.initializeSelectionManager()
      }
    })
  }

  onunload() {
    this.closeSmartSpace()

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
    if (this.dbManager) {
      void this.dbManager.cleanup()
    }
    this.dbManager = null

    // McpManager cleanup
    if (this.mcpManager) {
      this.mcpManager.cleanup()
    }
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
      await this.activateChatView(undefined, openNewChat)
      return
    }
    const selectedBlockData = getMentionableBlockData(editor, view)
    await this.activateChatView(
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
    if (leaf && leaf.view instanceof ChatView) {
      leaf.view.setInitialChatProps(chatProps)
    }

    await (leaf ?? this.app.workspace.getRightLeaf(false))?.setViewState({
      type: CHAT_VIEW_TYPE,
      active: true,
    })

    if (openNewChat && leaf && leaf.view instanceof ChatView) {
      leaf.view.openNewChat(chatProps?.selectedBlock)
    }

    const leafToReveal =
      leaf ?? this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]
    if (leafToReveal) {
      await this.app.workspace.revealLeaf(leafToReveal)
    }
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    const data = getMentionableBlockData(editor, view)
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

  async addFileToChat(file: TFile) {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView()
      // Get the newly created chat view
      const newLeaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
      if (newLeaves.length > 0 && newLeaves[0].view instanceof ChatView) {
        const chatView = newLeaves[0].view
        chatView.addFileToChat(file)
        chatView.focusMessage()
      }
      return
    }

    // bring leaf to foreground (uncollapse sidebar if it's collapsed)
    await this.app.workspace.revealLeaf(leaves[0])

    const chatView = leaves[0].view
    chatView.addFileToChat(file)
    chatView.focusMessage()
  }

  async addFolderToChat(folder: TFolder) {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView()
      // Get the newly created chat view
      const newLeaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
      if (newLeaves.length > 0 && newLeaves[0].view instanceof ChatView) {
        const chatView = newLeaves[0].view
        chatView.addFolderToChat(folder)
        chatView.focusMessage()
      }
      return
    }

    // bring leaf to foreground (uncollapse sidebar if it's collapsed)
    await this.app.workspace.revealLeaf(leaves[0])

    const chatView = leaves[0].view
    chatView.addFolderToChat(folder)
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
    mentionables?: (MentionableFile | MentionableFolder)[],
  ) {
    // Check if this is actually a rewrite request from Selection Chat
    if (this.pendingSelectionRewrite) {
      const {
        editor: rewriteEditor,
        selectedText,
        from,
      } = this.pendingSelectionRewrite
      this.pendingSelectionRewrite = null // Clear the pending state

      // Pass the pre-saved selectedText and position directly to handleCustomRewrite
      // No need to re-select or check current selection
      await this.handleCustomRewrite(
        rewriteEditor,
        customPrompt,
        selectedText,
        from,
      )
      return
    }
    return this.handleContinueWriting(
      editor,
      customPrompt,
      geminiTools,
      mentionables,
    )
  }

  // Public wrapper for use in React panel
  async customRewrite(editor: Editor, customPrompt?: string) {
    return this.handleCustomRewrite(editor, customPrompt)
  }

  private async handleContinueWriting(
    editor: Editor,
    customPrompt?: string,
    geminiTools?: { useWebSearch?: boolean; useUrlContext?: boolean },
    mentionables?: (MentionableFile | MentionableFolder)[],
  ) {
    // 先取消所有进行中的任务，避免旧任务的流式响应覆盖新任务的状态
    this.cancelAllAiTasks()
    this.clearInlineSuggestion()

    // 立即创建并注册 AbortController，确保整个流程都能被中止
    const controller = new AbortController()
    this.activeAbortControllers.add(controller)
    let view: EditorView | null = null

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

      let mentionableContextSection = ''
      if (mentionables && mentionables.length > 0) {
        try {
          const fileMap = new Map<string, TFile>()
          for (const mentionable of mentionables) {
            if (mentionable.type === 'file') {
              fileMap.set(mentionable.file.path, mentionable.file)
            } else if (mentionable.type === 'folder') {
              for (const file of getNestedFiles(
                mentionable.folder,
                this.app.vault,
              )) {
                fileMap.set(file.path, file)
              }
            }
          }
          const files = Array.from(fileMap.values())
          if (files.length > 0) {
            const contents = await readMultipleTFiles(files, this.app.vault)
            const mentionLabel = this.t(
              'smartSpace.mentionContextLabel',
              'Mentioned files',
            )
            const combined = files
              .map((file, index) => {
                const content = contents[index] ?? ''
                return `File: ${file.path}\n${content}`
              })
              .join('\n\n')
            if (combined.trim().length > 0) {
              mentionableContextSection = `${mentionLabel}:\n\n${combined}\n\n`
            }
          }
        } catch (error) {
          console.warn(
            'Failed to include mentioned files for Smart Space continuation',
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

      // 检查是否已被中止（RAG 查询可能耗时较长）
      if (controller.signal.aborted) {
        return
      }

      const limitedContextHasContent = limitedContext.trim().length > 0
      const contextSection =
        hasContext && limitedContextHasContent
          ? `Context (up to recent portion):\n\n${limitedContext}\n\n`
          : ''
      const baseModelContextSection = `${
        referenceRulesSection
      }${mentionableContextSection}${
        hasContext && limitedContextHasContent ? `${limitedContext}\n\n` : ''
      }${ragContextSection}`
      const combinedContextSection = `${referenceRulesSection}${mentionableContextSection}${contextSection}${ragContextSection}`

      const isBaseModel = Boolean(model.isBaseModel)
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

      const requestMessages: RequestMessage[] = [
        ...(!isBaseModel && systemPrompt.length > 0
          ? [
              {
                role: 'system' as const,
                content: systemPrompt,
              },
            ]
          : []),
        {
          role: 'user' as const,
          content: userMessageContent,
        },
      ]

      // Mark in-progress to avoid re-entrancy from keyword trigger during insertion
      this.isContinuationInProgress = true

      view = this.getEditorView(editor)
      if (!view) {
        notice.setMessage('Unable to access editor view.')
        this.registerTimeout(() => notice.hide(), 1200)
        return
      }

      this.ensureInlineSuggestionExtension(view)

      // 在光标位置显示思考指示器
      const currentCursor = editor.getCursor()
      const line = view.state.doc.line(currentCursor.line + 1)
      const cursorOffset = line.from + currentCursor.ch
      const thinkingText = this.t('chat.customContinueProcessing', 'Thinking')
      this.showThinkingIndicator(view, cursorOffset, thinkingText)

      let hasClosedSmartSpaceWidget = false
      const closeSmartSpaceWidgetOnce = () => {
        if (!hasClosedSmartSpaceWidget) {
          this.closeSmartSpace()
          hasClosedSmartSpaceWidget = true
        }
      }

      // 立即关闭 Smart Space 面板，避免与内联指示器重复显示
      closeSmartSpaceWidgetOnce()

      // Stream response and progressively update ghost suggestion
      const baseRequest: LLMRequestBase = {
        model: model.model,
        messages: requestMessages,
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
      let hasHiddenThinkingIndicator = false
      const nonNullView = view // TypeScript 类型细化
      let reasoningPreviewBuffer = ''
      let lastReasoningPreview = ''
      const MAX_REASONING_BUFFER = 400

      const formatReasoningPreview = (text: string) => {
        const normalized = text.replace(/\s+/g, ' ').trim()
        if (!normalized) return ''
        if (normalized.length <= 120) {
          return normalized
        }
        return normalized.slice(-120)
      }

      const updateThinkingReasoningPreview = () => {
        if (hasHiddenThinkingIndicator) return
        const preview = formatReasoningPreview(reasoningPreviewBuffer)
        if (!preview || preview === lastReasoningPreview) {
          return
        }
        lastReasoningPreview = preview
        this.showThinkingIndicator(
          nonNullView,
          cursorOffset,
          thinkingText,
          preview,
        )
      }

      const updateContinuationSuggestion = (text: string) => {
        // 首次接收到内容时隐藏思考指示器
        if (!hasHiddenThinkingIndicator) {
          this.hideThinkingIndicator(nonNullView)
          hasHiddenThinkingIndicator = true
        }
        this.setInlineSuggestionGhost(nonNullView, { from: startOffset, text })
        this.activeInlineSuggestion = {
          source: 'continuation',
          editor,
          view: nonNullView,
          fromOffset: startOffset,
          text,
        }
        this.continuationInlineSuggestion = {
          editor,
          view: nonNullView,
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
          // 每次循环都检查是否已被中止
          if (controller.signal.aborted) {
            break
          }

          const delta = chunk?.choices?.[0]?.delta
          const piece = delta?.content ?? ''
          const reasoningDelta = delta?.reasoning ?? ''
          if (reasoningDelta) {
            reasoningPreviewBuffer += reasoningDelta
            if (reasoningPreviewBuffer.length > MAX_REASONING_BUFFER) {
              reasoningPreviewBuffer =
                reasoningPreviewBuffer.slice(-MAX_REASONING_BUFFER)
            }
            updateThinkingReasoningPreview()
          }
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
      // 确保思考指示器被移除
      if (view) {
        this.hideThinkingIndicator(view)
      }
      this.isContinuationInProgress = false
      this.activeAbortControllers.delete(controller)
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
