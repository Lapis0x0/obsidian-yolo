import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'

type AssistantOrToolMessage = ChatAssistantMessage | ChatToolMessage

export type AssistantErrorContinuationTarget = {
  assistantMessageId: string
  sourceUserMessageId: string
  modelId: string
  branchId?: string
  branchLabel?: string
  inputChatMessages: ChatMessage[]
  requestChatMessages: ChatMessage[]
}

const isAssistantOrToolMessage = (
  message: ChatMessage,
): message is AssistantOrToolMessage => {
  return message.role === 'assistant' || message.role === 'tool'
}

export const getSourceUserMessageIdForGroup = (
  messages: AssistantToolMessageGroup,
): string | null => {
  for (const message of messages) {
    if (
      message.role === 'external_agent_result' ||
      message.role === 'subagent_result' ||
      message.role === 'terminal_command_result'
    ) {
      continue
    }
    const sourceUserMessageId = message.metadata?.sourceUserMessageId
    if (sourceUserMessageId) {
      return sourceUserMessageId
    }
  }

  return null
}

export const getDisplayedAssistantToolMessages = (
  messages: AssistantToolMessageGroup,
  activeBranchKey?: string | null,
): AssistantToolMessageGroup => {
  const isBranchCompleted = (branchMessages: AssistantToolMessageGroup) => {
    const latestMessage = branchMessages.at(-1)
    const latestMetadata =
      latestMessage?.role !== 'external_agent_result' &&
      latestMessage?.role !== 'subagent_result' &&
      latestMessage?.role !== 'terminal_command_result'
        ? latestMessage?.metadata
        : undefined
    if (latestMetadata?.branchWaitingApproval) {
      return false
    }

    if (latestMetadata?.branchRunStatus) {
      return latestMetadata.branchRunStatus === 'completed'
    }

    return branchMessages.some(
      (message) =>
        message.role === 'assistant' &&
        message.metadata?.generationState === 'completed',
    )
  }

  const branchGroups = new Map<string, AssistantToolMessageGroup>()
  messages.forEach((message) => {
    const branchId = message.metadata?.branchId
    if (!branchId) {
      return
    }

    const existing = branchGroups.get(branchId)
    if (existing) {
      existing.push(message)
      return
    }

    branchGroups.set(branchId, [message])
  })

  const groupedBranches = Array.from(branchGroups.values())
  if (groupedBranches.length <= 1) {
    return messages
  }

  const resolvedActiveBranchKey =
    activeBranchKey ??
    groupedBranches.find((branchMessages) =>
      isBranchCompleted(branchMessages),
    )?.[0]?.metadata?.branchId ??
    groupedBranches[0]?.[0]?.metadata?.branchId ??
    null

  return (
    groupedBranches.find(
      (branchMessages) =>
        branchMessages[0]?.metadata?.branchId === resolvedActiveBranchKey,
    ) ??
    groupedBranches[0] ??
    messages
  )
}

export const buildAssistantErrorContinuation = ({
  sourceMessages,
  groupedChatMessages,
  assistantMessageId,
  activeBranchByUserMessageId,
}: {
  sourceMessages: ChatMessage[]
  groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[]
  assistantMessageId: string
  activeBranchByUserMessageId: ReadonlyMap<string, string>
}): AssistantErrorContinuationTarget | null => {
  const target = sourceMessages.find(
    (message): message is ChatAssistantMessage =>
      message.role === 'assistant' && message.id === assistantMessageId,
  )
  const modelId = target?.metadata?.model?.id ?? target?.metadata?.branchModelId

  if (
    !target ||
    target.metadata?.generationState !== 'error' ||
    target.content.trim().length === 0 ||
    !modelId
  ) {
    return null
  }

  let lastUserMessageId: string | undefined
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    if (sourceMessages[index].role === 'user') {
      lastUserMessageId = sourceMessages[index].id
      break
    }
  }
  const sourceUserMessageId =
    target.metadata?.sourceUserMessageId ??
    (target.metadata?.branchId ? undefined : lastUserMessageId)
  if (!sourceUserMessageId || lastUserMessageId !== sourceUserMessageId) {
    return null
  }

  const requestChatMessages = groupedChatMessages.flatMap(
    (messageOrGroup): ChatMessage[] => {
      if (!Array.isArray(messageOrGroup)) {
        return [messageOrGroup]
      }
      const groupSourceUserMessageId =
        getSourceUserMessageIdForGroup(messageOrGroup) ?? ''
      return getDisplayedAssistantToolMessages(
        messageOrGroup,
        activeBranchByUserMessageId.get(groupSourceUserMessageId),
      )
    },
  )

  if (requestChatMessages.at(-1)?.id !== target.id) {
    return null
  }

  return {
    assistantMessageId: target.id,
    sourceUserMessageId,
    modelId,
    branchId: target.metadata?.branchId,
    branchLabel: target.metadata?.branchLabel,
    inputChatMessages: sourceMessages,
    requestChatMessages,
  }
}

