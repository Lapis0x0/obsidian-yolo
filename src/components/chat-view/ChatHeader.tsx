import { ArrowLeft, Download, History, Plus, Settings } from 'lucide-react'
import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from 'react'
import { useEffect, useRef } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import {
  type ChatRuntimeId,
  type CliRuntimeId,
  type CliRuntimeScope,
  RUNTIME_CAPABILITIES,
  isCliRuntime,
} from '../../core/cli-runtime'
import type {
  ChatConversationCliSession,
  ChatConversationMetadata,
} from '../../database/json/chat/types'
import type {
  ChatConversationCompactionState,
  ChatMessage,
} from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { MentionableBlockData } from '../../types/mentionable'

import { AssistantSelector } from './AssistantSelector'
import { type ChatMode, isModuleChatMode } from './chat-input/ChatModeSelect'
import { ChatListDropdown } from './ChatListDropdown'
import { HermesProfileSelector } from './HermesProfileSelector'
import { RuntimeSelector } from './RuntimeSelector'
import type { SparkleView } from './sparkle/SparklePanel'
import ViewToggle from './ViewToggle'

const WORKSPACE_WIDE_HEADER_MIN_WIDTH = 1200

export type ChatHeaderProps = {
  isSidebarPlacement: boolean
  activeView: 'chat' | 'composer'
  onChangeView?: (view: 'chat' | 'composer') => void
  sparkleView: SparkleView
  onChangeSparkleView: (view: SparkleView) => void
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
  chatList: ChatConversationMetadata[]
  activeHistoryConversationId: string
  runSummariesByConversationId: Map<string, AgentConversationRunSummary>
  handleLoadConversation: (conversationId: string) => Promise<void>
  getConversationById: (id: string) => Promise<{
    messages: ChatMessage[]
    overrides: ConversationOverrideSettings | null | undefined
    assistantId?: string
    conversationModelId?: string
    messageModelMap?: Record<string, string>
    activeBranchByUserMessageId?: Record<string, string>
    assistantGroupBoundaryMessageIds?: string[]
    reasoningLevel?: string
    compaction?: ChatConversationCompactionState
    cliSession?: ChatConversationCliSession
  } | null>
  /**
   * issue #567 Step 2：删除会话后的清理（CLI overlay 移除）+ 会话切换逻辑
   * 下沉到 Chat.tsx 单一实现，供本组件与 `ChatRef.deleteCurrentConversation`
   * 共用，取代原先直接内联在 `onDelete` 里的那段逻辑。
   */
  deleteConversationWithCleanup: (conversationId: string) => Promise<void>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  syncCliConversationTitle: (conversationId: string, title: string) => void
  toggleConversationPinned: (id: string) => Promise<void>
  generateConversationTitle: (
    id: string,
    messages: ChatMessage[],
    options?: {
      force?: boolean
    },
  ) => Promise<string | null>
  /** 见 `ChatListDropdown` 的 `openHandleRef` 文档注释。 */
  historyOpenHandleRef: MutableRefObject<(() => void) | null>
}

export function ChatHeader({
  isSidebarPlacement,
  activeView,
  onChangeView,
  sparkleView,
  onChangeSparkleView,
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
  chatList,
  activeHistoryConversationId,
  runSummariesByConversationId,
  handleLoadConversation,
  getConversationById,
  deleteConversationWithCleanup,
  updateConversationTitle,
  syncCliConversationTitle,
  toggleConversationPinned,
  generateConversationTitle,
  historyOpenHandleRef,
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
        {onChangeView ? (
          <ViewToggle
            activeView={activeView}
            onChangeView={onChangeView}
            activeChatSurface={activeRuntimeId === 'yolo' ? 'chat' : 'cli'}
            onChangeChatSurface={(surface) => {
              handleRuntimeChange(
                surface === 'chat' ? 'yolo' : lastCliRuntimeIdRef.current,
              )
            }}
            showCliMode={cliRuntimeAvailable && cliRuntimeScope !== undefined}
            showComposer={isSidebarPlacement}
          />
        ) : (
          <h1 className="yolo-chat-header-title">
            {t('sidebar.tabs.chat', 'Chat')}
          </h1>
        )}
        {activeView === 'chat' && isCliRuntime(activeRuntimeId) ? (
          <RuntimeSelector
            currentRuntimeId={activeRuntimeId}
            onRuntimeChange={handleRuntimeChange}
          />
        ) : null}
      </div>
      {activeView === 'chat' && (
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
            <ChatListDropdown
              chatList={chatList}
              currentConversationId={activeHistoryConversationId}
              runSummariesByConversationId={runSummariesByConversationId}
              openHandleRef={historyOpenHandleRef}
              onSelect={(conversationId) => {
                if (conversationId === activeHistoryConversationId) return
                void handleLoadConversation(conversationId)
              }}
              onDelete={(conversationId) => {
                void deleteConversationWithCleanup(conversationId)
              }}
              onUpdateTitle={async (conversationId, newTitle) => {
                await updateConversationTitle(conversationId, newTitle)
                syncCliConversationTitle(conversationId, newTitle)
              }}
              onTogglePinned={(conversationId) => {
                void toggleConversationPinned(conversationId)
              }}
              onRetryTitle={async (conversationId) => {
                const conversation = await getConversationById(conversationId)
                if (!conversation) {
                  console.error(
                    'Failed to retry conversation title generation: conversation not found',
                    {
                      conversationId,
                    },
                  )
                  return
                }
                const title = await generateConversationTitle(
                  conversationId,
                  conversation.messages,
                  {
                    force: true,
                  },
                )
                if (title) syncCliConversationTitle(conversationId, title)
              }}
              onExportConversation={handleExportChatToVault}
            >
              <History size={18} />
            </ChatListDropdown>
          </div>
        </div>
      )}
      {activeView === 'composer' && (
        <div className="yolo-chat-header-right">
          <div className="yolo-chat-header-buttons">
            <button
              type="button"
              className={`clickable-icon${
                sparkleView === 'settings' ? ' is-active' : ''
              }`}
              aria-label={
                sparkleView === 'settings'
                  ? t('sparkle.settings.back', 'Back')
                  : t('sparkle.settings.open', 'Sparkle settings')
              }
              aria-pressed={sparkleView === 'settings'}
              onClick={() =>
                onChangeSparkleView(
                  sparkleView === 'settings' ? 'main' : 'settings',
                )
              }
            >
              {/* 齿轮与返回箭头同格堆叠、互相交接：这个按钮既是设置入口也是
                  设置出口，图标自己交代当前按下去会发生什么，设置视图因此
                  不再需要一行返回栏。 */}
              <span
                className={`yolo-sparkle-settings-toggle-icon${
                  sparkleView === 'settings' ? ' is-open' : ''
                }`}
                aria-hidden="true"
              >
                <span className="yolo-sparkle-settings-toggle-gear">
                  <Settings size={18} />
                </span>
                <span className="yolo-sparkle-settings-toggle-back">
                  <ArrowLeft size={18} />
                </span>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
