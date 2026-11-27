import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ArrowDown,
  Bot,
  Infinity as InfinityIcon,
  MessageCircle,
  Zap,
} from 'lucide-react'
import { Component, type ReactNode, type RefObject, createRef } from 'react'

import type { ChatMode } from '../../core/agent/chat-mode'
import { isToolChatMode } from '../../core/agent/chat-mode'
import {
  MOTION_DURATION_ENTER_S,
  MOTION_DURATION_EXIT_S,
  MOTION_EASE_IN,
  MOTION_EASE_OUT,
} from '../../styles/tokens/motion'
import type { ChatTimelineItem } from '../../types/chat-timeline'
import { getNodeWindow } from '../../utils/dom/window-context'

import type {
  ChatTimelineRenderVersion,
  UserMessageViewportState,
} from './ChatTimelineList'
import { InstallationIncompleteBanner } from './InstallationIncompleteBanner'
import type { ScrollController } from './scroll/scrollController'
import { SharedConversationSurface } from './SharedConversationSurface'

const DOCK_FLIP_EPSILON_PX = 1
const FOOTER_DOCK_FLIPPING_CLASS = 'yolo-chat-footer--dock-flipping'

type ComposerDockProps = {
  /**
   * 对话页的三种状态（有内容的对话、项目主页、普通主页）之间切换时它会变：
   * 换了对话，或换了一种状态。不变的提交（流式输出、输入框长高）不量位置。
   */
  flipKey: string
  reduceMotion: boolean
  children: ReactNode
}

/**
 * 输入框所在的底栏。它是三种状态之间不变的那个东西：对话里贴底，两种主页里
 * 居中（项目主页更靠上），切换时从旧位置平滑移到新位置，而不是一帧跳过去。
 *
 * 两处静止位置仍由 CSS flex 决定，这里只在切换那一次做 FLIP：
 * getSnapshotBeforeUpdate 在这次提交改 DOM 之前量出它此刻的视觉位置（包括
 * 还没走完的上一次位移，所以连续快速切换会从当前位置接着走），提交后量出新
 * 位置，用 translateY 反推回去再过渡到 0。用类组件是因为只有它能在 DOM 变更前
 * 拿到快照；起点不能用上一次切换时记下的位置，那之后它可能已经因为别的切换
 * （比如两种主页之间）挪过了。
 */
class ComposerDock extends Component<ComposerDockProps> {
  private readonly ref = createRef<HTMLDivElement>()

  /**
   * 挂载后还没画出来过。新挂载的底栏（比如在主页上换 Agent，YOLO 和 CLI 的
   * 会话面板整个换掉）可能在同一帧里紧接着又提交一次、挪到别处（新对话的
   * 项目归属晚一次提交才判定）。那时量到的起点是一个从没画出来的位置，从
   * 那里滑过去只会凭空多出一段位移，所以画出来之前不做。
   */
  private unpainted = true

  componentDidMount() {
    const el = this.ref.current
    if (!el) return
    el.addEventListener('transitionend', this.handleEnd)
    getNodeWindow(el).requestAnimationFrame(() => {
      this.unpainted = false
    })
  }

  getSnapshotBeforeUpdate(previous: ComposerDockProps): number | null {
    if (
      previous.flipKey === this.props.flipKey ||
      this.props.reduceMotion ||
      this.unpainted
    ) {
      return null
    }
    return this.ref.current?.getBoundingClientRect().top ?? null
  }

  componentDidUpdate(
    _previous: ComposerDockProps,
    _state: unknown,
    firstTop: number | null,
  ) {
    const el = this.ref.current
    if (!el || firstTop === null) return
    // 撤掉进行中的位移，量出新的静止位置
    el.classList.remove(FOOTER_DOCK_FLIPPING_CLASS)
    el.setCssProps({ transition: 'none', transform: '' })
    const delta = firstTop - el.getBoundingClientRect().top
    if (Math.abs(delta) < DOCK_FLIP_EPSILON_PX) return
    el.setCssProps({ transform: `translateY(${delta}px)` })
    // 先让反推的位置生效，再交给过渡收回 0
    el.getBoundingClientRect()
    el.classList.add(FOOTER_DOCK_FLIPPING_CLASS)
    el.setCssProps({ transition: '', transform: '' })
  }

  componentWillUnmount() {
    this.ref.current?.removeEventListener('transitionend', this.handleEnd)
  }

  private readonly handleEnd = (event: TransitionEvent) => {
    const el = this.ref.current
    if (!el || event.target !== el || event.propertyName !== 'transform') return
    el.classList.remove(FOOTER_DOCK_FLIPPING_CLASS)
  }

  render() {
    return (
      <div ref={this.ref} className="yolo-chat-footer">
        {this.props.children}
      </div>
    )
  }
}

