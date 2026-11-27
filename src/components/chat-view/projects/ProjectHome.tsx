import { Ban, Brain, Ellipsis, Folder, Globe, Settings2 } from 'lucide-react'
import { type App, Menu, TFile } from 'obsidian'
import { type ReactNode, useEffect, useMemo, useState } from 'react'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import type { AgentConversationRunSummary } from '../../../core/agent/service'
import { resolveMemoryIndexPaths } from '../../../core/memory/memoryStore'
import {
  type ChatConversationMetadata,
  getChatConversationOrigin,
} from '../../../database/json/chat/types'
import type { ChatProject } from '../../../types/project.types'
import { getConversationDisplayTitle } from '../../../utils/chat/conversationTitle'
import { ObsidianIcon } from '../../common/ObsidianIcon'
import { ScopeEditorModal } from '../../settings/scope/ScopeEditorModal'
import {
  estimateFiles,
  rulesFromWorkspaceScope,
  workspaceScopeFromRules,
} from '../../settings/scope/scopeRules'
import { collectScopeCandidateFiles } from '../../settings/scope/scopeVault'
import { ChatRuntimeBadge } from '../ChatHistoryList'

import { PROJECT_COLORS, PROJECT_ICONS } from './projectAppearance'
import { useExistingInstructionFiles } from './ProjectSettingsModal'

/** 项目指令预览只取开头几行，右栏卡片里放不下更多 */
const INSTRUCTION_PREVIEW_LINES = 8
/** 项目记忆卡片列出的条目数 */
const MEMORY_PREVIEW_ENTRIES = 3

const projectColorStyle = (project: ChatProject) =>
  ({
    '--yolo-project-color': project.color ?? PROJECT_COLORS[0],
  }) as React.CSSProperties

type ProjectHomeData = {
  project: ChatProject
  /** 该项目的对话，按最近活动倒序 */
  conversations: readonly ChatConversationMetadata[]
  runSummariesByConversationId: Map<string, AgentConversationRunSummary>
  onSelectConversation: (conversationId: string) => void
  onOpenSettings: () => void
}

export const selectProjectConversations = (
  chatList: readonly ChatConversationMetadata[],
  projectId: string,
): ChatConversationMetadata[] =>
  chatList
    .filter(
      (chat) =>
        chat.projectId === projectId &&
        getChatConversationOrigin(chat) === 'user',
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)

function useRelativeTime() {
  const { t, language } = useLanguage()
  return useMemo(() => {
    const relative = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
    return (timestamp: number): string => {
      const now = Date.now()
      const minutes = Math.round((now - timestamp) / 60_000)
      if (minutes < 1) return t('chat.projects.justNow', 'just now')
      if (minutes < 60) return relative.format(-minutes, 'minute')
      const hours = Math.round(minutes / 60)
      const startOfToday = new Date(now).setHours(0, 0, 0, 0)
      if (timestamp >= startOfToday) return relative.format(-hours, 'hour')
      const days = Math.ceil((startOfToday - timestamp) / 86_400_000)
      if (days <= 1) return relative.format(-1, 'day')
      const date = new Date(timestamp)
      if (days < 7) {
        return date.toLocaleDateString(language, { weekday: 'short' })
      }
      return date.toLocaleDateString(language, {
        month: 'numeric',
        day: 'numeric',
      })
    }
  }, [language, t])
}

/** 读一个 vault 文件的文本，文件被改动时跟着刷新；不存在时为 null */
function useVaultFileText(app: App, path: string | null): string | null {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!path) {
      setText(null)
      return
    }
    let cancelled = false
    const load = () => {
      const file = app.vault.getFileByPath(path)
      if (!file) {
        setText(null)
        return
      }
      void app.vault.cachedRead(file).then((content) => {
        if (!cancelled) setText(content)
      })
    }
    load()
    const refresh = (file: unknown) => {
      if (file instanceof TFile && file.path === path) load()
    }
    const refs = [
      app.vault.on('modify', refresh),
      app.vault.on('create', refresh),
      app.vault.on('delete', refresh),
    ]
    return () => {
      cancelled = true
      refs.forEach((ref) => app.vault.offref(ref))
    }
  }, [app, path])
  return text
}

/** MEMORY.md 的条目行：`- [标题](file.md) — 何时读` */
const parseMemoryEntries = (index: string): string[] =>
  index
    .split('\n')
    .map((line) => line.match(/^\s*[-*]\s+\[([^\]]+)\]/)?.[1])
    .filter((title): title is string => Boolean(title))

/**
 * 项目主页的页头：项目图标、名称、对话概况，以及项目设定入口。作为项目里新
 * 对话的空状态，位于输入框上方。`agentSwitcher` 放在页头最后一行的右端，正好
 * 落在输入框右上角：在这里选这次和谁对话。
 */
