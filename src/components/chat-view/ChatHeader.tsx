import { ChevronDown, MoreHorizontal, PanelLeft, Plus } from 'lucide-react'
import { Platform } from 'obsidian'
import type { CSSProperties, KeyboardEvent } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useLanguage } from '../../contexts/language-context'
import type { CliRuntimeScope } from '../../core/cli-runtime'
import type { ChatProject } from '../../types/project.types'
import { getNodeWindow } from '../../utils/dom/window-context'
import { ObsidianIcon } from '../common/ObsidianIcon'

import { AgentPicker, useAgentDisplay } from './agent-picker/AgentPicker'
import type { AgentRef } from './agent-picker/agentRef'
import ContextUsagePopover, {
  type ChatContextUsage,
} from './ContextUsagePopover'
import { PROJECT_COLORS, PROJECT_ICONS } from './projects/projectAppearance'

/**
 * ChatView 在 Obsidian 原生视图标题栏里留出的两个挂载点：标题区（放面包屑）
 * 和按钮区（放在原生 ⋯ 前面）。
 */
export type NativeHeaderSlots = {
  header: HTMLElement
  title: HTMLElement
  actions: HTMLElement
}

/**
 * 原生标题栏此刻是否显示着：放在 Obsidian 侧栏里、或用户关了「显示标签页
 * 标题栏」时它是 display: none，高度为 0。移动端的标题栏另有导航职责，
 * 不往里放东西。
 */
function useNativeHeaderShown(slots: NativeHeaderSlots | undefined): boolean {
  const [shown, setShown] = useState(false)
  useLayoutEffect(() => {
    if (!slots || Platform.isMobile) {
      setShown(false)
      return
    }
    const { header } = slots
    const update = () => {
      setShown(header.isConnected && header.getBoundingClientRect().height > 0)
    }
    update()
    const observer = new (getNodeWindow(header).ResizeObserver)(update)
    observer.observe(header)
    return () => observer.disconnect()
  }, [slots])
  return shown
}

export type ChatHeaderProps = {
  isSidebarPlacement: boolean
  /** 原生标题栏的挂载点；显示着就把面包屑和按钮放进去，否则自己画一条栏 */
  nativeHeader?: NativeHeaderSlots
  /** 当前对话正在和谁对话 */
  currentAgent: AgentRef
  /** 在头部换 Agent：切换当前对话的 Agent，不开新对话 */
  onSwitchAgent: (ref: AgentRef) => void
  /** CLI 运行时可用时才传，选择器据此列出 CLI Agent */
  cliRuntimeScope: CliRuntimeScope | undefined
  /** 当前对话实际使用的模型名，跟在 Agent 名后面；未知时不显示 */
  modelLabel: string | null
  /** 项目主页把 Agent 选择器放在输入框右上角，顶部栏就不再放 */
  showAgentSwitcher: boolean
  /** 对话标题；还没落盘的新对话是「新对话」 */
  title: string
  /** 已落盘的对话才能改名：点标题进入原地编辑 */
  canRename: boolean
  /** 编辑态由 Chat 持有，面板菜单的「重命名」也能把标题切进编辑 */
  renaming: boolean
  onRenamingChange: (renaming: boolean) => void
  onRename: (title: string) => Promise<void>
  /** 对话所属项目，面包屑据此多出「项目 /」一段，点它回项目主页 */
  project: ChatProject | null
  onOpenProject: (project: ChatProject) => void
  /** ⋯：弹出和标签页右键同一份的对话菜单；不传就不显示 */
  onOpenMenu?: (anchor: HTMLElement) => void
  contextUsage: ChatContextUsage | undefined
  handleNewChat: () => void
  /**
   * 侧边栏处于抽屉形态时，头部最左侧给一个开抽屉的按钮；常驻列和窄轨各自
   * 带展开 / 收起按钮，不需要它。
   */
  onOpenSidebar?: () => void
}

/**
 * 对话页的顶部栏：左边是面包屑（所属项目 / 对话标题），右边是正在对话的
 * Agent、上下文占用和新对话。原生视图标题栏显示着时，这两部分分别挂进它的
 * 标题区和按钮区，⋯ 用原生的；没有原生标题栏时（Obsidian 侧栏、用户关了
 * 标题栏、移动端）自己画一条，带上 ⋯。布局见 chat/topbar.css。
 */
