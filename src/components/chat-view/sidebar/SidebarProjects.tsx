import { ChevronRight, Plus } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

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

import { useProjectCardDisclosure } from './useProjectCardDisclosure'
import {
  DROP_PROJECT_ATTRIBUTE,
  SORT_CAPPED_ATTRIBUTE,
  projectSortGroup,
  sortableRowAttributes,
} from './useSidebarConversationSort'

/**
 * 展开一个项目时先列出的对话数，其余的由最后一行「再显示 N 个」就地展开，
 * 每点一次最多再列出 EXPANDED_CONVERSATION_STEP 个，免得对话很多的项目
 * 一下子铺满侧边栏。侧边栏承担排序，看得到才拖得动，所以展开在侧边栏里
 * 而不是跳到项目主页。
 */
const EXPANDED_CONVERSATION_LIMIT = 5
const EXPANDED_CONVERSATION_STEP = 10

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
  /** 展开的项目。由侧边栏持有：把对话拖进折叠的项目时也要展开它 */
  expandedIds: ReadonlySet<string>
  onSetExpanded: (projectId: string, expanded: boolean) => void
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
 * useSidebarConversationSort。
 */
export function SidebarProjects({
  projects,
  chatList,
  currentConversationId,
  currentProjectId,
  expandedIds,
  onSetExpanded,
  runSummariesByConversationId,
  onOpenProject,
  onCreateProject,
  onSelectConversation,
  onMoveToProject,
}: SidebarProjectsProps) {
  const { t } = useLanguage()
  /** 点过「再显示」的项目此刻列出的对话数；没有的按 EXPANDED_CONVERSATION_LIMIT */
  const [shownCounts, setShownCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  )
  const setShownCount = (projectId: string, count: number | null) => {
    setShownCounts((current) => {
      if (current.get(projectId) === (count ?? undefined)) return current
      const next = new Map(current)
      if (count === null) next.delete(projectId)
      else next.set(projectId, count)
      return next
    })
  }

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
            shownCount={
              shownCounts.get(project.id) ?? EXPANDED_CONVERSATION_LIMIT
            }
            onSetShownCount={(count) => setShownCount(project.id, count)}
            active={project.id === currentProjectId && isOnProjectHome}
            currentConversationId={currentConversationId}
            runSummariesByConversationId={runSummariesByConversationId}
            onSetExpanded={(expanded) => {
              // 收起项目时「再显示」也一并收起，下次展开从头来
              if (!expanded) setShownCount(project.id, null)
              onSetExpanded(project.id, expanded)
            }}
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
  shownCount,
  onSetShownCount,
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
  /** 列出前几个对话 */
  shownCount: number
  /** null 表示收回到默认的前几个 */
  onSetShownCount: (count: number | null) => void
  active: boolean
  currentConversationId: string
  runSummariesByConversationId: Map<string, AgentConversationRunSummary>
  onSetExpanded: (expanded: boolean) => void
  onOpenProject: (project: ChatProject) => void
  onSelectConversation: (conversationId: string) => void
  onMoveToProject: (conversationId: string, projectId: string | null) => unknown
}) {
  const { t } = useLanguage()
  const cardRef = useRef<HTMLLIElement>(null)
  // 卡片此刻显示的样子：收起、少列几个时要等动画播完才真的变（见
  // useProjectCardDisclosure）。箭头和底色（is-open）跟着 expanded 立即变
  const { display, disclosing } = useProjectCardDisclosure(cardRef, {
    expanded,
    count: shownCount,
  })
  const hasMore = conversations.length > EXPANDED_CONVERSATION_LIMIT
  const shown = conversations.slice(0, display.count)
  /**
   * 点过之后还没列出的对话数；不大于 0 时最后一行是「收起」。按点过之后的
   * shownCount 算，不等动画：这一行贴着底边走，文字点下去就换
   */
  const hidden = conversations.length - shownCount
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
      ref={cardRef}
      className={`yolo-chat-sidebar-project-item${
        expanded ? ' is-open' : ''
      }${display.expanded ? ' is-expanded' : ''}`}
      data-disclosing={disclosing ?? undefined}
      style={projectColorStyle(project.color)}
      {...{ [DROP_PROJECT_ATTRIBUTE]: project.id }}
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
      {display.expanded ? (
        <ul className="yolo-chat-sidebar-project-conversations">
          {conversations.length === 0 ? (
            <li className="yolo-chat-sidebar-project-conversations-empty">
              {t('chat.projects.noConversations', 'No conversations yet')}
            </li>
          ) : null}
          {shown.map((chat) => (
            <ProjectConversationRow
              key={chat.id}
              chat={chat}
              projectId={project.id}
              projects={projects}
              active={chat.id === currentConversationId}
              runState={getRunState(runSummariesByConversationId.get(chat.id))}
              onSelect={onSelectConversation}
              onMoveToProject={onMoveToProject}
            />
          ))}
          {hasMore ? (
            // 还有没列出的对话时，这个列表是满的：拖进来的对话会把最后一个
            // 挤到「更多」里（见 useSidebarConversationSort）
            <li
              className="yolo-chat-sidebar-project-more-row"
              {...(hidden > 0
                ? { [SORT_CAPPED_ATTRIBUTE]: projectSortGroup(project.id) }
                : undefined)}
            >
              <button
                type="button"
                className="yolo-chat-sidebar-project-conversation yolo-chat-sidebar-project-more"
                onClick={() =>
                  onSetShownCount(
                    hidden > 0 ? shownCount + EXPANDED_CONVERSATION_STEP : null,
                  )
                }
              >
                {hidden > 0
                  ? t('chat.projects.showMore', 'Show {count} more').replace(
                      '{count}',
                      String(Math.min(hidden, EXPANDED_CONVERSATION_STEP)),
                    )
                  : t('chat.projects.showLess', 'Show less')}
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
  return (
    <li>
      {/* 拖动排序见 useSidebarConversationSort，拖动的是这个按钮 */}
      <button
        type="button"
        className={`yolo-chat-sidebar-project-conversation${
          active ? ' is-active' : ''
        }`}
        {...sortableRowAttributes(chat.id, projectSortGroup(projectId))}
        onClick={() => onSelect(chat.id)}
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