export type ChatConversationPaneProps = {
  chatMode: ChatMode
  yoloEnabled: boolean
  showEmptyState: boolean
  groupedChatMessagesLength: number
  isAutoFollowEnabled: boolean
  currentConversationId: string
  chatTimelineItems: ChatTimelineItem[]
  chatMessagesRef: RefObject<HTMLDivElement>
  onScrollContainerChange: (element: HTMLElement | null) => void
  onBottomSentinelChange: (element: HTMLElement | null) => void
  scrollController?: ScrollController
  renderChatTimelineItem: (timelineItem: ChatTimelineItem) => ReactNode
  timelineRenderVersion?: ChatTimelineRenderVersion<ChatTimelineItem>
  editingAssistantMessageId: string | null
  onForceScrollToBottom: () => void
  hasStreamingMessages: boolean
  scrollToBottomLabel: string
  scrollToBottomWhileStreamingLabel: string
  emptyStateAskTitle: string
  emptyStateAgentTitle: string
  emptyStateAgentFullTitle: string
  /**
   * Max's own empty-state copy. Max is agent-shaped here — tools plus a trust
   * profile — but it reaches past the vault into local files and the terminal,
   * so it says its own thing instead of borrowing Agent's. Surfaces without
   * Max (Quick Ask, the CLI runtimes) omit this and never reach `'max'`.
   */
  emptyStateMaxCopy?: {
    title: string
    description: string
    fullTitle: string
    fullDescription: string
  }
  emptyStateWorkspaceTitle?: ReactNode
  emptyStateAskDescription: string
  emptyStateAgentDescription: string
  emptyStateAgentFullDescription: string
  emptyStateIcon?: ReactNode
  emptyStateIconMode?: string
  /**
   * Full override for the empty state, taking priority over every other
   * `emptyState*` prop. A module chat mode supplies its registry label and
   * description; a project's home (the empty state of a new conversation in
   * a project) supplies its own `content`, laid out by itself.
   */
  emptyStateOverride?:
    | {
        title: ReactNode
        description: ReactNode
        icon?: ReactNode
      }
    | { content: ReactNode }
  footerContent: ReactNode
  onTimelineVirtualizationChange?: (isVirtualized: boolean) => void
  onUserMessageViewportChange?: (state: UserMessageViewportState) => void
  windowNavigationKey?: number
  windowNavigationTargetMessageId?: string | null
  messageNavigatorContent?: ReactNode
  hasEarlierMessages?: boolean
  hasNewerMessages?: boolean
  onLoadEarlier?: () => void
  onLoadNewer?: () => void
  onGrowWindowToFillViewport?: () => void
  historyWindowKey?: string
  bottomSpacerHeight?: number
}

