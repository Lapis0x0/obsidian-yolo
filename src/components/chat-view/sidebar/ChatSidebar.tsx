import { ChevronDown, PanelLeft, Search, SquarePen } from 'lucide-react'
import { Scope } from 'obsidian'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import type { AgentConversationRunSummary } from '../../../core/agent/service'
import type { CliRuntimeScope } from '../../../core/cli-runtime'
import type { ChatConversationMetadata } from '../../../database/json/chat/types'
import type { ConversationPlacement } from '../../../hooks/useChatHistory'
import type { ChatProject } from '../../../types/project.types'
import { AgentPicker } from '../agent-picker/AgentPicker'
import type { AgentRef } from '../agent-picker/agentRef'
import { ChatHistoryList, type ChatHistoryListHandle } from '../ChatHistoryList'

import { PinnedAgents } from './PinnedAgents'
import { SidebarProjects } from './SidebarProjects'
import type {
  ChatSidebarLayout,
  ChatSidebarResizeHandleProps,
} from './useChatSidebarLayout'
import {
  DROP_HISTORY_ATTRIBUTE,
  useSidebarConversationSort,
} from './useSidebarConversationSort'

export type ChatSidebarHandle = {
  /** 让侧边栏可见（展开窄轨 / 打开抽屉）并唤出历史搜索。 */
  openSearch: () => void
}

type ChatSidebarProps = {
  layout: ChatSidebarLayout
  drawerOpen: boolean
  onCloseDrawer: () => void
  onToggle: () => void
  /** 侧边栏元素挂上 / 卸下时回调，宽度由布局 hook 直接写在元素上 */
  registerSidebar: (element: HTMLElement | null) => void
  /** 常驻列右边缘的拖拽把手，拖动调整宽度 */
  resizeHandleProps: ChatSidebarResizeHandleProps
  onNewChat: () => void
  /** 新对话菜单、钉住的 Agent：用指定的 Agent 开新对话 */
  onNewChatWithAgent: (ref: AgentRef) => void
  /** CLI 运行时可用时才传 */
  cliRuntimeScope: CliRuntimeScope | undefined
  chatList: ChatConversationMetadata[]
  currentConversationId: string
  runSummariesByConversationId: Map<string, AgentConversationRunSummary>
  onSelectConversation: (conversationId: string) => void | Promise<void>
  onDeleteConversation: (conversationId: string) => void | Promise<void>
  onUpdateTitle: (
    conversationId: string,
    newTitle: string,
  ) => void | Promise<void>
  onTogglePinned: (conversationId: string) => void | Promise<void>
  onRetryTitle: (conversationId: string) => void | Promise<void>
  onExportConversation: (conversationId: string) => void | Promise<void>
  projects: readonly ChatProject[] | undefined
  /** 当前对话所属的项目 */
  currentProjectId: string | undefined
  onOpenProject: (project: ChatProject) => void
  /** 不传项目表示新建 */
  onOpenProjectSettings: (project?: ChatProject) => void
  onMoveToProject: (conversationId: string, projectId: string | null) => unknown
  /** 拖动对话后写下它的新位置（所属项目、是否置顶、排序） */
  onPlaceConversation: (
    conversationId: string,
    placement: ConversationPlacement,
  ) => unknown
  handleRef: React.MutableRefObject<ChatSidebarHandle | null>
}

/**
 * YOLO Chat 的左侧边栏：标题、新对话、对话历史。
 *
 * 三种形态由 `useChatSidebarLayout` 按对话外壳宽度决定：宽时常驻一列（可收成
 * 窄轨），窄时隐藏、以抽屉盖在对话上。抽屉关着时组件仍然挂载，只是移出视野并
 * 设为 inert，搜索词、展开的分组等状态在开合之间保留。
 */