export const buildRetrySubmissionMessages = ({
  sourceMessages,
  groupedChatMessages,
  targetMessageIds,
  activeBranchByUserMessageId,
}: {
  sourceMessages: ChatMessage[]
  groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[]
  targetMessageIds: readonly string[]
  activeBranchByUserMessageId: ReadonlyMap<string, string>
}): {
  sourceUserMessageId: string
  inputChatMessages: ChatMessage[]
  requestChatMessages: ChatMessage[]
  branchTarget?: {
    branchId: string
    branchModelId?: string
    branchLabel?: string
  }
} | null => {
  if (targetMessageIds.length === 0) {
    return null
  }

  const targetIds = new Set(targetMessageIds)
  const targetGroupIndex = groupedChatMessages.findIndex(
    (candidate) =>
      Array.isArray(candidate) &&
      candidate.some((message) => targetIds.has(message.id)),
  )
  if (targetGroupIndex < 0) {
    return null
  }

  let targetMessage: AssistantOrToolMessage | null = null
  for (const message of sourceMessages) {
    if (!targetIds.has(message.id)) {
      continue
    }

    if (!isAssistantOrToolMessage(message)) {
      continue
    }

    targetMessage = message
    if (targetMessage.metadata?.sourceUserMessageId) {
      break
    }
  }

  let sourceUserMessageId = targetMessage?.metadata?.sourceUserMessageId ?? null

  if (!sourceUserMessageId) {
    for (let index = targetGroupIndex - 1; index >= 0; index -= 1) {
      const candidate = groupedChatMessages[index]
      if (Array.isArray(candidate)) {
        continue
      }
      sourceUserMessageId = candidate.id
      break
    }
  }

  if (!sourceUserMessageId) {
    return null
  }

  const targetBranchId = targetMessage?.metadata?.branchId?.trim() || null
  const branchTarget = targetBranchId
    ? {
        branchId: targetBranchId,
        branchModelId: targetMessage?.metadata?.branchModelId,
        branchLabel: targetMessage?.metadata?.branchLabel,
      }
    : undefined

  const sourceUserMessageIndex = sourceMessages.findIndex(
    (message) => message.role === 'user' && message.id === sourceUserMessageId,
  )
  if (sourceUserMessageIndex < 0) {
    return null
  }

  const groupedMessageIndex = groupedChatMessages.findIndex(
    (candidate) =>
      !Array.isArray(candidate) && candidate.id === sourceUserMessageId,
  )
  if (groupedMessageIndex < 0) {
    return null
  }

  return {
    sourceUserMessageId,
    inputChatMessages: branchTarget
      ? (() => {
          let branchGroupEndIndex = sourceUserMessageIndex + 1
          while (branchGroupEndIndex < sourceMessages.length) {
            const candidate = sourceMessages[branchGroupEndIndex]
            if (!isAssistantOrToolMessage(candidate)) {
              break
            }
            if (
              candidate.metadata?.sourceUserMessageId !== sourceUserMessageId
            ) {
              break
            }
            branchGroupEndIndex += 1
          }

          return sourceMessages.slice(0, branchGroupEndIndex)
        })()
      : sourceMessages.slice(0, sourceUserMessageIndex + 1),
    requestChatMessages: groupedChatMessages
      .slice(0, groupedMessageIndex + 1)
      .flatMap((candidate): ChatMessage[] =>
        !Array.isArray(candidate)
          ? [candidate]
          : getDisplayedAssistantToolMessages(
              candidate,
              activeBranchByUserMessageId.get(
                getSourceUserMessageIdForGroup(candidate) ?? '',
              ),
            ),
      ),
    branchTarget,
  }
}
