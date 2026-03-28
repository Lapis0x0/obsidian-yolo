import {
  Editor,
  MarkdownView,
  Platform,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from 'obsidian'

import { ChatView } from '../../ChatView'
import { CHAT_VIEW_TYPE } from '../../constants'
import type SmartComposerPlugin from '../../main'
import type { MentionableBlockData } from '../../types/mentionable'
import { getMentionableBlockData } from '../../utils/obsidian'

import {
  ChatLeafPlacement,
  PendingChatOpenPayload,
} from './chatLeafSessionManager'

type ChatViewNavigatorDeps = {
  plugin: SmartComposerPlugin
}

type OpenChatViewOptions = {
  placement?: ChatLeafPlacement
  openNewChat?: boolean
  selectedBlock?: MentionableBlockData
  initialConversationId?: string
  prefillText?: string
  forceNewLeaf?: boolean
}

type ResolveTargetChatLeafOptions = {
  placement?: ChatLeafPlacement
  allowCreate?: boolean
  forceNewLeaf?: boolean
}

export class ChatViewNavigator {
  private readonly plugin: SmartComposerPlugin

  constructor(deps: ChatViewNavigatorDeps) {
    this.plugin = deps.plugin
  }

  async openChatView(options: OpenChatViewOptions = {}) {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor
    const selectedBlock =
      options.selectedBlock ??
      (view && editor
        ? (getMentionableBlockData(editor, view) ?? undefined)
        : undefined)

    const existingLeaf = this.resolveTargetChatLeaf({
      placement: options.placement,
      forceNewLeaf: options.forceNewLeaf,
    })
    const targetLeaf =
      existingLeaf ??
      (await this.createChatLeaf(options.placement ?? 'sidebar', {
        selectedBlock,
        initialConversationId: options.initialConversationId,
        prefillText: options.prefillText,
      }))

    if (!targetLeaf || !(targetLeaf.view instanceof ChatView)) {
      return
    }

    if (!existingLeaf) {
      await this.activateChatLeaf(targetLeaf)
      return
    }

    if (options.initialConversationId) {
      await this.activateChatLeaf(targetLeaf)
      await targetLeaf.view.loadConversation(options.initialConversationId)
      if (options.prefillText) {
        targetLeaf.view.insertTextToInput(options.prefillText)
        targetLeaf.view.focusMessage()
      }
      return
    }

    if (options.openNewChat) {
      await this.activateChatLeaf(targetLeaf)
      targetLeaf.view.openNewChat(selectedBlock)
      if (options.prefillText) {
        targetLeaf.view.insertTextToInput(options.prefillText)
      }
      targetLeaf.view.focusMessage()
      return
    }

    await this.activateChatLeaf(targetLeaf)
  }

  async openChatInSidebar(openNewChat = false) {
    await this.openChatView({
      placement: 'sidebar',
      openNewChat,
    })
  }

  async openChatInSplit(openNewChat = false) {
    await this.openChatView({
      placement: 'split',
      openNewChat,
      forceNewLeaf: openNewChat,
    })
  }

  async openChatInTab(openNewChat = false) {
    await this.openChatView({
      placement: 'tab',
      openNewChat,
      forceNewLeaf: openNewChat,
    })
  }

  async openChatInWindow(openNewChat = false) {
    await this.openChatView({
      placement: 'window',
      openNewChat,
      forceNewLeaf: openNewChat,
    })
  }

  async openCurrentOrSidebarNewChat() {
    const activeLeaf =
      this.plugin.app.workspace.getActiveViewOfType(ChatView)?.leaf ?? null
    if (activeLeaf?.view instanceof ChatView) {
      await this.activateChatLeaf(activeLeaf)
      activeLeaf.view.openNewChat()
      activeLeaf.view.focusMessage()
      return
    }

    await this.openChatView({
      placement: 'sidebar',
      openNewChat: true,
    })
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    const data = getMentionableBlockData(editor, view)
    if (!data) return

    await this.addSelectionBlockToChat(data)
  }

  async addSelectionBlockToChat(selectedBlock: MentionableBlockData) {
    const data: MentionableBlockData = {
      ...selectedBlock,
      source: 'selection-pinned',
    }

    const existingLeaf = this.resolveTargetChatLeaf()
    const targetLeaf =
      existingLeaf ??
      (await this.createChatLeaf('sidebar', {
        selectedBlock: data,
      }))
    if (!targetLeaf || !(targetLeaf.view instanceof ChatView)) {
      return
    }

    await this.activateChatLeaf(targetLeaf)
    if (!existingLeaf) {
      return
    }
    targetLeaf.view.addSelectionToChat(data)
    targetLeaf.view.focusMessage()
  }

  async openChatWithSelectionAndPrefill(
    selectedBlock: MentionableBlockData,
    text: string,
  ) {
    const existingLeaf = this.resolveTargetChatLeaf()
    const targetLeaf =
      existingLeaf ??
      (await this.createChatLeaf('sidebar', {
        selectedBlock,
        prefillText: text,
      }))
    if (!targetLeaf || !(targetLeaf.view instanceof ChatView)) {
      return
    }

    await this.activateChatLeaf(targetLeaf)
    if (!existingLeaf) {
      return
    }
    targetLeaf.view.syncSelectionToChat(selectedBlock)
    if (text) {
      targetLeaf.view.insertTextToInput(text)
    }
    targetLeaf.view.focusMessage()
  }

  async addFileToChat(file: TFile) {
    const existingLeaf = this.resolveTargetChatLeaf()
    const targetLeaf =
      existingLeaf ??
      (await this.createChatLeaf('sidebar', {
        fileToAdd: file,
      }))
    if (!targetLeaf || !(targetLeaf.view instanceof ChatView)) {
      return
    }

    await this.activateChatLeaf(targetLeaf)
    if (!existingLeaf) {
      return
    }
    targetLeaf.view.addFileToChat(file)
    targetLeaf.view.focusMessage()
  }

  async addFolderToChat(folder: TFolder) {
    const existingLeaf = this.resolveTargetChatLeaf()
    const targetLeaf =
      existingLeaf ??
      (await this.createChatLeaf('sidebar', {
        folderToAdd: folder,
      }))
    if (!targetLeaf || !(targetLeaf.view instanceof ChatView)) {
      return
    }

    await this.activateChatLeaf(targetLeaf)
    if (!existingLeaf) {
      return
    }
    targetLeaf.view.addFolderToChat(folder)
    targetLeaf.view.focusMessage()
  }

  resolveTargetChatLeaf(
    options: ResolveTargetChatLeafOptions = {},
  ): WorkspaceLeaf | null {
    if (options.forceNewLeaf) {
      return null
    }

    return this.plugin
      .getChatLeafSessionManager()
      .resolveTargetLeaf({ placement: options.placement })
  }

  async ensureChatLeaf(
    options: ResolveTargetChatLeafOptions = {},
  ): Promise<WorkspaceLeaf | null> {
    const existingLeaf = this.resolveTargetChatLeaf(options)
    if (existingLeaf) {
      return existingLeaf
    }

    if (options.allowCreate === false) {
      return null
    }

    return await this.createChatLeaf(options.placement ?? 'sidebar')
  }

  private async activateChatLeaf(leaf: WorkspaceLeaf): Promise<void> {
    await this.plugin.app.workspace.revealLeaf(leaf)
    this.plugin.getChatLeafSessionManager().touchLeafInteracted(leaf)
  }

  private async createChatLeaf(
    placement: ChatLeafPlacement,
    payload?: PendingChatOpenPayload,
  ): Promise<WorkspaceLeaf | null> {
    const leaf = this.createLeafForPlacement(placement)
    if (!leaf) {
      return null
    }

    this.plugin.getChatLeafSessionManager().setPendingPayload(leaf, {
      ...payload,
      placement,
    })

    await leaf.setViewState({
      type: CHAT_VIEW_TYPE,
      active: true,
    })

    if (!(leaf.view instanceof ChatView)) {
      return null
    }

    this.plugin.getChatLeafSessionManager().registerLeaf(leaf, placement)
    return leaf
  }

  private createLeafForPlacement(
    placement: ChatLeafPlacement,
  ): WorkspaceLeaf | null {
    switch (placement) {
      case 'sidebar':
        return this.plugin.app.workspace.getRightLeaf(false)
      case 'split': {
        const workspace = this.plugin.app.workspace
        const baseLeaf =
          workspace.getMostRecentLeaf(workspace.rootSplit) ??
          workspace.getActiveViewOfType(MarkdownView)?.leaf ??
          workspace.getLeaf(false)

        return workspace.createLeafBySplit(baseLeaf, 'vertical')
      }
      case 'tab':
        return this.plugin.app.workspace.getLeaf('tab')
      case 'window':
        if (!Platform.isDesktop) {
          return this.plugin.app.workspace.getLeaf('tab')
        }
        return this.plugin.app.workspace.getLeaf('window')
      default:
        return this.plugin.app.workspace.getRightLeaf(false)
    }
  }
}
