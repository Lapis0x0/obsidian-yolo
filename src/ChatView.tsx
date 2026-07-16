import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ItemView, TFile, TFolder, WorkspaceLeaf } from 'obsidian'
import type { ViewStateResult } from 'obsidian'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import type {
  ChatProps,
  ChatRef,
  ChatRuntimeSnapshot,
} from './components/chat-view/Chat'
import ChatSidebarTabs from './components/chat-view/ChatSidebarTabs'
import { CHAT_VIEW_TYPE } from './constants'
import { AppProvider } from './contexts/app-context'
import { ChatViewProvider } from './contexts/chat-view-context'
import { DarkModeProvider } from './contexts/dark-mode-context'
import { DatabaseProvider } from './contexts/database-context'
import { DialogContainerProvider } from './contexts/dialog-container-context'
import { LanguageProvider } from './contexts/language-context'
import { McpProvider } from './contexts/mcp-context'
import { PluginProvider } from './contexts/plugin-context'
import { RAGProvider } from './contexts/rag-context'
import { SettingsProvider } from './contexts/settings-context'
import type { PendingChatOpenPayload } from './features/chat/chatLeafSessionManager'
import { getConversationDisplayTitle } from './hooks/useChatHistory'
import YoloPlugin from './main'
import { ConversationOverrideSettings } from './types/conversation-settings.types'
import {
  MentionableBlockData,
  MentionableImage,
  MentionableWebSelection,
} from './types/mentionable'
import { YOLO_ICON_ID } from './yoloIcon'

export class ChatView extends ItemView {
  private displayTitle = 'Yolo chat'
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
  private isClosed = false
  private isApplyingPersistedViewState = false
  private pendingRestoredConversationId?: string
  private restoredConversationLoadPromise: Promise<void> | null = null

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
    this.isClosed = false
    await this.plugin.warmupAgentService()
    const manager = this.plugin.getChatLeafSessionManager()
    const pendingPayload = manager.consumePendingPayload(this.leaf)
    const placement =
      pendingPayload?.placement ?? manager.getLeafPlacement(this.leaf)
    manager.registerLeaf(this.leaf, placement)
    this.updateDisplayTitle(
      manager.getLeafSummary(this.leaf)?.currentConversationTitle,
    )
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

  onClose(): Promise<void> {
    this.isClosed = true
    this.runtimeSnapshot =
      this.chatRef.current?.getRuntimeSnapshot() ?? this.runtimeSnapshot
    if (this.rebuildRafId !== null) {
      window.cancelAnimationFrame(this.rebuildRafId)
      this.rebuildRafId = null
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
    return Promise.resolve()
  }

  private scheduleRebuildCheck(): void {
    if (this.isClosed) return
    if (this.rebuildScheduled) return
    this.rebuildScheduled = true
    this.rebuildRafId = window.requestAnimationFrame(() => {
      this.rebuildRafId = null
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
                    <RAGProvider
                      getRAGEngine={() => this.plugin.getRAGEngine()}
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
                                  seededRuntimeSnapshot,
                                }}
                                onConversationContextChange={(context) => {
                                  const manager =
                                    this.plugin.getChatLeafSessionManager()
                                  manager.updateLeafSummary(this.leaf, context)
                                  this.updateRestoredConversationFromContext(
                                    context,
                                  )
                                  this.updateDisplayTitle(
                                    context.currentConversationTitle,
                                  )
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
                    </RAGProvider>
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

    if (this.displayTitle === nextTitle) {
      return
    }

    this.displayTitle = nextTitle
    ;(
      this.leaf as WorkspaceLeaf & { updateHeader?: () => void }
    ).updateHeader?.()
  }
}
