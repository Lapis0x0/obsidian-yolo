import { Notice, WorkspaceLeaf } from 'obsidian'

import { ChatView } from '../../ChatView'
import { CHAT_VIEW_TYPE } from '../../constants'
import type SmartComposerPlugin from '../../main'

const EMPTY_VIEW_TYPE = 'empty'
const ACTION_MARKER_ATTR = 'data-smtcmp-empty-tab-action'

export class NewTabEmptyStateEnhancer {
  private observer: MutationObserver | null = null

  constructor(private readonly plugin: SmartComposerPlugin) {}

  enable(): void {
    this.plugin.app.workspace.onLayoutReady(() => {
      this.refresh()
      this.startObserver()
    })

    this.plugin.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', () => {
        this.refresh()
      }),
    )

    this.plugin.register(() => {
      this.observer?.disconnect()
      this.observer = null
    })
  }

  private startObserver(): void {
    if (this.observer) {
      return
    }

    this.observer = new MutationObserver(() => {
      this.refresh()
    })

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    })
  }

  private refresh(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(
      EMPTY_VIEW_TYPE,
    )) {
      const actionList = leaf.view.containerEl.querySelector(
        '.empty-state-action-list',
      )
      if (!(actionList instanceof HTMLElement)) {
        continue
      }

      if (actionList.querySelector(`[${ACTION_MARKER_ATTR}]`)) {
        continue
      }

      const action = this.createActionElement(actionList, leaf)
      actionList.appendChild(action)
    }
  }

  private createActionElement(
    actionList: HTMLElement,
    leaf: WorkspaceLeaf,
  ): HTMLElement {
    const template = actionList.querySelector('.empty-state-action')
    const action =
      template instanceof HTMLElement
        ? (template.cloneNode(false) as HTMLElement)
        : document.createElement('div')

    action.className =
      template instanceof HTMLElement
        ? template.className
        : 'empty-state-action'
    action.removeAttribute('href')
    action.removeAttribute('target')
    action.removeAttribute('rel')
    action.setAttribute(ACTION_MARKER_ATTR, 'true')
    action.textContent = this.plugin.t('commands.openYoloNewChat')

    this.plugin.registerDomEvent(action, 'click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void this.openChatInLeaf(leaf)
    })

    return action
  }

  private async openChatInLeaf(leaf: WorkspaceLeaf): Promise<void> {
    try {
      const placement = this.plugin
        .getChatLeafSessionManager()
        .inferLeafPlacement(leaf)

      this.plugin.getChatLeafSessionManager().setPendingPayload(leaf, {
        placement,
      })

      await leaf.setViewState({
        type: CHAT_VIEW_TYPE,
        active: true,
      })

      if (!(leaf.view instanceof ChatView)) {
        throw new Error('Chat view did not open in empty tab leaf.')
      }

      this.plugin.getChatLeafSessionManager().registerLeaf(leaf, placement)
      await this.plugin.app.workspace.revealLeaf(leaf)
      leaf.view.openNewChat()
      leaf.view.focusMessage()
    } catch (error) {
      console.error('Failed to open YOLO chat from empty tab:', error)
      new Notice(this.plugin.t('notices.openYoloNewChatFailed'))
    }
  }
}
