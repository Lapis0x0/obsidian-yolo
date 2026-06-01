import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ItemView, TFile, TFolder, WorkspaceLeaf } from 'obsidian'
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
import { MentionableBlockData, MentionableImage } from './types/mentionable'

export class ChatView extends ItemView {
  private displayTitle = 'Yolo chat'
  private root: Root | null = null
  private initialChatProps?: ChatProps
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
    return 'wand-sparkles'
  }

  getDisplayText() {
    return this.displayTitle
  }

  async onOpen(): Promise<void> {
    this.isClosed = false
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
                                  this.updateDisplayTitle(
                                    context.currentConversationTitle,
                                  )
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
    if (!payload) {
      return undefined
    }

    if (!payload.selectedBlock && !payload.initialConversationId) {
      return undefined
    }

    return {
      selectedBlock: payload.selectedBlock,
      initialConversationId: payload.initialConversationId,
    }
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