export function ProjectHomeHeader({
  project,
  conversations,
  runSummariesByConversationId,
  onOpenSettings,
  agentSwitcher,
}: Omit<ProjectHomeData, 'onSelectConversation'> & {
  agentSwitcher?: ReactNode
}) {
  const { t } = useLanguage()
  const formatRelativeTime = useRelativeTime()
  const runningCount = conversations.filter(
    (chat) => runSummariesByConversationId.get(chat.id)?.isActive,
  ).length
  const facts = [
    t('chat.projects.conversationCount', '{count} conversations').replace(
      '{count}',
      String(conversations.length),
    ),
    runningCount > 0
      ? t('chat.projects.runningCount', '{count} running').replace(
          '{count}',
          String(runningCount),
        )
      : null,
    conversations[0]
      ? t('chat.projects.lastActivity', 'Last activity {time}').replace(
          '{time}',
          formatRelativeTime(conversations[0].updatedAt),
        )
      : null,
  ].filter((fact): fact is string => fact !== null)

  return (
    <div
      className="yolo-project-home-header"
      style={projectColorStyle(project)}
    >
      <span className="yolo-project-home-icon">
        <ObsidianIcon name={project.icon ?? PROJECT_ICONS[0]} />
      </span>
      <div className="yolo-project-home-heading">
        <h1 className="yolo-project-home-title">{project.name}</h1>
        <div className="yolo-project-home-facts">
          {facts.map((fact, index) => (
            <span key={fact}>
              {index > 0 ? (
                <span className="yolo-project-home-facts-separator">·</span>
              ) : null}
              {fact}
            </span>
          ))}
        </div>
      </div>
      <div className="yolo-project-home-actions">
        <button
          type="button"
          className="yolo-project-home-button"
          onClick={onOpenSettings}
        >
          <Settings2 size={14} />
          <span>{t('chat.projects.editTitle', 'Project settings')}</span>
        </button>
        <button
          type="button"
          className="yolo-project-home-button is-icon"
          aria-label={t('chat.projects.more', 'More')}
          onClick={(event) => {
            const menu = new Menu()
            menu.addItem((item) =>
              item
                .setTitle(t('chat.projects.editTitle', 'Project settings'))
                .setIcon('settings-2')
                .onClick(onOpenSettings),
            )
            menu.showAtMouseEvent(event.nativeEvent)
          }}
        >
          <Ellipsis size={14} />
        </button>
      </div>
      {agentSwitcher ? (
        <div className="yolo-project-home-agent-row">{agentSwitcher}</div>
      ) : null}
    </div>
  )
}

