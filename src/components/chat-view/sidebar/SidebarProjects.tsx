import { ChevronRight, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type { AgentConversationRunSummary } from '../../../core/agent/service'
import {
  type ChatConversationMetadata,
  getChatConversationOrigin,
} from '../../../database/json/chat/types'
import type { ChatProject } from '../../../types/project.types'
import { getConversationDisplayTitle } from '../../../utils/chat/conversationTitle'
import { ObsidianIcon } from '../../common/ObsidianIcon'
import { ChatRuntimeBadge } from '../ChatHistoryList'
import { showMoveToProjectMenu } from '../projects/moveToProjectMenu'
import { PROJECT_COLORS, PROJECT_ICONS } from '../projects/projectAppearance'

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
 * 展开后列出最近几个对话，更多的经「查看全部」进项目主页。行尾平时显示对话数，
 * 有对话在运行或等你确认时换成状态点。
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

  const conversationsByProject = useMemo(() => {
    const map = new Map<string, ChatConversationMetadata[]>()
    for (const chat of chatList) {
      if (!chat.projectId || getChatConversationOrigin(chat) !== 'user') {
        continue
      }
      const list = map.get(chat.projectId) ?? []
      list.push(chat)
      map.set(chat.projectId, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    return map
  }, [chatList])

  // 当前对话还没落盘、又在某个项目里，说明正停在这个项目的主页上
  const isOnProjectHome = !chatList.some(
    (chat) => chat.id === currentConversationId,
  )
  const untitledFallback = t('chat.untitledConversation', 'New chat')

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
        {projects.map((project) => {
          const conversations = conversationsByProject.get(project.id) ?? []
          const expanded = expandedIds.has(project.id)
          const runStates = conversations.map((chat) =>
            getRunState(runSummariesByConversationId.get(chat.id)),
          )
          const projectRunState: RunState = runStates.includes('waiting')
            ? 'waiting'
            : runStates.includes('running')
              ? 'running'
              : null
          const active = project.id === currentProjectId && isOnProjectHome
          return (
            <li key={project.id}>
              <div
                className={`yolo-chat-sidebar-project${active ? ' is-active' : ''}${
                  expanded ? ' is-expanded' : ''
                }`}
                style={
                  {
                    '--yolo-project-color': project.color ?? PROJECT_COLORS[0],
                  } as React.CSSProperties
                }
              >
                <button
                  type="button"
                  className="yolo-chat-sidebar-project-main"
                  onClick={() => {
                    setExpanded(project.id, true)
                    onOpenProject(project)
                  }}
                >
                  <span className="yolo-chat-sidebar-project-icon">
                    <ObsidianIcon name={project.icon ?? PROJECT_ICONS[0]} />
                  </span>
                  <span className="yolo-chat-sidebar-project-name">
                    {project.name}
                  </span>
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
                  onClick={() => setExpanded(project.id, !expanded)}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
              {expanded ? (
                <ul className="yolo-chat-sidebar-project-conversations">
                  {conversations.length === 0 ? (
                    <li className="yolo-chat-sidebar-project-conversations-empty">
                      {t(
                        'chat.projects.noConversations',
                        'No conversations yet',
                      )}
                    </li>
                  ) : null}
                  {conversations
                    .slice(0, EXPANDED_CONVERSATION_LIMIT)
                    .map((chat) => (
                      <li key={chat.id}>
                        <button
                          type="button"
                          className={`yolo-chat-sidebar-project-conversation${
                            chat.id === currentConversationId
                              ? ' is-active'
                              : ''
                          }`}
                          onClick={() => onSelectConversation(chat.id)}
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
                            {getConversationDisplayTitle(
                              chat.title,
                              untitledFallback,
                            )}
                          </span>
                          {chat.cliSession ? (
                            <ChatRuntimeBadge
                              runtimeId={chat.cliSession.runtimeId}
                            />
                          ) : null}
                          <RunDot
                            state={getRunState(
                              runSummariesByConversationId.get(chat.id),
                            )}
                          />
                        </button>
                      </li>
                    ))}
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
        })}
      </ul>
    </section>
  )
}
