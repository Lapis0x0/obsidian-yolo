import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ItemView, Menu, TFile, TFolder, WorkspaceLeaf } from 'obsidian'
import type { ViewStateResult } from 'obsidian'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import type {
  ChatProps,
  ChatRef,
  ChatRuntimeSnapshot,
} from './components/chat-view/Chat'
import ChatSidebarTabs from './components/chat-view/ChatSidebarTabs'
import { ConfirmModal } from './components/modals/ConfirmModal'
import { CHAT_VIEW_TYPE } from './constants'
import { AppProvider } from './contexts/app-context'
import { ChatViewProvider } from './contexts/chat-view-context'
import { DarkModeProvider } from './contexts/dark-mode-context'
import { DatabaseProvider } from './contexts/database-context'
import { DialogContainerProvider } from './contexts/dialog-container-context'
import { LanguageProvider } from './contexts/language-context'
import { McpProvider } from './contexts/mcp-context'
import { PluginProvider } from './contexts/plugin-context'
import { SettingsProvider } from './contexts/settings-context'
import type { CliRuntimeScope } from './core/cli-runtime/coordinator'
import type { PendingChatOpenPayload } from './features/chat/chatLeafSessionManager'
import { getConversationDisplayTitle } from './hooks/useChatHistory'
import type YoloPlugin from './main'
import { ConversationOverrideSettings } from './types/conversation-settings.types'
import {
  MentionableBlockData,
  MentionableImage,
  MentionableWebSelection,
} from './types/mentionable'
import { YOLO_ICON_ID } from './yoloIcon'

