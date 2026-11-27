import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronRight, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type { AgentConversationRunSummary } from '../../../core/agent/service'
import type { ChatConversationMetadata } from '../../../database/json/chat/types'
import type { ChatProject } from '../../../types/project.types'
import { getConversationDisplayTitle } from '../../../utils/chat/conversationTitle'
import { ObsidianIcon } from '../../common/ObsidianIcon'
import { selectProjectConversations } from '../chat-history-list'
import { ChatRuntimeBadge } from '../ChatHistoryList'
import { showMoveToProjectMenu } from '../projects/moveToProjectMenu'
import { PROJECT_ICONS, projectColorStyle } from '../projects/projectAppearance'

import {
  type ConversationDragData,
  SORT_TRANSITION,
  projectSortGroup,
  useProjectDropTarget,
  useSuppressClickAfterDrag,
} from './SidebarConversationDnd'

/** 展开一个项目时列出的最近对话数，更多的从项目主页看 */
const EXPANDED_CONVERSATION_LIMIT = 3

type RunState = 'running' | 'waiting' | null

const getRunState = (
  summary: AgentConversationRunSummary | undefined,
): RunState => {
  if (!summary?.isActive) return null
  return summary.isWaitingApproval ? 'waiting' : 'running'
}

function RunDot({ state }: { state: RunState }) {
  const { t } = useLanguage()
  if (!state) return null
  const label =
    state === 'waiting'
      ? t('chat.projects.waiting', 'Waiting for you')
      : t('chat.projects.running', 'Running')
  return (
    <span className={`yolo-chat-run-dot is-${state}`} title={label}>
      <span className="yolo-sr-only">{label}</span>
    </span>
  )
}

type SidebarProjectsProps = {
  projects: readonly ChatProject[]
  chatList: readonly ChatConversationMetadata[]
  currentConversationId: string
  currentProjectId: string | undefined
  runSummariesByConversationId: Map<string, AgentConversationRunSummary>
  onOpenProject: (project: ChatProject) => void
  /** 新建项目 */
  onCreateProject: () => void
  onSelectConversation: (conversationId: string) => void
  onMoveToProject: (conversationId: string, projectId: string | null) => unknown
}

/**
 * 侧边栏的「项目」区。点项目行进入项目主页并展开，行尾箭头只负责展开收起；
 * 展开后列出前几个对话，更多的经「查看全部」进项目主页。行尾平时显示对话数，
 * 有对话在运行或等你确认时换成状态点。
 *
 * 对话可以从下面的列表拖进项目，也可以在项目里拖动排序，见
 * SidebarConversationDnd。
 */
export function SidebarProjects({
  projects,
  chatList,
  currentConversationId,
  currentProjectId,
  runSummariesByConversationId,
  onOpenProject,
  onCreateProject,
  onSelectConversation,
  onMoveToProject,
}: SidebarProjectsProps) {
  const { t } = useLanguage()
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(currentProjectId ? [currentProjectId] : []),
  )

  const conversationsByProject = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.id,
          selectProjectConversations(chatList, project.id),
        ]),
      ),
    [chatList, projects],
  )

  // 当前对话还没落盘、又在某个项目里，说明正停在这个项目的主页上
  const isOnProjectHome = !chatList.some(
    (chat) => chat.id === currentConversationId,
  )

  const setExpanded = (projectId: string, expanded: boolean) => {
    setExpandedIds((current) => {
      if (current.has(projectId) === expanded) return current
      const next = new Set(current)
      if (expanded) next.add(projectId)
      else next.delete(projectId)
      return next
    })
  }

  return (
    <section className="yolo-chat-sidebar-projects">
      <div className="yolo-chat-sidebar-section-header">
        <span>{t('chat.projects.section', 'Projects')}</span>
        <button
          type="button"
          className="yolo-chat-sidebar-section-action"
          aria-label={t('chat.projects.newTitle', 'New project')}
          onClick={onCreateProject}
        >
          <Plus size={14} />
        </button>
      </div>
      <ul className="yolo-chat-sidebar-project-list">
        {projects.length === 0 ? (
          <li>
            <button
              type="button"
              className="yolo-chat-sidebar-project-empty"
              onClick={onCreateProject}
            >
              <Plus size={14} />
              <span>{t('chat.projects.newTitle', 'New project')}</span>
            </button>
          </li>
        ) : null}
        {projects.map((project) => (
          <SidebarProjectItem
            key={project.id}
            project={project}
            projects={projects}
            conversations={conversationsByProject.get(project.id) ?? []}
            expanded={expandedIds.has(project.id)}
            active={project.id === currentProjectId && isOnProjectHome}
            currentConversationId={currentConversationId}
            runSummariesByConversationId={runSummariesByConversationId}
            onSetExpanded={(expanded) => setExpanded(project.id, expanded)}
            onOpenProject={onOpenProject}
            onSelectConversation={onSelectConversation}
            onMoveToProject={onMoveToProject}
          />
        ))}
      </ul>
    </section>
  )
}

