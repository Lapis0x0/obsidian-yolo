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
    foregroundGroup: group.slice(index),
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
