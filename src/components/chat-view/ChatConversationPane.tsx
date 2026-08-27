import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ArrowDown,
  Bot,
  Infinity as InfinityIcon,
  MessageCircle,
} from 'lucide-react'
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'

import {
  MOTION_DURATION_ENTER_S,
  MOTION_DURATION_EXIT_S,
  MOTION_EASE_IN,
  MOTION_EASE_OUT,
} from '../../styles/tokens/motion'
import type { ChatTimelineItem } from '../../types/chat-timeline'

import type { ChatMode } from './chat-input/ChatModeSelect'
import { isAgentChatMode } from './chat-input/ChatModeSelect'
import type {
  ChatTimelineRenderVersion,
  UserMessageViewportState,
} from './ChatTimelineList'
import { InstallationIncompleteBanner } from './InstallationIncompleteBanner'
import type { ScrollController } from './scroll/scrollController'
import { SharedConversationSurface } from './SharedConversationSurface'

const DOCK_FLIP_EPSILON_PX = 1
const FOOTER_DOCK_FLIPPING_CLASS = 'yolo-chat-footer--dock-flipping'

/**
 * One-shot FLIP for the empty-state rest-position change. The two rest
 * states stay CSS flex; this only inverts/plays `translateY` on the footer
 * so the composer does not pay framer-motion layout projection on the
 * first-message frame.
 */
function useEmptyStateDockFlip(
  showEmptyState: boolean,
  reduceMotion: boolean | null,
): RefObject<HTMLDivElement> {
  const footerRef = useRef<HTMLDivElement>(null)
  const prevShowEmptyStateRef = useRef(showEmptyState)
  const prevTopRef = useRef<number | null>(null)
  const pendingPlayRef = useRef(false)

  useLayoutEffect(() => {
    const el = footerRef.current
    if (!el) {
      return
    }

    const depChanged = prevShowEmptyStateRef.current !== showEmptyState
    prevShowEmptyStateRef.current = showEmptyState
    pendingPlayRef.current = false

    if (depChanged) {
      // Drop an in-flight invert so Last is the new flex rest position.
      el.style.transition = 'none'
      el.style.transform = ''
      el.classList.remove(FOOTER_DOCK_FLIPPING_CLASS)
    }

    const lastTop = el.getBoundingClientRect().top
    const firstTop = prevTopRef.current
    prevTopRef.current = lastTop

    if (depChanged && firstTop != null && !reduceMotion) {
      const delta = firstTop - lastTop
      if (Math.abs(delta) >= DOCK_FLIP_EPSILON_PX) {
        el.style.transform = `translateY(${delta}px)`
        pendingPlayRef.current = true
      }
    }

    if (!pendingPlayRef.current) {
      return
    }
    return () => {
      pendingPlayRef.current = false
      el.style.transition = 'none'
      el.style.transform = ''
      el.classList.remove(FOOTER_DOCK_FLIPPING_CLASS)
      // Do not restore prevTopRef: it already holds Last, which is First for
      // the reverse empty↔docked flip. React 18 StrictMode only replays mount.
    }
  }, [showEmptyState, reduceMotion])

  useEffect(() => {
    if (!pendingPlayRef.current) {
      return
    }
    pendingPlayRef.current = false
    const el = footerRef.current
    if (!el) {
      return
    }

    el.classList.add(FOOTER_DOCK_FLIPPING_CLASS)
    el.style.transition = ''
    el.style.transform = ''

    const onEnd = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== 'transform') {
        return
      }
      el.classList.remove(FOOTER_DOCK_FLIPPING_CLASS)
    }
    el.addEventListener('transitionend', onEnd)
    return () => {
      el.removeEventListener('transitionend', onEnd)
      el.classList.remove(FOOTER_DOCK_FLIPPING_CLASS)
    }
  }, [showEmptyState])

  return footerRef
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
  emptyStateWorkspaceTitle?: ReactNode
  emptyStateAskDescription: string
  emptyStateAgentDescription: string
  emptyStateAgentFullDescription: string
  emptyStateIcon?: ReactNode
  emptyStateIconMode?: string
  /**
   * Full override for a module chat mode's empty state — the registry's
   * resolved label/description (and optionally icon) instead of the
   * ask/agent copy. Takes priority over every other `emptyState*` prop when
   * present (module modes are a complete, decoupled product surface — see
   * Phase D design doc 4.7).
   */
  emptyStateModuleContent?: {
    title: ReactNode
    description: ReactNode
    icon?: ReactNode
  }
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
  emptyStateWorkspaceTitle,
  emptyStateAskDescription,
  emptyStateAgentDescription,
  emptyStateAgentFullDescription,
  emptyStateIcon,
  emptyStateIconMode,
  emptyStateModuleContent,
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
  const footerRef = useEmptyStateDockFlip(showEmptyState, reduceMotion)
  const showScrollToBottomButton =
    !showEmptyState &&
    groupedChatMessagesLength > 0 &&
    (!isAutoFollowEnabled || hasNewerMessages)

  const isYoloAgent = isAgentChatMode(chatMode) && yoloEnabled
  const emptyStateTitle =
    emptyStateModuleContent?.title ??
    emptyStateWorkspaceTitle ??
    (isYoloAgent
      ? emptyStateAgentFullTitle
      : isAgentChatMode(chatMode)
        ? emptyStateAgentTitle
        : emptyStateAskTitle)
  const emptyStateDescription =
    emptyStateModuleContent?.description ??
    (isYoloAgent
      ? emptyStateAgentFullDescription
      : isAgentChatMode(chatMode)
        ? emptyStateAgentDescription
        : emptyStateAskDescription)
  const resolvedEmptyStateIconMode =
    emptyStateIconMode ?? (isYoloAgent ? 'agent-full' : chatMode)
  const resolvedEmptyStateIcon =
    emptyStateModuleContent?.icon ??
    emptyStateIcon ??
    (isYoloAgent ? (
      <InfinityIcon size={18} strokeWidth={2} />
    ) : isAgentChatMode(chatMode) ? (
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
      {/* Rest states stay CSS flex. Empty↔docked is a one-shot translateY
       * FLIP on this node — not framer-motion layout projection. */}
      <div ref={footerRef} className="yolo-chat-footer">
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
      </div>
    </>
  )
}