function SidebarProjectItem({
  project,
  projects,
  conversations,
  expanded,
  active,
  currentConversationId,
  runSummariesByConversationId,
  onSetExpanded,
  onOpenProject,
  onSelectConversation,
  onMoveToProject,
}: {
  project: ChatProject
  projects: readonly ChatProject[]
  /** 这个项目的全部对话，按顺序 */
  conversations: readonly ChatConversationMetadata[]
  expanded: boolean
  active: boolean
  currentConversationId: string
  runSummariesByConversationId: Map<string, AgentConversationRunSummary>
  onSetExpanded: (expanded: boolean) => void
  onOpenProject: (project: ChatProject) => void
  onSelectConversation: (conversationId: string) => void
  onMoveToProject: (conversationId: string, projectId: string | null) => unknown
}) {
  const { t } = useLanguage()
  const dropTarget = useProjectDropTarget(project.id)
  const shown = conversations.slice(0, EXPANDED_CONVERSATION_LIMIT)
  const runStates = conversations.map((chat) =>
    getRunState(runSummariesByConversationId.get(chat.id)),
  )
  const projectRunState: RunState = runStates.includes('waiting')
    ? 'waiting'
    : runStates.includes('running')
      ? 'running'
      : null

  return (
    // 展开的项目连同它的对话是一张项目色的淡色卡片；拖着别处的对话悬停时
    // 整个项目（展开时是整张卡片）高亮，松手就放进这个项目
    <li
      ref={dropTarget.setNodeRef}
      className={`yolo-chat-sidebar-project-item${
        expanded ? ' is-expanded' : ''
      }${dropTarget.isOver ? ' is-drop-target' : ''}`}
      style={projectColorStyle(project.color)}
    >
      <div
        className={`yolo-chat-sidebar-project${active ? ' is-active' : ''}${
          expanded ? ' is-expanded' : ''
        }`}
      >
        <button
          type="button"
          className="yolo-chat-sidebar-project-main"
          onClick={() => {
            onSetExpanded(true)
            onOpenProject(project)
          }}
        >
          <span className="yolo-chat-sidebar-project-icon">
            <ObsidianIcon name={project.icon ?? PROJECT_ICONS[0]} />
          </span>
          <span className="yolo-chat-sidebar-project-name">{project.name}</span>
        </button>
        <span className="yolo-chat-sidebar-project-meta">
          {projectRunState ? (
            <RunDot state={projectRunState} />
          ) : conversations.length > 0 ? (
            conversations.length
          ) : null}
        </span>
        <button
          type="button"
          className="yolo-chat-sidebar-project-toggle"
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t('chat.projects.collapse', 'Hide conversations')
              : t('chat.projects.expand', 'Show conversations')
          }
          onClick={() => onSetExpanded(!expanded)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
      {expanded ? (
        <ul className="yolo-chat-sidebar-project-conversations">
          {conversations.length === 0 ? (
            <li className="yolo-chat-sidebar-project-conversations-empty">
              {t('chat.projects.noConversations', 'No conversations yet')}
            </li>
          ) : null}
          <SortableContext
            items={shown.map((chat) => chat.id)}
            strategy={verticalListSortingStrategy}
          >
            {shown.map((chat) => (
              <ProjectConversationRow
                key={chat.id}
                chat={chat}
                projectId={project.id}
                projects={projects}
                active={chat.id === currentConversationId}
                runState={getRunState(
                  runSummariesByConversationId.get(chat.id),
                )}
                onSelect={onSelectConversation}
                onMoveToProject={onMoveToProject}
              />
            ))}
          </SortableContext>
          {conversations.length > EXPANDED_CONVERSATION_LIMIT ? (
            <li>
              <button
                type="button"
                className="yolo-chat-sidebar-project-conversation yolo-chat-sidebar-project-view-all"
                onClick={() => onOpenProject(project)}
              >
                {t(
                  'chat.projects.viewAll',
                  'View all {count} conversations',
                ).replace('{count}', String(conversations.length))}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  )
}

function ProjectConversationRow({
  chat,
  projectId,
  projects,
  active,
  runState,
  onSelect,
  onMoveToProject,
}: {
  chat: ChatConversationMetadata
  projectId: string
  projects: readonly ChatProject[]
  active: boolean
  runState: RunState
  onSelect: (conversationId: string) => void
  onMoveToProject: (conversationId: string, projectId: string | null) => unknown
}) {
  const { t } = useLanguage()
  const title = getConversationDisplayTitle(
    chat.title,
    t('chat.untitledConversation', 'New chat'),
  )
  // attributes 不挂：它给行补上键盘排序用的 role / tabIndex，这里不提供键盘
  // 排序，而这一行本身就是按钮
  const { setNodeRef, listeners, transform, transition, isDragging } =
    useSortable({
      id: chat.id,
      transition: SORT_TRANSITION,
      data: {
        kind: 'conversation',
        title,
        group: projectSortGroup(projectId),
        projectId,
      } satisfies ConversationDragData,
    })
  const suppressClickUntil = useSuppressClickAfterDrag(isDragging)

  return (
    <li
      ref={setNodeRef}
      className={isDragging ? 'yolo-chat-sidebar-sort-slot' : undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <button
        type="button"
        className={`yolo-chat-sidebar-project-conversation${
          active ? ' is-active' : ''
        }`}
        {...listeners}
        onClick={() => {
          if (Date.now() < suppressClickUntil.current) return
          onSelect(chat.id)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          showMoveToProjectMenu({
            projects,
            conversation: chat,
            onMove: onMoveToProject,
            position: { x: event.clientX, y: event.clientY },
            doc: event.currentTarget.ownerDocument,
            removeLabel: t(
              'chat.projects.removeFromProject',
              'Remove from project',
            ),
          })
        }}
      >
        <span className="yolo-chat-sidebar-project-conversation-title">
          {title}
        </span>
        {chat.cliSession ? (
          <ChatRuntimeBadge runtimeId={chat.cliSession.runtimeId} />
        ) : null}
        <RunDot state={runState} />
      </button>
    </li>
  )
}