export class ChatView extends ItemView {
  private displayTitle = 'Yolo chat'
  // Task-1 (issue #567): Obsidian's `leaf.updateHeader()` only refreshes the
  // tab-strip label, never the pane-top `.view-header-title` element — that
  // element only gets its initial text once, at leaf-open time. Runtime
  // instances expose it as an undocumented `titleEl: HTMLElement` property
  // (verified empirically; not part of the public `ItemView`/`View` types),
  // so we read it through a local type narrowing rather than `any`.
  private isEditingTitle = false
  private currentConversationRenamable = false
  private boundTitleEl: HTMLElement | null = null
  private root: Root | null = null
  private initialChatProps?: ChatProps
  private restoredConversationId?: string
  private restoredConversationTitle?: string
  private chatRef: React.RefObject<ChatRef> = React.createRef()
  // host DOM 重建追踪：Windows 上 Obsidian pop-out 会销毁旧 view-content
  // 并新建一个空的，需要检测并把 React tree 迁移到新 host。
  private mountedHost: HTMLElement | null = null
  // ownerDocument at mount time. On macOS, Obsidian pop-out *reparents* the
  // same DOM node to the new window — `mountedHost` reference is unchanged
  // but its `ownerDocument` is now the new window's document. We must rebuild
  // in this case too so Lexical re-binds its `selectionchange` listener.
  private mountedDoc: Document | null = null
  private hostObserver: MutationObserver | null = null
  private windowMigratedDisposer: (() => void) | null = null
  private runtimeSnapshot: ChatRuntimeSnapshot | null = null
  private rebuildScheduled = false
  private rebuildRafId: number | null = null
  private rebuildRafWindow: Window | null = null
  private isClosed = false
  private isApplyingPersistedViewState = false
  private pendingRestoredConversationId?: string
  private restoredConversationLoadPromise: Promise<void> | null = null
  private cliRuntimeScope: CliRuntimeScope | undefined
  private cliRuntimeScopeInitialization: Promise<void> | null = null
  private cliRuntimeScopeDisposal: Promise<void> | null = null
  // See `consumeLastPdfQuoteAnnotationNumber`.
  private lastPdfQuoteAnnotationNumber?: number

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: YoloPlugin,
  ) {
    super(leaf)
  }

  getViewType() {
    return CHAT_VIEW_TYPE
  }

  getIcon() {
    return YOLO_ICON_ID
  }

  getDisplayText() {
    return this.displayTitle
  }

  getState(): Record<string, unknown> {
    const state = { ...super.getState() }
    const summary = this.plugin
      .getChatLeafSessionManager()
      .getLeafSummary(this.leaf)
    const currentConversationId = this.resolvePersistableConversationId(summary)
    const currentConversationTitle =
      summary?.currentConversationTitle ?? this.restoredConversationTitle

    if (currentConversationId) {
      state.currentConversationId = currentConversationId
    } else {
      delete state.currentConversationId
    }

    if (currentConversationId && currentConversationTitle) {
      state.currentConversationTitle = currentConversationTitle
    } else {
      delete state.currentConversationTitle
    }

    return state
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result)

    this.restoredConversationId = this.readStringStateValue(
      state,
      'currentConversationId',
    )
    this.restoredConversationTitle = this.readStringStateValue(
      state,
      'currentConversationTitle',
    )

    if (this.restoredConversationTitle) {
      this.updateDisplayTitle(this.restoredConversationTitle)
    }

    if (!this.isApplyingPersistedViewState && this.restoredConversationId) {
      this.scheduleRestoredConversationLoad()
    }
  }

  async onOpen(): Promise<void> {
    await this.prepareCliRuntimeScopeForOpen()
    this.isClosed = false
    await Promise.all([
      this.plugin.warmupAgentService(),
      this.initializeCliRuntimeScope(),
    ])
    const manager = this.plugin.getChatLeafSessionManager()
    const pendingPayload = manager.consumePendingPayload(this.leaf)
    const placement =
      pendingPayload?.placement ?? manager.getLeafPlacement(this.leaf)
    manager.registerLeaf(this.leaf, placement)
    const leafSummary = manager.getLeafSummary(this.leaf)
    this.currentConversationRenamable = Boolean(
      leafSummary?.currentConversationPersisted,
    )
    this.updateDisplayTitle(leafSummary?.currentConversationTitle)
    this.initialChatProps = this.getInitialChatProps(pendingPayload)

    await this.render()
    await this.applyDeferredPayload(pendingPayload)
    this.scheduleRestoredConversationLoad()

    this.initialChatProps = undefined

    // Host 替换的信号源 1：containerEl.onWindowMigrated（Obsidian 公开 API）
    this.windowMigratedDisposer = this.containerEl.onWindowMigrated(() => {
      this.scheduleRebuildCheck()
    })
    // Host 替换的信号源 2：workspace 事件——窗口开/关、布局变化
    this.registerEvent(
      this.plugin.app.workspace.on('window-open', () => {
        this.scheduleRebuildCheck()
      }),
    )
    this.registerEvent(
      this.plugin.app.workspace.on('window-close', () => {
        this.scheduleRebuildCheck()
      }),
    )
    this.registerEvent(
      this.plugin.app.workspace.on('layout-change', () => {
        this.scheduleRebuildCheck()
      }),
    )
    // Host 替换的信号源 3：直接 MutationObserver 兜底——Windows 上 pop-out
    // 时 view-content 是被原地销毁+新建的，上面两类事件未必能稳定覆盖。
    this.hostObserver = new MutationObserver(() => {
      this.scheduleRebuildCheck()
    })
    this.hostObserver.observe(this.containerEl, { childList: true })

    this.plugin.refreshInstallationIncompleteBanner()
  }

  async onClose(): Promise<void> {
    this.isClosed = true
    this.runtimeSnapshot =
      this.chatRef.current?.getRuntimeSnapshot() ?? this.runtimeSnapshot
    if (this.rebuildRafId !== null) {
      ;(this.rebuildRafWindow ?? this.containerEl.win).cancelAnimationFrame(
        this.rebuildRafId,
      )
      this.rebuildRafId = null
      this.rebuildRafWindow = null
    }
    this.rebuildScheduled = false
    this.plugin.getChatLeafSessionManager().unregisterLeaf(this.leaf)
    this.hostObserver?.disconnect()
    this.hostObserver = null
    this.windowMigratedDisposer?.()
    this.windowMigratedDisposer = null
    this.pendingRestoredConversationId = undefined
    this.restoredConversationLoadPromise = null
    this.root?.unmount()
    this.root = null
    this.mountedHost = null
    this.mountedDoc = null
    this.boundTitleEl = null
    this.isEditingTitle = false
    await this.disposeCliRuntimeScope()
  }

  private async prepareCliRuntimeScopeForOpen(): Promise<void> {
    if (!this.cliRuntimeScopeDisposal) return
    await this.cliRuntimeScopeDisposal
    this.cliRuntimeScopeInitialization = null
    this.cliRuntimeScopeDisposal = null
  }

  private initializeCliRuntimeScope(): Promise<void> {
    this.cliRuntimeScopeInitialization ??= (async () => {
      try {
        const scope = await this.plugin.createCliRuntimeScope()
        if (!scope) return
        if (this.isClosed) {
          await scope.dispose()
          return
        }
        this.cliRuntimeScope = scope
      } catch (error) {
        console.error('[YOLO] Failed to initialize ChatView CLI scope', error)
      }
    })()
    return this.cliRuntimeScopeInitialization
  }

  private disposeCliRuntimeScope(): Promise<void> {
    this.cliRuntimeScopeDisposal ??= (async () => {
      await this.cliRuntimeScopeInitialization
      const scope = this.cliRuntimeScope
      this.cliRuntimeScope = undefined
      await scope?.dispose()
    })().catch((error: unknown) => {
      console.error('[YOLO] Failed to dispose ChatView CLI scope', error)
    })
    return this.cliRuntimeScopeDisposal
  }

  private scheduleRebuildCheck(): void {
    if (this.isClosed) return
    if (this.rebuildScheduled) return
    this.rebuildScheduled = true
    const ownerWindow = this.containerEl.win
    this.rebuildRafWindow = ownerWindow
    this.rebuildRafId = ownerWindow.requestAnimationFrame(() => {
      this.rebuildRafId = null
      this.rebuildRafWindow = null
      this.rebuildScheduled = false
      // Bail out if the view was closed between scheduling and firing.
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
    this.runtimeSnapshot =
      this.chatRef.current?.getRuntimeSnapshot() ?? this.runtimeSnapshot
    this.root?.unmount()
    this.root = createRoot(newHost)
    this.mountedHost = newHost
    this.mountedDoc = newHost.ownerDocument
    await this.render()
    // Defensive: rebuild only replaces view-content (children[1]), so the
    // header/titleEl should survive untouched — but re-sync anyway in case a
    // platform's pop-out path ever recreates the whole leaf DOM including
    // the header (see class-level note on `titleEl`).
    this.syncHeaderTitleElement()
  }

  render(): Promise<void> {
    if (!this.root) {
      const host = this.containerEl.children[1] as HTMLElement
      this.root = createRoot(host)
      this.mountedHost = host
      this.mountedDoc = host.ownerDocument
    }

    // 当 rebuild 把 React tree 移到新 host 时，把当前快照作为初始 props 传入，
    // 让 Chat 内部 useState 用快照值初始化，避免草稿/会话 ID 掉。
    const seededRuntimeSnapshot = this.runtimeSnapshot ?? undefined

    const placement =
      this.plugin.getChatLeafSessionManager().getLeafPlacement(this.leaf) ??
      'sidebar'

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: 0, // Immediately garbage collect queries. It prevents memory leak on ChatView close.
        },
        mutations: {
          gcTime: 0, // Immediately garbage collect mutations. It prevents memory leak on ChatView close.
        },
      },
    })

    this.root.render(
      <ChatViewProvider chatView={this}>
        <PluginProvider plugin={this.plugin}>
          <LanguageProvider>
            <AppProvider app={this.app}>
              <SettingsProvider
                settings={this.plugin.settings}
                setSettings={(newSettings) =>
                  this.plugin.setSettings(newSettings)
                }
                addSettingsChangeListener={(listener) =>
                  this.plugin.addSettingsChangeListener(listener)
                }
              >
                <DarkModeProvider>
                  <DatabaseProvider
                    getDatabaseManager={() => this.plugin.getDbManager()}
                  >
                    <McpProvider
                      getMcpManager={() => this.plugin.getMcpManager()}
                    >
                      <QueryClientProvider client={queryClient}>
                        <React.StrictMode>
                          <DialogContainerProvider
                            container={
                              this.containerEl.children[1] as HTMLElement
                            }
                          >
                            <ChatSidebarTabs
                              chatRef={this.chatRef}
                              placement={placement}
                              initialChatProps={{
                                ...(this.initialChatProps ?? {}),
                                cliRuntimeScope: this.cliRuntimeScope,
                                seededRuntimeSnapshot,
                              }}
                              onConversationContextChange={(context) => {
                                const manager =
                                  this.plugin.getChatLeafSessionManager()
                                manager.updateLeafSummary(this.leaf, context)
                                this.updateRestoredConversationFromContext(
                                  context,
                                )
                                // Only a persisted conversation has a
                                // rename path (ChatRef.renameCurrentConversation
                                // no-ops otherwise) — gate the pane title's
                                // click-to-edit affordance on the same flag.
                                this.currentConversationRenamable = Boolean(
                                  context.currentConversationPersisted,
                                )
                                this.updateDisplayTitle(
                                  context.currentConversationTitle,
                                )
                                this.syncHeaderTitleElement()
                                void this.persistLeafViewState(context)
                              }}
                              onRuntimeSnapshotChange={(snapshot) => {
                                this.runtimeSnapshot = snapshot
                              }}
                            />
                          </DialogContainerProvider>
                        </React.StrictMode>
                      </QueryClientProvider>
                    </McpProvider>
                  </DatabaseProvider>
                </DarkModeProvider>
              </SettingsProvider>
            </AppProvider>
          </LanguageProvider>
        </PluginProvider>
      </ChatViewProvider>,
    )
    return Promise.resolve()
  }

  openNewChat(selectedBlock?: MentionableBlockData) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.openNewChat(selectedBlock)
  }

  /**
   * issue #567 Step 2. Opens the history dropdown — used by the "Open chat
   * history" command (`main.ts`) so it's reachable via the command palette,
   * a bound keyboard shortcut, or Commander. The in-content History button
   * (`ChatHeader`) keeps its own direct click handler; this is a second
   * entry point onto the same `ChatListDropdown` instance.
   */
  openChatHistory(): void {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.openChatHistory()
  }

  /**
   * issue #567 Step 2. Whether the active conversation can currently be
   * exported to the vault — persisted conversation + active runtime
   * supports vault export. Backs the "Export current conversation to vault"
   * command's `checkCallback` gate in `main.ts`. Reads
   * `ChatRef.getCurrentConversationMenuState`, the same live source
   * `onPaneMenu` uses — not a new state source.
   */
  canExportCurrentConversation(): boolean {
    const state = this.chatRef.current?.getCurrentConversationMenuState()
    return Boolean(state?.persisted && state?.canExport)
  }

  /**
   * issue #567 Step 2. Exports the active conversation to the vault. Callers
   * must gate on `canExportCurrentConversation()` first (see the command's
   * `checkCallback`); mirrors the in-content export button's behavior.
   */
  exportCurrentConversation(): void {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.exportCurrentConversation()
  }

  async loadConversation(conversationId: string) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    await this.chatRef.current?.loadConversation(conversationId)
  }

  addSelectionToChat(selectedBlock: MentionableBlockData) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.addSelectionToChat(selectedBlock)
  }

  addSelectionToInput(selectedBlock: MentionableBlockData) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.addSelectionToInput(selectedBlock)
  }

  applySelectionToMainInput(
    selectedBlock: MentionableBlockData,
    text: string,
    options?: {
      submit?: boolean
      assistantId?: string
    },
  ) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.applySelectionToMainInput(
      selectedBlock,
      text,
      options,
    )
  }

  syncSelectionToChat(selectedBlock: MentionableBlockData) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.syncSelectionToChat(selectedBlock)
  }

  syncSelectionToInput(selectedBlock: MentionableBlockData) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.syncSelectionToInput(selectedBlock)
  }

  syncWebSelectionToInput(selection: MentionableWebSelection) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.syncWebSelectionToInput(selection)
  }

  clearSelectionFromChat() {
    this.chatRef.current?.clearSelectionFromChat()
  }

  /**
   * PDF multi-quote annotation (docs/plans/2026-08-16-pdf-annotation-quotes.md).
   * "Existing leaf" path — see `chatViewNavigator.addPdfQuoteToChat`. Returns
   * the annotation number chat assigned so the caller can render it on the
   * PDF-side bubble; `undefined` only if the chat React tree isn't mounted
   * yet (should not happen on this path, since a leaf that resolved as
   * "existing" already has a live ChatRef).
   */
  addPdfQuoteToChat(selectedBlock: MentionableBlockData): number | undefined {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    return this.chatRef.current?.addPdfQuoteToChat(selectedBlock)
  }

  /**
   * The one deps channel the PDF-side bubble editor uses to patch or remove
   * its mentionable's comment (architecture decision B, see `ChatRef.updatePdfQuoteMention`).
   */
  updatePdfQuoteMention(
    highlightId: string,
    patch: { comment: string } | null,
  ): void {
    this.chatRef.current?.updatePdfQuoteMention(highlightId, patch)
  }

  /**
   * "New leaf" path for PDF quote annotation: `onOpen` applies the pending
   * `pdfQuoteBlock` payload (via `applyDeferredPayload`) and stashes the
   * annotation number chat assigned here, since the payload is consumed
   * entirely inside `onOpen` before `chatViewNavigator.addPdfQuoteToChat`
   * gets a chance to read it back. Single-slot: each freshly created leaf
   * only ever applies one pending payload once.
   */
  consumeLastPdfQuoteAnnotationNumber(): number | undefined {
    const value = this.lastPdfQuoteAnnotationNumber
    this.lastPdfQuoteAnnotationNumber = undefined
    return value
  }

  addFileToChat(file: TFile) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.addFileToChat(file)
  }

  addImageToChat(image: MentionableImage) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.addImageToChat(image)
  }

  addFolderToChat(folder: TFolder) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.addFolderToChat(folder)
  }

  insertTextToInput(text: string) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.insertTextToInput(text)
  }

  appendTextToInput(text: string) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.appendTextToInput(text)
  }

  setMainInputText(text: string) {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.setMainInputText(text)
  }

  focusMessage() {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.focusMessage()
  }

  focusMainInput() {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.focusMainInput()
  }

  submitMainInput() {
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(this.leaf)
    this.chatRef.current?.submitMainInput()
  }

  getCurrentConversationOverrides(): ConversationOverrideSettings | undefined {
    return this.chatRef.current?.getCurrentConversationOverrides()
  }

  getCurrentConversationModelId(): string | undefined {
    return this.chatRef.current?.getCurrentConversationModelId()
  }

  private getInitialChatProps(
    payload?: PendingChatOpenPayload,
  ): ChatProps | undefined {
    const initialConversationId =
      payload?.initialConversationId ?? this.restoredConversationId

    if (!payload?.selectedBlock && !initialConversationId) {
      return undefined
    }

    return {
      selectedBlock: payload?.selectedBlock,
      initialConversationId,
    }
  }

  private readStringStateValue(
    state: unknown,
    key: string,
  ): string | undefined {
    if (typeof state !== 'object' || state === null) {
      return undefined
    }

    const value = (state as Record<string, unknown>)[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  private resolvePersistableConversationId(summary?: {
    currentConversationId?: string
    currentConversationPersisted?: boolean
  }): string | undefined {
    if (!summary) {
      return this.restoredConversationId
    }

    if (summary.currentConversationPersisted) {
      return summary.currentConversationId
    }

    if (summary.currentConversationId === this.restoredConversationId) {
      return this.restoredConversationId
    }

    return undefined
  }

  private updateRestoredConversationFromContext(context: {
    currentConversationId?: string
    currentConversationPersisted?: boolean
    currentConversationTitle?: string
  }): void {
    if (context.currentConversationPersisted) {
      this.restoredConversationId = context.currentConversationId
      this.restoredConversationTitle = context.currentConversationTitle
      return
    }

    if (this.pendingRestoredConversationId) {
      return
    }

    if (context.currentConversationId !== this.restoredConversationId) {
      this.restoredConversationId = undefined
      this.restoredConversationTitle = context.currentConversationTitle
    }
  }

  private scheduleRestoredConversationLoad(): void {
    const conversationId = this.restoredConversationId
    if (!conversationId || this.isApplyingPersistedViewState || this.isClosed) {
      return
    }

    if (
      this.pendingRestoredConversationId === conversationId &&
      this.restoredConversationLoadPromise
    ) {
      return
    }

    this.pendingRestoredConversationId = conversationId
    const loadPromise = this.loadRestoredConversation(conversationId).finally(
      () => {
        if (this.pendingRestoredConversationId === conversationId) {
          this.pendingRestoredConversationId = undefined
        }
        if (this.restoredConversationLoadPromise === loadPromise) {
          this.restoredConversationLoadPromise = null
        }
      },
    )
    this.restoredConversationLoadPromise = loadPromise
  }

  private async loadRestoredConversation(
    conversationId: string,
  ): Promise<void> {
    const chatRef = await this.waitForChatRef()
    if (!chatRef || this.isClosed) {
      return
    }

    await chatRef.loadConversation(conversationId)
  }

  private async persistLeafViewState(context: {
    currentConversationId?: string
    currentConversationPersisted?: boolean
    currentConversationTitle?: string
  }): Promise<void> {
    const currentConversationId = this.resolvePersistableConversationId(context)
    const currentViewState = this.leaf.getViewState()
    const currentState = currentViewState.state ?? {}
    const nextState = { ...currentState }

    if (currentConversationId) {
      nextState.currentConversationId = currentConversationId
      if (context.currentConversationTitle) {
        nextState.currentConversationTitle = context.currentConversationTitle
      } else {
        delete nextState.currentConversationTitle
      }
    } else {
      delete nextState.currentConversationId
      delete nextState.currentConversationTitle
    }

    const alreadySynced =
      currentState.currentConversationId === nextState.currentConversationId &&
      currentState.currentConversationTitle ===
        nextState.currentConversationTitle

    if (alreadySynced) {
      this.plugin.app.workspace.requestSaveLayout()
      return
    }

    try {
      this.isApplyingPersistedViewState = true
      await this.leaf.setViewState({
        ...currentViewState,
        type: CHAT_VIEW_TYPE,
        state: nextState,
      })
    } catch (error) {
      console.error('[YOLO] Failed to persist chat view state', error)
    } finally {
      this.isApplyingPersistedViewState = false
    }

    this.plugin.app.workspace.requestSaveLayout()
  }

  private async applyDeferredPayload(
    payload?: PendingChatOpenPayload,
  ): Promise<void> {
    if (!payload) {
      return
    }

    const chatRef = await this.waitForChatRef()
    if (!chatRef) {
      return
    }

    if (payload.fileToAdd) {
      chatRef.addFileToChat(payload.fileToAdd)
    }

    if (payload.folderToAdd) {
      chatRef.addFolderToChat(payload.folderToAdd)
    }

    if (payload.imageToAdd) {
      chatRef.addImageToChat(payload.imageToAdd)
    }

    if (payload.pdfQuoteBlock) {
      // No `focusMessage()`: focus belongs to the PDF-side comment editor that
      // opens right after this — see `chatViewNavigator.addPdfQuoteToChat`.
      this.lastPdfQuoteAnnotationNumber = chatRef.addPdfQuoteToChat(
        payload.pdfQuoteBlock,
      )
      return
    }

    if (payload.prefillText !== undefined && payload.selectedBlock) {
      chatRef.applySelectionToMainInput(
        payload.selectedBlock,
        payload.prefillText,
        {
          submit: payload.autoSend,
          assistantId: payload.assistantId,
        },
      )
      return
    }

    if (payload.prefillText !== undefined) {
      chatRef.setMainInputText(payload.prefillText)
      if (payload.autoSend) {
        chatRef.submitMainInput()
        return
      }

      chatRef.focusMainInput()
      return
    }

    if (payload.fileToAdd || payload.folderToAdd || payload.imageToAdd) {
      chatRef.focusMessage()
    }
  }

  private async waitForChatRef(): Promise<ChatRef | null> {
    for (let index = 0; index < 30; index += 1) {
      if (this.chatRef.current) {
        return this.chatRef.current
      }
      await new Promise((resolve) => window.setTimeout(resolve, 16))
    }

    return null
  }

  private updateDisplayTitle(conversationTitle?: string): void {
    const nextTitle = getConversationDisplayTitle(
      conversationTitle,
      this.plugin.t('chat.untitledConversation', 'New chat'),
    )

    if (this.displayTitle !== nextTitle) {
      this.displayTitle = nextTitle
      ;(
        this.leaf as WorkspaceLeaf & { updateHeader?: () => void }
      ).updateHeader?.()
    }

    // `updateHeader()` above only refreshes the tab label — the pane-top
    // title element needs its text synced separately (see class-level note).
    this.syncHeaderTitleElement()
  }

  private getHeaderTitleEl(): HTMLElement | null {
    return (this as ItemView & { titleEl?: HTMLElement }).titleEl ?? null
  }

  /**
   * Keeps the native `.view-header-title` element's text, editable-affordance
   * class, and click binding in sync with `displayTitle` /
   * `currentConversationRenamable`. Cheap and idempotent — safe to call from
   * every place the underlying element or its bound state might have moved
   * (title change, conversation-context change, rebuild after popout).
   */
  private syncHeaderTitleElement(): void {
    const titleEl = this.getHeaderTitleEl()
    if (!titleEl) return

    if (!this.isEditingTitle && titleEl.textContent !== this.displayTitle) {
      titleEl.textContent = this.displayTitle
    }

    titleEl.toggleClass(
      'yolo-view-header-title-editable',
      this.currentConversationRenamable && !this.isEditingTitle,
    )
    if (this.currentConversationRenamable && !this.isEditingTitle) {
      titleEl.setAttribute(
        'aria-label',
        this.plugin.t(
          'chat.paneTitle.renameAriaLabel',
          'Click to rename conversation',
        ),
      )
    } else if (!this.isEditingTitle) {
      titleEl.removeAttribute('aria-label')
    }

    if (titleEl !== this.boundTitleEl) {
      this.boundTitleEl = titleEl
      this.registerDomEvent(titleEl, 'click', this.handleTitleClick)
    }
  }

  private handleTitleClick = (): void => {
    if (this.isEditingTitle || !this.currentConversationRenamable) return
    this.beginTitleEditing()
  }

  /**
   * Turns the pane title into a plain contenteditable field: select-all on
   * entry, Enter commits (via blur), Esc cancels and restores the previous
   * text, blur commits. An empty/unchanged submission is treated as a
   * cancel. Commit calls through `ChatRef.renameCurrentConversation` so
   * history list, tab label, and CLI session overlays all stay in sync —
   * the same rename path `ChatHeader`'s history dropdown uses.
   */
  private beginTitleEditing(): void {
    const titleEl = this.getHeaderTitleEl()
    if (!titleEl || this.isEditingTitle) return

    this.isEditingTitle = true
    const originalTitle = this.displayTitle

    titleEl.contentEditable = 'true'
    titleEl.spellcheck = false
    titleEl.addClass('yolo-view-header-title-editing')
    titleEl.removeClass('yolo-view-header-title-editable')
    titleEl.setAttribute(
      'aria-label',
      this.plugin.t(
        'chat.paneTitle.editingAriaLabel',
        'Editing conversation title',
      ),
    )

    titleEl.focus()
    const selection = titleEl.ownerDocument.getSelection()
    if (selection) {
      const range = titleEl.ownerDocument.createRange()
      range.selectNodeContents(titleEl)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    let settled = false
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        titleEl.blur()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    }
    const onBlur = () => finish(true)

    const finish = (commit: boolean): void => {
      if (settled) return
      settled = true
      titleEl.removeEventListener('keydown', onKeyDown)
      titleEl.removeEventListener('blur', onBlur)
      titleEl.removeAttribute('contenteditable')
      titleEl.removeClass('yolo-view-header-title-editing')
      this.isEditingTitle = false

      const trimmedTitle = (titleEl.textContent ?? '').trim()
      // Blank or unchanged submissions are treated as a cancel.
      if (!commit || !trimmedTitle || trimmedTitle === originalTitle) {
        this.syncHeaderTitleElement()
        return
      }

      const renamePromise =
        this.chatRef.current?.renameCurrentConversation(trimmedTitle)
      if (!renamePromise) {
        this.syncHeaderTitleElement()
        return
      }

      // Optimistic: reflect the typed title immediately (pane + tab). The
      // async round trip through onConversationContextChange will confirm
      // (no-op) or, on failure below, we revert.
      this.updateDisplayTitle(trimmedTitle)
      renamePromise.catch((error: unknown) => {
        console.error('[YOLO] Failed to rename conversation', error)
        this.updateDisplayTitle(originalTitle)
      })
    }

    titleEl.addEventListener('keydown', onKeyDown)
    titleEl.addEventListener('blur', onBlur)
  }

  /**
   * issue #567 Step 2. Adds a conversation-management group to the pane's
   * native "···" menu: rename / pin-toggle / export / delete. All four act
   * on the active conversation and are disabled when it isn't persisted yet
   * (a brand-new, not-yet-saved chat has nothing to rename/pin/export/
   * delete) — export is omitted entirely when the active runtime doesn't
   * support vault export, matching `ChatHeader`'s conditional rendering.
   */
  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source)

    const state = this.chatRef.current?.getCurrentConversationMenuState()
    const persisted = state?.persisted ?? false

    menu.addSeparator()

    menu.addItem((item) =>
      item
        .setTitle(this.plugin.t('chat.paneMenu.rename', 'Rename'))
        .setIcon('pencil')
        .setDisabled(!persisted)
        .onClick(() => {
          if (!persisted) return
          this.beginTitleEditing()
        }),
    )

    menu.addItem((item) =>
      item
        .setTitle(
          state?.pinned
            ? this.plugin.t('sidebar.chatList.unpinConversation', 'Unpin')
            : this.plugin.t('sidebar.chatList.pinConversation', 'Pin'),
        )
        .setIcon(state?.pinned ? 'star-off' : 'star')
        .setDisabled(!persisted)
        .onClick(() => {
          if (!persisted) return
          void this.chatRef.current?.toggleCurrentConversationPinned()
        }),
    )

    if (state?.canExport) {
      menu.addItem((item) =>
        item
          .setTitle(
            this.plugin.t(
              'sidebar.chatList.exportConversation',
              'Export conversation to vault',
            ),
          )
          .setIcon('download')
          .setDisabled(!persisted)
          .onClick(() => {
            if (!persisted) return
            this.chatRef.current?.exportCurrentConversation()
          }),
      )
    }

    menu.addItem((item) =>
      item
        .setTitle(this.plugin.t('common.delete', 'Delete'))
        .setIcon('trash-2')
        .setDisabled(!persisted)
        .onClick(() => {
          if (!persisted) return
          this.confirmDeleteCurrentConversation()
        }),
    )
  }

  /**
   * Native confirm dialog (shared `ConfirmModal`, see
   * `src/components/modals/ConfirmModal.tsx`) before deleting the active
   * conversation. Delete cleanup + post-delete conversation switching is
   * `ChatRef.deleteCurrentConversation`'s sunk implementation, shared with
   * `ChatHeader`'s history dropdown.
   */
  private confirmDeleteCurrentConversation(): void {
    new ConfirmModal(this.app, {
      title: this.plugin.t(
        'chat.paneMenu.deleteConfirmTitle',
        'Delete conversation?',
      ),
      message: this.plugin
        .t(
          'chat.paneMenu.deleteConfirmMessage',
          'This will permanently delete "{title}". This action cannot be undone.',
        )
        .replace('{title}', this.displayTitle),
      ctaText: this.plugin.t('common.delete', 'Delete'),
      onConfirm: () => {
        void this.chatRef.current?.deleteCurrentConversation()
      },
    }).open()
  }
}
