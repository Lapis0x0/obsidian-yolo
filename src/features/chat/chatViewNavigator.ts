import { Editor, MarkdownView, TFile, TFolder } from 'obsidian'

import { ChatView } from '../../ChatView'
import { ChatProps } from '../../components/chat-view/Chat'
import { CHAT_VIEW_TYPE } from '../../constants'
import type SmartComposerPlugin from '../../main'
import { getMentionableBlockData } from '../../utils/obsidian'

type ChatViewNavigatorDeps = {
  plugin: SmartComposerPlugin
}

export class ChatViewNavigator {
  private readonly plugin: SmartComposerPlugin

  constructor(deps: ChatViewNavigatorDeps) {
    this.plugin = deps.plugin
  }

  async openChatView(openNewChat = false) {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)
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
    this.plugin.initialChatProps = chatProps

    const leaf = this.plugin.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]
    if (leaf && leaf.view instanceof ChatView) {
      leaf.view.setInitialChatProps(chatProps)
    }

    await (leaf ?? this.plugin.app.workspace.getRightLeaf(false))?.setViewState(
      {
        type: CHAT_VIEW_TYPE,
        active: true,
      },
    )

    if (openNewChat && leaf && leaf.view instanceof ChatView) {
      leaf.view.openNewChat(chatProps?.selectedBlock)
    }

    const leafToReveal =
      leaf ?? this.plugin.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]
    if (leafToReveal) {
      await this.plugin.app.workspace.revealLeaf(leafToReveal)
    }
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    const data = getMentionableBlockData(editor, view)
    if (!data) return

    const leaves = this.plugin.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({
        selectedBlock: data,
      })
      return
    }

    // bring leaf to foreground (uncollapse sidebar if it's collapsed)
    await this.plugin.app.workspace.revealLeaf(leaves[0])

    const chatView = leaves[0].view
    chatView.addSelectionToChat(data)
    chatView.focusMessage()
  }

  async addFileToChat(file: TFile) {
    const leaves = this.plugin.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView()
      // Get the newly created chat view
      const newLeaves =
        this.plugin.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
      if (newLeaves.length > 0 && newLeaves[0].view instanceof ChatView) {
        const chatView = newLeaves[0].view
        chatView.addFileToChat(file)
        chatView.focusMessage()
      }
      return
    }

    // bring leaf to foreground (uncollapse sidebar if it's collapsed)
    await this.plugin.app.workspace.revealLeaf(leaves[0])

    const chatView = leaves[0].view
    chatView.addFileToChat(file)
    chatView.focusMessage()
  }

  async addFolderToChat(folder: TFolder) {
    const leaves = this.plugin.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView()
      // Get the newly created chat view
      const newLeaves =
        this.plugin.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
      if (newLeaves.length > 0 && newLeaves[0].view instanceof ChatView) {
        const chatView = newLeaves[0].view
        chatView.addFolderToChat(folder)
        chatView.focusMessage()
      }
      return
    }

    // bring leaf to foreground (uncollapse sidebar if it's collapsed)
    await this.plugin.app.workspace.revealLeaf(leaves[0])

    const chatView = leaves[0].view
    chatView.addFolderToChat(folder)
    chatView.focusMessage()
  }
}
