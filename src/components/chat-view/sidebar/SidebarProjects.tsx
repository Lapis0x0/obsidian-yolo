import { ChevronRight, Plus, Settings2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  type ChatConversationMetadata,
  getChatConversationOrigin,
} from '../../../database/json/chat/types'
import type { ChatProject } from '../../../types/project.types'
import { getConversationDisplayTitle } from '../../../utils/chat/conversationTitle'
import { ObsidianIcon } from '../../common/ObsidianIcon'
import { showMoveToProjectMenu } from '../projects/moveToProjectMenu'
import { PROJECT_COLORS, PROJECT_ICONS } from '../projects/projectAppearance'

/** 展开一个项目时列出的最近对话数，更早的从项目主页进 */
const EXPANDED_CONVERSATION_LIMIT = 5

type SidebarProjectsProps = {
  projects: readonly ChatProject[]
  chatList: readonly ChatConversationMetadata[]
  currentConversationId: string
  currentProjectId: string | undefined
  onOpenProject: (project: ChatProject) => void
  /** 不传项目表示新建 */
  onOpenProjectSettings: (project?: ChatProject) => void
  onSelectConversation: (conversationId: string) => void
  onMoveToProject: (conversationId: string, projectId: string | null) => unknown
}

/**
 * 侧边栏的「项目」区：每行一个项目，点击进入项目（开一个归入它的新对话，空
 * 状态即项目主页），展开看最近的对话。
 */
export function SidebarProjects({
  projects,
  chatList,
  currentConversationId,
  currentProjectId,
  onOpenProject,
  onOpenProjectSettings,
  onSelectConversation,
  onMoveToProject,
}: SidebarProjectsProps) {
  const { t } = useLanguage()
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
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

  const untitledFallback = t('chat.untitledConversation', 'New chat')

  const toggleExpanded = (projectId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  return (
    <section className="yolo-chat-sidebar-projects">
      <div className="yolo-chat-sidebar-section-header">
        <span>{t('chat.projects.section', 'Projects')}</span>
        <button
          type="button"
          className="clickable-icon"
          aria-label={t('chat.projects.newTitle', 'New project')}
          onClick={() => onOpenProjectSettings()}
        >
          <Plus size={14} />
        </button>
      </div>
      {projects.length === 0 ? (
        <button
          type="button"
          className="yolo-chat-sidebar-project-empty"
          onClick={() => onOpenProjectSettings()}
        >
          <Plus size={14} />
          <span>{t('chat.projects.newTitle', 'New project')}</span>
        </button>
      ) : (
        <ul className="yolo-chat-sidebar-project-list">
          {projects.map((project) => {
            const conversations = conversationsByProject.get(project.id) ?? []
            const expanded = expandedIds.has(project.id)
            return (
              <li key={project.id}>
                <div
                  className={`yolo-chat-sidebar-project${
                    project.id === currentProjectId ? ' is-active' : ''
                  }`}
                  style={
                    {
                      '--yolo-project-color':
                        project.color ?? PROJECT_COLORS[0],
                    } as React.CSSProperties
                  }
                >
                  <button
                    type="button"
                    className="yolo-chat-sidebar-project-toggle"
                    aria-expanded={expanded}
                    aria-label={
                      expanded
                        ? t('chat.projects.collapse', 'Hide conversations')
                        : t('chat.projects.expand', 'Show conversations')
                    }
                    onClick={() => toggleExpanded(project.id)}
                  >
                    <span className="yolo-chat-sidebar-project-icon">
                      <ObsidianIcon name={project.icon ?? PROJECT_ICONS[0]} />
                    </span>
                    <ChevronRight
                      size={14}
                      className="yolo-chat-sidebar-project-chevron"
                    />
                  </button>
                  <button
                    type="button"
                    className="yolo-chat-sidebar-project-main"
                    onClick={() => onOpenProject(project)}
                  >
                    <span className="yolo-chat-sidebar-project-name">
                      {project.name}
                    </span>
                    {conversations.length > 0 ? (
                      <span className="yolo-chat-sidebar-project-count">
                        {conversations.length}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="clickable-icon yolo-chat-sidebar-project-settings"
                    aria-label={t(
                      'chat.projects.editTitle',
                      'Project settings',
                    )}
                    onClick={() => onOpenProjectSettings(project)}
                  >
                    <Settings2 size={14} />
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
                    ) : (
                      conversations
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
                                  position: {
                                    x: event.clientX,
                                    y: event.clientY,
                                  },
                                  doc: event.currentTarget.ownerDocument,
                                  removeLabel: t(
                                    'chat.projects.removeFromProject',
                                    'Remove from project',
                                  ),
                                })
                              }}
                            >
                              {getConversationDisplayTitle(
                                chat.title,
                                untitledFallback,
                              )}
                            </button>
                          </li>
                        ))
                    )}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
