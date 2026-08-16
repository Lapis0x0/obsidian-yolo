import type {
  AssistantToolMessageGroup,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'

export type ForegroundAgentFooter = {
  suppress: boolean
  inlineInfoMessages: AssistantToolMessageGroup
}

export type ForegroundAgentVisualTurnPlan = {
  footerByMessageId: Map<string, ForegroundAgentFooter>
}

const isBackgroundResultBridgeMessage = (
  message: ChatMessage,
): message is Extract<
  ChatMessage,
  | { role: 'external_agent_result' }
  | { role: 'subagent_result' }
  | { role: 'terminal_command_result' }
> =>
  message.role === 'external_agent_result' ||
  message.role === 'subagent_result' ||
  message.role === 'terminal_command_result'

const splitLeadingBackgroundBridge = (
  group: AssistantToolMessageGroup,
): {
  hasBridge: boolean
  foregroundGroup: AssistantToolMessageGroup
} => {
  let index = 0
  while (
    index < group.length &&
    isBackgroundResultBridgeMessage(group[index])
  ) {
    index += 1
  }

  return {
    hasBridge: index > 0,
    // 没有 bridge 时直接沿用入参数组：read model 对未变化的 group 做了结构
    // 共享，切片会白白丢掉这份引用稳定性。
    foregroundGroup: index === 0 ? group : group.slice(index),
  }
}

const registerFooterForGroup = (
  footerByMessageId: Map<string, ForegroundAgentFooter>,
  group: AssistantToolMessageGroup,
  footer: ForegroundAgentFooter,
) => {
  for (const message of group) {
    footerByMessageId.set(message.id, footer)
  }
}

type PendingVisualTurn = {
  groups: AssistantToolMessageGroup[]
  hasBridge: boolean
}

export function buildForegroundAgentVisualTurnPlan(
  groupedMessages: readonly (ChatUserMessage | AssistantToolMessageGroup)[],
): ForegroundAgentVisualTurnPlan {
  const footerByMessageId = new Map<string, ForegroundAgentFooter>()
  let pendingTurn: PendingVisualTurn | null = null

  for (const item of groupedMessages) {
    if (!Array.isArray(item)) {
      pendingTurn = null
      continue
    }

    if (item.length === 0) {
      continue
    }

    const { hasBridge, foregroundGroup } = splitLeadingBackgroundBridge(item)
    if (hasBridge && pendingTurn) {
      pendingTurn.hasBridge = true
    }

    if (foregroundGroup.length === 0) {
      if (pendingTurn) {
        pendingTurn.hasBridge = true
      }
      continue
    }

    registerFooterForGroup(footerByMessageId, foregroundGroup, {
      suppress: false,
      inlineInfoMessages: foregroundGroup,
    })

    if (pendingTurn?.hasBridge) {
      for (const previousGroup of pendingTurn.groups) {
        registerFooterForGroup(footerByMessageId, previousGroup, {
          suppress: true,
          inlineInfoMessages: previousGroup,
        })
      }

      const groups: AssistantToolMessageGroup[] = [
        ...pendingTurn.groups,
        foregroundGroup,
      ]
      const inlineInfoMessages = groups.flat()
      registerFooterForGroup(footerByMessageId, foregroundGroup, {
        suppress: false,
        inlineInfoMessages,
      })
      pendingTurn = {
        groups,
        hasBridge: false,
      }
      continue
    }

    pendingTurn = {
      groups: [foregroundGroup],
      hasBridge: false,
    }
  }

  return { footerByMessageId }
}

const sameMessages = (
  a: AssistantToolMessageGroup,
  b: AssistantToolMessageGroup,
): boolean =>
  a.length === b.length && a.every((message, index) => message === b[index])

/**
 * 复用上一份 plan 中内容未变的 footer。时间线行的 render version 用
 * `inlineInfoMessages` 的对象身份判断是否需要重渲，footer 每帧换新数组会让
 * 全部 assistant 行在流式期间持续重渲直到 commit 阶段的 DOM diff。
 *
 * `next` 必须是刚构建、尚未被其他地方持有的 plan。
 */
export function reuseForegroundAgentVisualTurnPlan(
  previous: ForegroundAgentVisualTurnPlan,
  next: ForegroundAgentVisualTurnPlan,
): ForegroundAgentVisualTurnPlan {
  for (const [messageId, footer] of next.footerByMessageId) {
    const previousFooter = previous.footerByMessageId.get(messageId)
    if (
      previousFooter &&
      previousFooter.suppress === footer.suppress &&
      sameMessages(previousFooter.inlineInfoMessages, footer.inlineInfoMessages)
    ) {
      next.footerByMessageId.set(messageId, previousFooter)
    }
  }
  return next
}

export function getForegroundAgentFooterForGroup(
  plan: ForegroundAgentVisualTurnPlan,
  group: AssistantToolMessageGroup,
): ForegroundAgentFooter | undefined {
  for (const message of group) {
    const footer = plan.footerByMessageId.get(message.id)
    if (footer) {
      return footer
    }
  }
  return undefined
}