export function ChatConversationPane({
  chatMode,
  yoloEnabled,
  showEmptyState,
  groupedChatMessagesLength,
  isAutoFollowEnabled,
  currentConversationId,
  chatTimelineItems,
  chatMessagesRef,
  onScrollContainerChange,
  onBottomSentinelChange,
  scrollController,
  renderChatTimelineItem,
  timelineRenderVersion,
  editingAssistantMessageId,
  onForceScrollToBottom,
  hasStreamingMessages,
  scrollToBottomLabel,
  scrollToBottomWhileStreamingLabel,
  emptyStateAskTitle,
  emptyStateAgentTitle,
  emptyStateAgentFullTitle,
  emptyStateMaxCopy,
  emptyStateWorkspaceTitle,
  emptyStateAskDescription,
  emptyStateAgentDescription,
  emptyStateAgentFullDescription,
  emptyStateIcon,
  emptyStateIconMode,
  emptyStateOverride,
  footerContent,
  onTimelineVirtualizationChange,
  onUserMessageViewportChange,
  windowNavigationKey,
  windowNavigationTargetMessageId,
  messageNavigatorContent,
  hasEarlierMessages,
  hasNewerMessages,
  onLoadEarlier,
  onLoadNewer,
  onGrowWindowToFillViewport,
  historyWindowKey,
  bottomSpacerHeight,
}: ChatConversationPaneProps) {
  const reduceMotion = useReducedMotion()
  // 有内容的对话、自带布局的空白页（项目主页）、普通空白页：输入框的静止位置
  // 各不相同。新对话的项目归属可能晚一次提交才判定，所以单看对话 id 不够
  const surfaceState = !showEmptyState
    ? 'content'
    : emptyStateOverride && 'content' in emptyStateOverride
      ? 'custom-empty'
      : 'empty'
  const showScrollToBottomButton =
    !showEmptyState &&
    groupedChatMessagesLength > 0 &&
    (!isAutoFollowEnabled || hasNewerMessages)

  const isMaxMode = chatMode === 'max'
  const isYoloAgent = isToolChatMode(chatMode) && yoloEnabled
  const maxCopy = isMaxMode ? emptyStateMaxCopy : undefined
  const customEmptyState =
    emptyStateOverride && 'content' in emptyStateOverride
      ? emptyStateOverride.content
      : null
  const textOverride =
    emptyStateOverride && !('content' in emptyStateOverride)
      ? emptyStateOverride
      : undefined
  const emptyStateTitle =
    textOverride?.title ??
    emptyStateWorkspaceTitle ??
    (maxCopy
      ? yoloEnabled
        ? maxCopy.fullTitle
        : maxCopy.title
      : isYoloAgent
        ? emptyStateAgentFullTitle
        : isToolChatMode(chatMode)
          ? emptyStateAgentTitle
          : emptyStateAskTitle)
  const emptyStateDescription =
    textOverride?.description ??
    (maxCopy
      ? yoloEnabled
        ? maxCopy.fullDescription
        : maxCopy.description
      : isYoloAgent
        ? emptyStateAgentFullDescription
        : isToolChatMode(chatMode)
          ? emptyStateAgentDescription
          : emptyStateAskDescription)
  const resolvedEmptyStateIconMode =
    emptyStateIconMode ??
    (isMaxMode
      ? yoloEnabled
        ? 'max-full'
        : 'max'
      : isYoloAgent
        ? 'agent-full'
        : chatMode)
  // The icon states the mode, not the trust profile: Max keeps the selector's
  // bolt in both of its states.
  const resolvedEmptyStateIcon =
    textOverride?.icon ??
    emptyStateIcon ??
    (isMaxMode ? (
      <Zap size={18} strokeWidth={2} />
    ) : isYoloAgent ? (
      <InfinityIcon size={18} strokeWidth={2} />
    ) : isToolChatMode(chatMode) ? (
      <Bot size={18} strokeWidth={2} />
    ) : (
      <MessageCircle size={18} strokeWidth={2} />
    ))

  return (
    <>
      <InstallationIncompleteBanner />
      <SharedConversationSurface
        key={currentConversationId}
        items={chatTimelineItems}
        conversationId={currentConversationId}
        scrollContainerRef={chatMessagesRef}
        onScrollContainerChange={onScrollContainerChange}
        onBottomSentinelChange={onBottomSentinelChange}
        scrollController={scrollController}
        renderItem={renderChatTimelineItem}
        renderVersion={timelineRenderVersion}
        forceRenderItemIds={['bottom-anchor']}
        virtualizationThreshold={
          editingAssistantMessageId ? chatTimelineItems.length : undefined
        }
        containerClassName="yolo-chat-conversation-surface"
        overlaySlot={
          <>
            <AnimatePresence initial={false}>
              {showEmptyState ? (
                <motion.div
                  key="empty-state"
                  className="yolo-chat-empty-state-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: reduceMotion ? 0 : MOTION_DURATION_EXIT_S,
                    ease: MOTION_EASE_OUT,
                  }}
                >
                  <div className="yolo-chat-empty-state-overlay-inner">
                    {customEmptyState ? (
                      <div className="yolo-chat-empty-state yolo-chat-empty-state--custom">
                        {customEmptyState}
                      </div>
                    ) : (
                      <div className="yolo-chat-empty-state">
                        <div
                          key={resolvedEmptyStateIconMode}
                          className="yolo-chat-empty-state-icon"
                          data-mode={resolvedEmptyStateIconMode}
                        >
                          {resolvedEmptyStateIcon}
                        </div>
                        <div className="yolo-chat-empty-state-title">
                          {emptyStateTitle}
                        </div>
                        <div className="yolo-chat-empty-state-description">
                          {emptyStateDescription}
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
            {messageNavigatorContent}
          </>
        }
        scrollContainerClassName="yolo-chat-messages"
        onVirtualizationChange={onTimelineVirtualizationChange}
        onUserMessageViewportChange={onUserMessageViewportChange}
        windowNavigationKey={windowNavigationKey}
        windowNavigationTargetMessageId={windowNavigationTargetMessageId}
        hasEarlierMessages={hasEarlierMessages}
        hasNewerMessages={hasNewerMessages}
        onLoadEarlier={onLoadEarlier}
        onLoadNewer={onLoadNewer}
        onGrowWindowToFillViewport={onGrowWindowToFillViewport}
        historyWindowKey={historyWindowKey}
        bottomSpacerHeight={bottomSpacerHeight}
      />
      <ComposerDock
        flipKey={`${currentConversationId}:${surfaceState}`}
        reduceMotion={reduceMotion ?? false}
      >
        <div className="yolo-chat-floating-actions">
          <AnimatePresence initial={false}>
            {showScrollToBottomButton ? (
              <motion.div
                key="scroll-to-bottom"
                className="yolo-chat-scroll-to-bottom-anchor"
                initial={{ opacity: 0, scale: 0.9, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.9,
                  y: 6,
                  transition: {
                    duration: reduceMotion ? 0 : MOTION_DURATION_EXIT_S,
                    ease: MOTION_EASE_IN,
                  },
                }}
                transition={{
                  duration: reduceMotion ? 0 : MOTION_DURATION_ENTER_S,
                  ease: MOTION_EASE_OUT,
                }}
              >
                <button
                  type="button"
                  className="yolo-chat-scroll-to-bottom-button"
                  onClick={onForceScrollToBottom}
                  aria-label={
                    hasStreamingMessages
                      ? scrollToBottomWhileStreamingLabel
                      : scrollToBottomLabel
                  }
                >
                  <ArrowDown size={14} strokeWidth={2.25} />
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        {footerContent}
      </ComposerDock>
    </>
  )
}