export function ChatSidebar({
  layout,
  drawerOpen,
  onCloseDrawer,
  onToggle,
  registerSidebar,
  resizeHandleProps,
  onNewChat,
  onNewChatWithAgent,
  cliRuntimeScope,
  chatList,
  currentConversationId,
  runSummariesByConversationId,
  onSelectConversation,
  onDeleteConversation,
  onUpdateTitle,
  onTogglePinned,
  onRetryTitle,
  onExportConversation,
  projects,
  currentProjectId,
  onOpenProject,
  onOpenProjectSettings,
  onMoveToProject,
  onPlaceConversation,
  handleRef,
}: ChatSidebarProps) {
  const { t } = useLanguage()
  const app = useApp()
  const asideRef = useRef<HTMLElement | null>(null)
  const setAside = useCallback(
    (element: HTMLElement | null) => {
      asideRef.current = element
      registerSidebar(element)
    },
    [registerSidebar],
  )
  const historyHandleRef = useRef<ChatHistoryListHandle | null>(null)
  // 历史列表在显示搜索结果或任务对话时占满滚动区，项目区让开
  const [historyExclusive, setHistoryExclusive] = useState(false)
  // 对话的拖动排序挂在滚动区上，行和放下目标都在里面
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  useSidebarConversationSort({
    app,
    scrollElement,
    chatList,
    projects: projects ?? [],
    onPlace: onPlaceConversation,
  })
  // 窄轨上点搜索要先展开、等历史列表挂载后再唤出搜索
  const pendingSearchRef = useRef(false)

  const isDrawer = layout === 'drawer'
  const isHidden = isDrawer && !drawerOpen

  // inert 没有进 React 18 的 props 类型，直接写 DOM 属性。关着的抽屉不可聚焦、
  // 不进 Tab 顺序，也不会被读屏读到。
  useEffect(() => {
    if (asideRef.current) asideRef.current.inert = isHidden
  }, [isHidden])

  // 抽屉打开期间 Esc 关抽屉。列表自己的 scope（焦点在列表里时）压在它上面，
  // 先处理改名取消、收起搜索，无事可做时同样回调到这里。
  useEffect(() => {
    if (!isDrawer || !drawerOpen) return
    const scope = new Scope(app.keymap.scope)
    scope.register([], 'Escape', () => {
      onCloseDrawer()
      return false
    })
    app.keymap.pushScope(scope)
    return () => app.keymap.popScope(scope)
  }, [app, drawerOpen, isDrawer, onCloseDrawer])

  useEffect(() => {
    if (layout === 'rail' || !pendingSearchRef.current) return
    if (isDrawer && !drawerOpen) return
    pendingSearchRef.current = false
    historyHandleRef.current?.focusSearch()
  })

  handleRef.current = {
    openSearch: () => {
      if (layout === 'rail') {
        pendingSearchRef.current = true
        onToggle()
        return
      }
      if (isDrawer && !drawerOpen) {
        pendingSearchRef.current = true
        onToggle()
        return
      }
      historyHandleRef.current?.focusSearch()
    },
  }

  const closeIfDrawer = () => {
    if (isDrawer) onCloseDrawer()
  }

  const newChatLabel = t('chat.newChat', 'New chat')
  const searchLabel = t('sidebar.chatSidebar.search', 'Search conversations')

  if (layout === 'rail') {
    return (
      <aside
        ref={setAside}
        className="yolo-chat-sidebar yolo-chat-sidebar--rail"
      >
        <button
          type="button"
          className="yolo-chat-sidebar-rail-button yolo-chat-sidebar-rail-button--primary"
          aria-label={newChatLabel}
          onClick={onNewChat}
        >
          <SquarePen size={16} />
        </button>
        <button
          type="button"
          className="yolo-chat-sidebar-rail-button"
          aria-label={searchLabel}
          onClick={() => handleRef.current?.openSearch()}
        >
          <Search size={16} />
        </button>
        <PinnedAgents
          cliRuntimeScope={cliRuntimeScope}
          compact
          onStart={onNewChatWithAgent}
        />
        <div className="yolo-chat-sidebar-rail-spacer" />
        <button
          type="button"
          className="yolo-chat-sidebar-rail-button"
          aria-label={t('sidebar.chatSidebar.expand', 'Expand sidebar')}
          onClick={onToggle}
        >
          <PanelLeft size={16} />
        </button>
      </aside>
    )
  }

  return (
    <>
      {isDrawer ? (
        <div
          className={`yolo-chat-sidebar-scrim${drawerOpen ? ' is-open' : ''}`}
          aria-hidden="true"
          onClick={onCloseDrawer}
        />
      ) : null}
      <aside
        ref={setAside}
        className={`yolo-chat-sidebar yolo-chat-sidebar--${layout}${
          drawerOpen ? ' is-open' : ''
        }`}
      >
        <div className="yolo-chat-sidebar-header">
          <span className="yolo-chat-sidebar-title">
            {t('sidebar.chatSidebar.title', 'YOLO')}
          </span>
          <button
            type="button"
            className="clickable-icon"
            aria-label={searchLabel}
            onClick={() => historyHandleRef.current?.focusSearch()}
          >
            <Search size={16} />
          </button>
          <button
            type="button"
            className="clickable-icon"
            aria-label={
              isDrawer
                ? t('sidebar.chatSidebar.close', 'Close sidebar')
                : t('sidebar.chatSidebar.collapse', 'Collapse sidebar')
            }
            onClick={isDrawer ? onCloseDrawer : onToggle}
          >
            <PanelLeft size={16} />
          </button>
        </div>
        <div className="yolo-chat-sidebar-actions">
          <div className="yolo-chat-sidebar-new-chat">
            <button
              type="button"
              className="yolo-chat-sidebar-new-chat-main"
              onClick={() => {
                onNewChat()
                closeIfDrawer()
              }}
            >
              <SquarePen size={16} />
              <span>{newChatLabel}</span>
            </button>
            <AgentPicker
              onPick={(ref) => {
                onNewChatWithAgent(ref)
                closeIfDrawer()
              }}
              cliRuntimeScope={cliRuntimeScope}
              triggerClassName="yolo-chat-sidebar-new-chat-menu"
              triggerLabel={t(
                'chat.agentPicker.newChatWithAgent',
                'New chat with an agent',
              )}
              triggerContent={<ChevronDown size={14} />}
            />
          </div>
          <PinnedAgents
            cliRuntimeScope={cliRuntimeScope}
            compact={false}
            onStart={(ref) => {
              onNewChatWithAgent(ref)
              closeIfDrawer()
            }}
          />
        </div>
        <div
          ref={setScrollElement}
          className="yolo-chat-sidebar-scroll yolo-scrollbar-autohide"
        >
          {historyExclusive ? null : (
            <SidebarProjects
              projects={projects ?? []}
              chatList={chatList}
              currentConversationId={currentConversationId}
              currentProjectId={currentProjectId}
              runSummariesByConversationId={runSummariesByConversationId}
              onOpenProject={(project) => {
                onOpenProject(project)
                closeIfDrawer()
              }}
              onCreateProject={() => onOpenProjectSettings()}
              onMoveToProject={onMoveToProject}
              onSelectConversation={(conversationId) => {
                closeIfDrawer()
                if (conversationId === currentConversationId) return
                void onSelectConversation(conversationId)
              }}
            />
          )}
          {/* 置顶和其余对话两个列表的范围，见 useSidebarConversationSort */}
          <div {...{ [DROP_HISTORY_ATTRIBUTE]: '' }}>
            <ChatHistoryList
              chatList={chatList}
              projects={projects}
              onMoveToProject={onMoveToProject}
              sortable
              onExclusiveViewChange={setHistoryExclusive}
              currentConversationId={currentConversationId}
              runSummariesByConversationId={runSummariesByConversationId}
              onSelect={(conversationId) => {
                closeIfDrawer()
                if (conversationId === currentConversationId) return
                return onSelectConversation(conversationId)
              }}
              onDelete={onDeleteConversation}
              onUpdateTitle={onUpdateTitle}
              onTogglePinned={onTogglePinned}
              onRetryTitle={onRetryTitle}
              onExportConversation={onExportConversation}
              onIdleEscape={isDrawer ? onCloseDrawer : undefined}
              handleRef={historyHandleRef}
            />
          </div>
        </div>
        {layout === 'column' ? (
          <div
            className="yolo-chat-sidebar-resize-handle"
            role="separator"
            aria-orientation="vertical"
            {...resizeHandleProps}
          />
        ) : null}
      </aside>
    </>
  )
}
