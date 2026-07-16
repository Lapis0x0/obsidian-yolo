import { Notice, WorkspaceLeaf, setIcon } from 'obsidian'

import { ChatView } from '../../ChatView'
import { CHAT_VIEW_TYPE } from '../../constants'
import type YoloPlugin from '../../main'
import { YOLO_ICON_ID } from '../../yoloIcon'

const EMPTY_VIEW_TYPE = 'empty'
const ACTION_MARKER_ATTR = 'data-yolo-empty-tab-action'
const ICON_ONLY_CLASS = 'yolo-new-tab-action--icon-only'

export class NewTabEmptyStateEnhancer {
  private observer: MutationObserver | null = null

  constructor(private readonly plugin: YoloPlugin) {}

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
      // Hot-reload / disable: remove all inserted action elements. Their
      // click listeners are auto-removed by `plugin.registerDomEvent`, so the
      // DOM nodes would otherwise survive as dead "buttons" — and the marker
      // check in `refresh()` would prevent the next enable() from rebinding.
      document
        .querySelectorAll(`[${ACTION_MARKER_ATTR}]`)
        .forEach((el) => el.remove())
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

      const existingAction = actionList.querySelector(`[${ACTION_MARKER_ATTR}]`)
      if (existingAction instanceof HTMLElement) {
        this.updateActionPresentation(existingAction)
        continue
      }

      const action = this.createActionElement(actionList, leaf)
      actionList.appendChild(action)
      this.updateActionPresentation(action)
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
    // Obsidian 在捕获阶段拦截 .tappable 事件做 action 派发，会让我们自己的
    // click 监听完全收不到事件。这里去掉 tappable，仅保留视觉 class。
    action.classList.remove('tappable')
    action.removeAttribute('href')
    action.removeAttribute('target')
    action.removeAttribute('rel')
    action.setAttribute(ACTION_MARKER_ATTR, 'true')
    action.classList.add('yolo-new-tab-action')

    const label = this.plugin.t('commands.openYoloNewChat')
    const icon = document.createElement('span')
    icon.className = 'yolo-new-tab-action-icon'
    icon.setAttribute('aria-hidden', 'true')
    setIcon(icon, YOLO_ICON_ID)

    const labelElement = document.createElement('span')
    labelElement.className = 'yolo-new-tab-action-label'
    labelElement.textContent = label

    action.replaceChildren(icon, labelElement)
    action.setAttribute('aria-label', label)
    action.setAttribute('title', label)

    this.plugin.registerDomEvent(action, 'click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void this.openChatInLeaf(leaf)
    })

    return action
  }

  private updateActionPresentation(action: HTMLElement): void {
    const fontSize = Number.parseFloat(getComputedStyle(action).fontSize)
    action.classList.toggle(
      ICON_ONLY_CLASS,
      Number.isFinite(fontSize) && fontSize === 0,
    )
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