function ConversationList({
  conversations,
  runSummariesByConversationId,
  onSelectConversation,
}: Pick<
  ProjectHomeData,
  'conversations' | 'runSummariesByConversationId' | 'onSelectConversation'
>) {
  const { t } = useLanguage()
  const formatRelativeTime = useRelativeTime()
  const untitledFallback = t('chat.untitledConversation', 'New chat')
  return (
    <section className="yolo-project-home-conversations">
      <div className="yolo-project-home-section-title">
        <h2>{t('chat.projects.conversations', 'Conversations')}</h2>
        <span>{conversations.length}</span>
      </div>
      {conversations.length === 0 ? (
        <div className="yolo-project-home-empty">
          {t(
            'chat.projects.noConversationsHint',
            'Conversations you start here belong to this project.',
          )}
        </div>
      ) : (
        <div className="yolo-project-home-conversation-list">
          {conversations.map((chat) => {
            const summary = runSummariesByConversationId.get(chat.id)
            return (
              <button
                key={chat.id}
                type="button"
                className="yolo-project-home-conversation"
                onClick={() => onSelectConversation(chat.id)}
              >
                <span className="yolo-project-home-conversation-title">
                  <span>
                    {getConversationDisplayTitle(chat.title, untitledFallback)}
                  </span>
                  {summary?.isActive ? (
                    <span
                      className={`yolo-chat-run-dot is-${
                        summary.isWaitingApproval ? 'waiting' : 'running'
                      }`}
                    />
                  ) : null}
                </span>
                {chat.cliSession ? (
                  <ChatRuntimeBadge runtimeId={chat.cliSession.runtimeId} />
                ) : null}
                <span className="yolo-project-home-conversation-time">
                  {formatRelativeTime(chat.updatedAt)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function WorkspaceCard({ project }: { project: ChatProject }) {
  const { t } = useLanguage()
  const app = useApp()
  const { settings, setSettings } = useSettings()
  const rules = useMemo(
    () => rulesFromWorkspaceScope(project.workspaceScope),
    [project.workspaceScope],
  )
  const candidateFiles = useMemo(
    () => collectScopeCandidateFiles(app.vault),
    [app.vault],
  )
  const estimate = useMemo(
    () => estimateFiles(candidateFiles, rules),
    [candidateFiles, rules],
  )
  const { include, exclude } = project.workspaceScope

  const editRange = () => {
    new ScopeEditorModal(app, app.vault, {
      rules,
      defaultRules: [],
      allowFiles: true,
      variant: 'agent',
      candidateFiles,
      onSave: (nextRules) => {
        const next: ChatProject = {
          ...project,
          workspaceScope: {
            enabled: true,
            ...workspaceScopeFromRules(nextRules),
          },
          updatedAt: Date.now(),
        }
        void setSettings({
          ...settings,
          projects: (settings.projects ?? []).map((item) =>
            item.id === project.id ? next : item,
          ),
        }).catch((error: unknown) => {
          console.error('Failed to update project workspace', error)
        })
      },
    }).open()
  }

  return (
    <div className="yolo-project-home-card">
      <div className="yolo-project-home-card-head">
        <span>{t('chat.projects.workspace', 'Workspace')}</span>
        <button type="button" onClick={editRange}>
          {t('settings.scope.editRange', 'Edit range')}
        </button>
      </div>
      <div className="yolo-project-home-card-list">
        {include.length === 0 ? (
          <span className="yolo-project-home-card-item">
            <Globe size={13} />
            <span>{t('chat.projects.wholeVault', 'Whole vault')}</span>
          </span>
        ) : null}
        {include.map((path) => (
          <span key={`include:${path}`} className="yolo-project-home-card-item">
            <Folder size={13} className="yolo-project-home-card-folder" />
            <span>{path}</span>
          </span>
        ))}
        {exclude.map((path) => (
          <span
            key={`exclude:${path}`}
            className="yolo-project-home-card-item is-muted"
          >
            <Ban size={13} />
            <span>{path}</span>
          </span>
        ))}
      </div>
      <span className="yolo-project-home-card-note">
        {t(
          'chat.projects.accessibleFiles',
          '{matched} / {total} files accessible',
        )
          .replace('{matched}', estimate.matched.toLocaleString())
          .replace('{total}', estimate.total.toLocaleString())}
      </span>
    </div>
  )
}

function InstructionsCard({ project }: { project: ChatProject }) {
  const { t } = useLanguage()
  const app = useApp()
  const files = useExistingInstructionFiles(app, project.workspaceScope)
  // 根目录以下的那份最贴近项目；没有就用根目录的
  const path = files.find((file) => file.includes('/')) ?? files[0] ?? null
  const text = useVaultFileText(app, path)
  if (!path) return null
  const previewLines = (text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, INSTRUCTION_PREVIEW_LINES)

  return (
    <div className="yolo-project-home-card">
      <div className="yolo-project-home-card-head">
        <span>{t('chat.projects.instructions', 'Project instructions')}</span>
        <button
          type="button"
          onClick={() => void app.workspace.openLinkText(path, '', 'tab')}
        >
          {t('chat.projects.openInObsidian', 'Open in Obsidian')}
        </button>
      </div>
      <span className="yolo-project-home-card-path">{path}</span>
      {previewLines.length > 0 ? (
        <div className="yolo-project-home-card-preview">
          {previewLines.map((line, index) => (
            <div
              key={index}
              className={line.startsWith('#') ? 'is-heading' : undefined}
            >
              {line.replace(/^#+\s*/, '').replace(/^\s*[-*]\s+/, '· ')}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function MemoryCard({ project }: { project: ChatProject }) {
  const { t } = useLanguage()
  const app = useApp()
  const { settings } = useSettings()
  const indexPath = resolveMemoryIndexPaths({
    settings,
    projectId: project.id,
  }).project
  const index = useVaultFileText(app, indexPath)
  const entries = index ? parseMemoryEntries(index) : []

  return (
    <div className="yolo-project-home-card is-memory">
      <div className="yolo-project-home-card-head">
        <span className="yolo-project-home-card-title">
          <Brain size={14} />
          {t('chat.projects.memory', 'Project memory')}
          {entries.length > 0 ? (
            <span className="yolo-project-home-card-count">
              {t('chat.projects.memoryCount', '{count} entries').replace(
                '{count}',
                String(entries.length),
              )}
            </span>
          ) : null}
        </span>
      </div>
      {entries.length === 0 ? (
        <span className="yolo-project-home-card-note">
          {t(
            'chat.projects.memoryEmpty',
            'Agents record durable facts about this project here as you work.',
          )}
        </span>
      ) : (
        <>
          {entries.slice(0, MEMORY_PREVIEW_ENTRIES).map((entry) => (
            <span key={entry} className="yolo-project-home-card-entry">
              {entry}
            </span>
          ))}
          {indexPath ? (
            <button
              type="button"
              className="yolo-project-home-card-link"
              onClick={() =>
                void app.workspace.openLinkText(indexPath, '', 'tab')
              }
            >
              {t('chat.projects.viewMemory', 'View and manage')}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * 项目主页的主体：对话列表与右栏（工作区、项目指令、项目记忆）。宽屏时在
 * 输入框下方，窄屏时接在页头下面、输入框上方，单栏排列。
 */
export function ProjectHomeBody({
  project,
  conversations,
  runSummariesByConversationId,
  onSelectConversation,
}: Omit<ProjectHomeData, 'onOpenSettings'>) {
  return (
    <div className="yolo-project-home-body" style={projectColorStyle(project)}>
      <ConversationList
        conversations={conversations}
        runSummariesByConversationId={runSummariesByConversationId}
        onSelectConversation={onSelectConversation}
      />
      <aside className="yolo-project-home-aside">
        <WorkspaceCard project={project} />
        <InstructionsCard project={project} />
        <MemoryCard project={project} />
      </aside>
    </div>
  )
}
