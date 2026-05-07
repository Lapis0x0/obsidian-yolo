import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ItemView, TFile, TFolder, WorkspaceLeaf } from './runtime/react-compat'
import React from 'react'
import { Root, createRoot } from 'react-dom/client'

import type { ChatProps, ChatRef } from './components/chat-view/Chat'
import ChatSidebarTabs from './components/chat-view/ChatSidebarTabs'
import {
  CHAT_VIEW_TYPE,
  DEFAULT_UNTITLED_CONVERSATION_TITLE,
} from './constants'
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
import SmartComposerPlugin from './main'
import {
  createObsidianYoloRuntime,
  YoloRuntimeProvider,
} from './runtime'
import type { YoloRuntime } from './runtime'
import { ConversationOverrideSettings } from './types/conversation-settings.types'
import { MentionableBlockData, MentionableImage } from './types/mentionable'

export class ChatView extends ItemView {
  private displayTitle = 'Yolo chat'
  private root: Root | null = null
  private initialChatProps?: ChatProps
  private chatRef: React.RefObject<ChatRef> = React.createRef()
  private removeSettingsChangeListener?: () => void
  private readonly runtime: YoloRuntime

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: SmartComposerPlugin,
  ) {
    super(leaf)
    this.runtime = createObsidianYoloRuntime(plugin)
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
    const manager = this.plugin.getChatLeafSessionManager()
    const pendingPayload = manager.consumePendingPayload(this.leaf)
    const placement =
      pendingPayload?.placement ?? manager.getLeafPlacement(this.leaf)
    manager.registerLeaf(this.leaf, placement)
    this.updateDisplayTitle(
      manager.getLeafSummary(this.leaf)?.currentConversationTitle,
    )
    this.removeSettingsChangeListener = this.plugin.addSettingsChangeListener(
      () => {
        this.updateDisplayTitle(
          this.plugin.getChatLeafSessionManager().getLeafSummary(this.leaf)
            ?.currentConversationTitle,
        )
      },
    )
    this.initialChatProps = this.getInitialChatProps(pendingPayload)

    await this.render()
    await this.applyDeferredPayload(pendingPayload)

    this.initialChatProps = undefined

    void this.plugin.checkForUpdateOnce()
    this.plugin.refreshInstallationIncompleteBanner()
  }

  onClose(): Promise<void> {
    this.removeSettingsChangeListener?.()
    this.removeSettingsChangeListener = undefined
    this.plugin.getChatLeafSessionManager().unregisterLeaf(this.leaf)
    this.root?.unmount()
    return Promise.resolve()
  }

  render(): Promise<void> {
    if (!this.root) {
      this.root = createRoot(this.containerEl.children[1])
    }

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
      <YoloRuntimeProvider runtime={this.runtime}>
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
                                  initialChatProps={this.initialChatProps}
                                  onConversationContextChange={(context) => {
                                    const manager =
                                      this.plugin.getChatLeafSessionManager()
                                    manager.updateLeafSummary(this.leaf, context)
                                    this.updateDisplayTitle(
                                      context.currentConversationTitle,
                                    )
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
        </ChatViewProvider>
      </YoloRuntimeProvider>,
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
    const nextTitle = this.plugin.settings.chatOptions
      .tabTitleFollowsConversation
      ? conversationTitle?.trim() || DEFAULT_UNTITLED_CONVERSATION_TITLE
      : 'Yolo chat'

    if (this.displayTitle === nextTitle) {
      return
    }

    this.displayTitle = nextTitle
    ;(
      this.leaf as WorkspaceLeaf & { updateHeader?: () => void }
    ).updateHeader?.()
  }
}