export function ChatHeader({
  isSidebarPlacement,
  nativeHeader,
  currentAgent,
  onSwitchAgent,
  cliRuntimeScope,
  modelLabel,
  showAgentSwitcher,
  title,
  canRename,
  renaming,
  onRenamingChange,
  onRename,
  project,
  onOpenProject,
  onOpenMenu,
  contextUsage,
  handleNewChat,
  onOpenSidebar,
}: ChatHeaderProps) {
  const { t } = useLanguage()
  const nativeShown = useNativeHeaderShown(nativeHeader)

  const crumb = (
    <>
      {onOpenSidebar ? (
        <button
          type="button"
          className="clickable-icon yolo-chat-topbar-icon"
          aria-label={t('sidebar.chatSidebar.open', 'Open sidebar')}
          onClick={onOpenSidebar}
        >
          <PanelLeft size={16} />
        </button>
      ) : null}
      <div className="yolo-chat-topbar-crumb">
        {project ? (
          <>
            <button
              type="button"
              className="yolo-chat-topbar-project"
              style={
                {
                  '--yolo-project-color': project.color ?? PROJECT_COLORS[0],
                } as CSSProperties
              }
              onClick={() => onOpenProject(project)}
            >
              <span className="yolo-chat-topbar-project-icon">
                <ObsidianIcon name={project.icon ?? PROJECT_ICONS[0]} />
              </span>
              <span className="yolo-chat-topbar-project-name">
                {project.name}
              </span>
            </button>
            <span className="yolo-chat-topbar-sep" aria-hidden="true">
              /
            </span>
          </>
        ) : null}
        {renaming && canRename ? (
          <TitleEditor
            title={title}
            ariaLabel={t(
              'chat.paneTitle.editingAriaLabel',
              'Editing conversation title',
            )}
            onDone={(nextTitle) => {
              onRenamingChange(false)
              if (nextTitle) void onRename(nextTitle)
            }}
          />
        ) : canRename ? (
          <button
            type="button"
            className="yolo-chat-topbar-title is-editable"
            onClick={() => onRenamingChange(true)}
          >
            {title}
          </button>
        ) : (
          <span className="yolo-chat-topbar-title">{title}</span>
        )}
      </div>
    </>
  )

  const actions = (
    <>
      {showAgentSwitcher ? (
        <AgentSwitcher
          currentAgent={currentAgent}
          onSwitchAgent={onSwitchAgent}
          cliRuntimeScope={cliRuntimeScope}
          modelLabel={modelLabel}
          className="yolo-chat-topbar-agent"
        />
      ) : null}
      {contextUsage ? (
        <ContextUsagePopover
          promptTokens={contextUsage.promptTokens}
          maxContextTokens={contextUsage.maxContextTokens}
          cacheHitRate={contextUsage.cacheHitRate}
          label={contextUsage.label}
          buildInputs={contextUsage.buildBreakdownInputs}
          categories={contextUsage.categories}
        />
      ) : null}
      <button
        type="button"
        className="clickable-icon yolo-chat-topbar-icon"
        aria-label={t('chat.newChat', 'New chat')}
        onClick={() => handleNewChat()}
      >
        <Plus size={16} />
      </button>
    </>
  )

  if (nativeHeader && nativeShown) {
    return (
      <>
        {createPortal(crumb, nativeHeader.title)}
        {createPortal(actions, nativeHeader.actions)}
      </>
    )
  }

  return (
    <div
      className={`yolo-chat-topbar${
        isSidebarPlacement ? ' yolo-chat-topbar--compact' : ''
      }`}
    >
      {crumb}
      {actions}
      {onOpenMenu ? (
        <button
          type="button"
          className="clickable-icon yolo-chat-topbar-icon"
          aria-label={t('chat.projects.more', 'More')}
          onClick={(event) => onOpenMenu(event.currentTarget)}
        >
          <MoreHorizontal size={16} />
        </button>
      ) : null}
    </div>
  )
}

/**
 * 当前对话的 Agent，点开换一个（换的是当前对话的 Agent，不开新对话）。按钮里是
 * 头像、名字，给了模型时再跟上「· YOLO / CLI · 模型」。外形由 className 决定：
 * 顶部栏是带边框的胶囊，项目主页输入框右上角是无边框的一行字。
 */
export function AgentSwitcher({
  currentAgent,
  onSwitchAgent,
  cliRuntimeScope,
  modelLabel,
  className,
  align,
}: {
  currentAgent: AgentRef
  onSwitchAgent: (ref: AgentRef) => void
  cliRuntimeScope: CliRuntimeScope | undefined
  /** 不传就只显示名字 */
  modelLabel?: string | null
  className: string
  align?: 'start' | 'end'
}) {
  const agentDisplay = useAgentDisplay(currentAgent, cliRuntimeScope)
  const isYoloAgent = currentAgent.kind === 'assistant'
  return (
    <AgentPicker
      current={currentAgent}
      onPick={onSwitchAgent}
      cliRuntimeScope={cliRuntimeScope}
      triggerClassName={className}
      align={align}
      triggerContent={
        <>
          <span
            className={`yolo-agent-switcher-avatar ${
              isYoloAgent ? 'is-yolo' : 'is-cli'
            }`}
          >
            {agentDisplay.icon}
          </span>
          <span className="yolo-agent-switcher-name">{agentDisplay.name}</span>
          {modelLabel !== undefined ? (
            <span className="yolo-agent-switcher-meta">
              {` · ${isYoloAgent ? 'YOLO' : 'CLI'}`}
              {modelLabel ? ` · ${modelLabel}` : ''}
            </span>
          ) : null}
          <ChevronDown size={12} className="yolo-agent-switcher-chevron" />
        </>
      }
    />
  )
}

/**
 * 标题的原地编辑框：进入时全选，Enter 或失焦提交，Esc 放弃。空标题或没改动
 * 视为放弃，`onDone` 收到 null。
 */
function TitleEditor({
  title,
  ariaLabel,
  onDone,
}: {
  title: string
  ariaLabel: string
  onDone: (nextTitle: string | null) => void
}) {
  const settledRef = useRef(false)
  const finish = (value: string | null) => {
    if (settledRef.current) return
    settledRef.current = true
    const trimmed = value?.trim() ?? ''
    onDone(trimmed && trimmed !== title ? trimmed : null)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(event.currentTarget.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(null)
    }
  }
  return (
    <input
      className="yolo-chat-topbar-title-input"
      defaultValue={title}
      aria-label={ariaLabel}
      spellCheck={false}
      // 用户刚点了标题要改名，焦点就该落在编辑框里
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  )
}
