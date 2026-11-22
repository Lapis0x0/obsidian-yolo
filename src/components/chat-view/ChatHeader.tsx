import { ChevronDown, Download, PanelLeft, Plus } from 'lucide-react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  type ChatRuntimeId,
  type CliRuntimeScope,
  RUNTIME_CAPABILITIES,
} from '../../core/cli-runtime'
import type { MentionableBlockData } from '../../types/mentionable'

import { AgentPicker, useAgentDisplay } from './agent-picker/AgentPicker'
import type { AgentRef } from './agent-picker/agentRef'

const WORKSPACE_WIDE_HEADER_MIN_WIDTH = 1200

export type ChatHeaderProps = {
  isSidebarPlacement: boolean
  activeRuntimeId: ChatRuntimeId
  /** 当前对话正在和谁对话 */
  currentAgent: AgentRef
  /** 在头部换 Agent：切换当前对话的 Agent，不开新对话 */
  onSwitchAgent: (ref: AgentRef) => void
  /** CLI 运行时可用时才传，选择器据此列出 CLI Agent */
  cliRuntimeScope: CliRuntimeScope | undefined

  // workspace-wide header 测量：containerRef 由 Chat.tsx 持有（同一节点也
  // 服务于其他用途），这里只读取 .current 做宽度测量；isWorkspaceWideHeader
  // 的状态同样归属 Chat.tsx（containerClassName/containerStyle 也要用），
  // 经 setter 直传的方式在此组件内更新。
  containerRef: RefObject<HTMLDivElement | null>
  isWorkspaceWideHeader: boolean
  setIsWorkspaceWideHeader: Dispatch<SetStateAction<boolean>>
  setWorkspaceWideHeaderHeight: Dispatch<SetStateAction<number>>

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
  currentAgent,
  onSwitchAgent,
  cliRuntimeScope,
  containerRef,
  isWorkspaceWideHeader,
  setIsWorkspaceWideHeader,
  setWorkspaceWideHeaderHeight,
  handleNewChat,
  handleExportChatToVault,
  currentConversationId,
  onOpenSidebar,
}: ChatHeaderProps) {
  const { t } = useLanguage()
  const headerRef = useRef<HTMLDivElement | null>(null)
  const agentDisplay = useAgentDisplay(currentAgent, cliRuntimeScope)

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
        <AgentPicker
          current={currentAgent}
          onPick={onSwitchAgent}
          cliRuntimeScope={cliRuntimeScope}
          triggerClassName="yolo-assistant-selector-button yolo-chat-header-agent"
          triggerContent={
            <>
              <div className="yolo-assistant-selector-current-icon">
                {agentDisplay.icon}
              </div>
              <div className="yolo-assistant-selector-current">
                {agentDisplay.name}
              </div>
              <div className="yolo-assistant-selector-icon">
                <ChevronDown size={10} />
              </div>
            </>
          }
        />
      </div>
      <div className="yolo-chat-header-right">
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
