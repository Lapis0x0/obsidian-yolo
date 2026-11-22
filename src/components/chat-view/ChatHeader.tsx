import { Download, PanelLeft, Plus } from 'lucide-react'
import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from 'react'
import { useEffect, useRef } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { ChatMode } from '../../core/agent/chat-mode'
import { isModuleChatMode } from '../../core/agent/chat-mode'
import {
  type ChatRuntimeId,
  type CliRuntimeId,
  type CliRuntimeScope,
  RUNTIME_CAPABILITIES,
  isCliRuntime,
} from '../../core/cli-runtime'
import type { MentionableBlockData } from '../../types/mentionable'

import { AssistantSelector } from './AssistantSelector'
import { HermesProfileSelector } from './HermesProfileSelector'
import { RuntimeSelector } from './RuntimeSelector'
import ViewToggle from './ViewToggle'

const WORKSPACE_WIDE_HEADER_MIN_WIDTH = 1200

export type ChatHeaderProps = {
  isSidebarPlacement: boolean
  activeRuntimeId: ChatRuntimeId
  handleRuntimeChange: (runtimeId: ChatRuntimeId) => void
  lastCliRuntimeIdRef: MutableRefObject<CliRuntimeId>
  cliRuntimeAvailable: boolean
  cliRuntimeScope: CliRuntimeScope | undefined
  /** Gates the assistant selector — hidden while a module chat mode is active. */
  chatMode: ChatMode

  // workspace-wide header 测量：containerRef 由 Chat.tsx 持有（同一节点也
  // 服务于其他用途），这里只读取 .current 做宽度测量；isWorkspaceWideHeader
  // 的状态同样归属 Chat.tsx（containerClassName/containerStyle 也要用），
  // 经 setter 直传的方式在此组件内更新。
  containerRef: RefObject<HTMLDivElement | null>
  isWorkspaceWideHeader: boolean
  setIsWorkspaceWideHeader: Dispatch<SetStateAction<boolean>>
  setWorkspaceWideHeaderHeight: Dispatch<SetStateAction<number>>

  conversationAssistantId: string
  handleConversationAssistantSelect: (assistantId: string) => void
  /** `undefined` means the default Hermes profile. Ignored by non-Hermes runtimes. */
  hermesProfileId: string | undefined
  handleHermesProfileSelect: (profileId: string | undefined) => void
  handleNewChat: (selectedBlock?: MentionableBlockData) => void
  handleExportChatToVault: (conversationId: string) => void
  currentConversationId: string
  /**
   * 侧边栏处于抽屉形态时，头部最左侧给一个开抽屉的按钮；常驻列和窄轨各自
   * 带展开 / 收起按钮，不需要它。
   */
  onOpenSidebar?: () => void
}

export function ChatHeader({
  isSidebarPlacement,
  activeRuntimeId,
  handleRuntimeChange,
  lastCliRuntimeIdRef,
  cliRuntimeAvailable,
  cliRuntimeScope,
  chatMode,
  containerRef,
  isWorkspaceWideHeader,
  setIsWorkspaceWideHeader,
  setWorkspaceWideHeaderHeight,
  conversationAssistantId,
  handleConversationAssistantSelect,
  hermesProfileId,
  handleHermesProfileSelect,
  handleNewChat,
  handleExportChatToVault,
  currentConversationId,
  onOpenSidebar,
}: ChatHeaderProps) {
  const { t } = useLanguage()
  const headerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (isSidebarPlacement) {
      setIsWorkspaceWideHeader(false)
      return
    }

    const element = containerRef.current
    if (!element) return

    const updateIsWideHeader = (width: number) => {
      setIsWorkspaceWideHeader(width >= WORKSPACE_WIDE_HEADER_MIN_WIDTH)
    }

    updateIsWideHeader(element.getBoundingClientRect().width)

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      updateIsWideHeader(entry.contentRect.width)
    })

    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [isSidebarPlacement])

  useEffect(() => {
    if (isSidebarPlacement || !isWorkspaceWideHeader) {
      setWorkspaceWideHeaderHeight(0)
      return
    }

    const element = headerRef.current
    if (!element) return

    const updateHeaderHeight = (height: number) => {
      setWorkspaceWideHeaderHeight(Math.ceil(height))
    }

    updateHeaderHeight(element.getBoundingClientRect().height)

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      updateHeaderHeight(entry.contentRect.height)
    })

    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [isSidebarPlacement, isWorkspaceWideHeader])

  return (
    <div
      ref={headerRef}
      className={`yolo-chat-header${
        isSidebarPlacement ? '' : ' yolo-chat-header--workspace'
      }`}
    >
      <div className="yolo-chat-header-left">
        {onOpenSidebar ? (
          <button
            type="button"
            className="clickable-icon"
            aria-label={t('sidebar.chatSidebar.open', 'Open sidebar')}
            onClick={onOpenSidebar}
          >
            <PanelLeft size={18} />
          </button>
        ) : null}
        <ViewToggle
          activeChatSurface={activeRuntimeId === 'yolo' ? 'chat' : 'cli'}
          onChangeChatSurface={(surface) => {
            handleRuntimeChange(
              surface === 'chat' ? 'yolo' : lastCliRuntimeIdRef.current,
            )
          }}
          showCliMode={cliRuntimeAvailable && cliRuntimeScope !== undefined}
        />
        {isCliRuntime(activeRuntimeId) ? (
          <RuntimeSelector
            currentRuntimeId={activeRuntimeId}
            onRuntimeChange={handleRuntimeChange}
          />
        ) : null}
      </div>
      <div className="yolo-chat-header-right">
        {RUNTIME_CAPABILITIES[activeRuntimeId].hasAssistants &&
        !isModuleChatMode(chatMode) ? (
          <AssistantSelector
            currentAssistantId={conversationAssistantId}
            triggerClassName={
              !isSidebarPlacement && isWorkspaceWideHeader
                ? 'yolo-assistant-selector-button--workspace-floating'
                : undefined
            }
            contentClassName={
              !isSidebarPlacement && isWorkspaceWideHeader
                ? 'yolo-assistant-selector-content--workspace-floating'
                : undefined
            }
            onAssistantChange={(assistant) => {
              handleConversationAssistantSelect(assistant.id)
            }}
          />
        ) : null}
        {activeRuntimeId === 'hermes' &&
        !isModuleChatMode(chatMode) &&
        cliRuntimeScope ? (
          <HermesProfileSelector
            cliRuntimeScope={cliRuntimeScope}
            currentProfileId={hermesProfileId}
            onProfileChange={handleHermesProfileSelect}
          />
        ) : null}
        <div className="yolo-chat-header-buttons">
          <button
            type="button"
            onClick={() => handleNewChat()}
            className="clickable-icon"
            aria-label={t('chat.newChat', 'New chat')}
          >
            <Plus size={18} />
          </button>
          {RUNTIME_CAPABILITIES[activeRuntimeId].supportsVaultExport ? (
            <button
              type="button"
              onClick={() => handleExportChatToVault(currentConversationId)}
              className="clickable-icon"
              aria-label={t(
                'sidebar.chatList.exportConversation',
                'Export conversation to vault',
              )}
            >
              <Download size={18} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
