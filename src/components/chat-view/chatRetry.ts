import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'

type AssistantOrToolMessage = ChatAssistantMessage | ChatToolMessage

const isAssistantOrToolMessage = (
  message: ChatMessage,
): message is AssistantOrToolMessage => {
  return message.role === 'assistant' || message.role === 'tool'
}

export const getSourceUserMessageIdForGroup = (
  messages: AssistantToolMessageGroup,
): string | null => {
  for (const message of messages) {
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
    if (latestMessage?.metadata?.branchWaitingApproval) {
      return false
    }

    if (latestMessage?.metadata?.branchRunStatus) {
      return latestMessage.metadata.branchRunStatus === 'completed'
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
            if (candidate.metadata?.sourceUserMessageId !== sourceUserMessageId) {
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
