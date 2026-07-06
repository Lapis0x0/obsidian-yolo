import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatMessage,
} from '../../types/chat'

type PlaceholderKind = 'tool' | 'reasoning'

type PlaceholderAnchor = {
  kind: PlaceholderKind
  id: string
  sliceBoundary: number
  orderIndex: number
}

type ValidPlaceholder = PlaceholderAnchor & {
  start: number
  end: number
}

const PLACEHOLDER_TOKEN_REGEX = /⟨(🔧|💭)\s+([^|]+?)\s*\|\s*([^⟩]+?)\s*⟩/g
const REASONING_LITERAL = 'reasoning'

type SerializerPart =
  | { kind: 'placeholder'; text: string }
  | { kind: 'content'; text: string }

export function serializeGroupForEdit(
  messages: AssistantToolMessageGroup,
): string {
  const parts: SerializerPart[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      if ((message.reasoning?.trim().length ?? 0) > 0) {
        parts.push({
          kind: 'placeholder',
          text: `⟨💭 reasoning | ${message.id}⟩`,
        })
      }
      parts.push({ kind: 'content', text: message.content })
      continue
    }
    if (message.role === 'tool') {
      for (const toolCall of message.toolCalls) {
        parts.push({
          kind: 'placeholder',
          text: `⟨🔧 ${toolCall.request.name} | ${toolCall.request.id}⟩`,
        })
      }
    }
  }

  const segments: string[] = []
  let hasPrevious = false
  for (const part of parts) {
    if (part.kind === 'content' && part.text === '') {
      continue
    }
    if (hasPrevious) {
      segments.push('\n\n')
    }
    segments.push(part.text)
    hasPrevious = true
  }
  return segments.join('')
}

export function parseGroupFromEdit(
  text: string,
  originalMessages: AssistantToolMessageGroup,
): { retainedMessages: ChatMessage[]; removedMessageIds: string[] } {
  const anchors = collectAnchors(originalMessages)
  const anchorsByKey = new Map(
    anchors.map((anchor) => [anchorKey(anchor), anchor]),
  )
  const validPlaceholders = collectValidPlaceholders(text, anchorsByKey)

  const retainedToolCallIds = new Set<string>()
  const retainedReasoningIds = new Set<string>()
  for (const placeholder of validPlaceholders) {
    if (placeholder.kind === 'tool') {
      retainedToolCallIds.add(placeholder.id)
    } else {
      retainedReasoningIds.add(placeholder.id)
    }
  }

  const removedToolCallIds = new Set<string>()
  for (const anchor of anchors) {
    if (anchor.kind === 'tool' && !retainedToolCallIds.has(anchor.id)) {
      removedToolCallIds.add(anchor.id)
    }
  }

  const slices = sliceTextByPlaceholders(text, validPlaceholders)
  const contentByAssistantIndex = assignSlicesToAssistantSlots({
    slices,
    placeholders: validPlaceholders,
    messages: originalMessages,
  })

  const retainedMessages: ChatMessage[] = []
  const removedMessageIds: string[] = []

  originalMessages.forEach((message, messageIndex) => {
    if (message.role === 'assistant') {
      const hadReasoning = (message.reasoning?.trim().length ?? 0) > 0
      const shouldDropReasoning =
        hadReasoning && !retainedReasoningIds.has(message.id)
      const nextMessage: ChatAssistantMessage = {
        ...message,
        content: contentByAssistantIndex.get(messageIndex) ?? '',
        reasoning: shouldDropReasoning ? undefined : message.reasoning,
        toolCallRequests: message.toolCallRequests?.filter(
          (request) => !removedToolCallIds.has(request.id),
        ),
      }
      if (isEmptyAssistantShell(nextMessage)) {
        removedMessageIds.push(message.id)
        return
      }
      retainedMessages.push(nextMessage)
      return
    }

    if (message.role === 'tool') {
      const nextToolCalls = message.toolCalls.filter(
        (toolCall) => !removedToolCallIds.has(toolCall.request.id),
      )
      if (nextToolCalls.length === 0) {
        removedMessageIds.push(message.id)
        return
      }
      retainedMessages.push({
        ...message,
        toolCalls: nextToolCalls,
      })
      return
    }

    retainedMessages.push(message)
  })

  return { retainedMessages, removedMessageIds }
}

function anchorKey(anchor: { kind: PlaceholderKind; id: string }): string {
  return `${anchor.kind}:${anchor.id}`
}

function collectAnchors(
  messages: AssistantToolMessageGroup,
): PlaceholderAnchor[] {
  const anchors: PlaceholderAnchor[] = []
  const seenKeys = new Set<string>()

  messages.forEach((message, messageIndex) => {
    if (message.role === 'assistant') {
      if ((message.reasoning?.trim().length ?? 0) === 0) {
        return
      }
      const key = `reasoning:${message.id}`
      if (seenKeys.has(key)) {
        return
      }
      seenKeys.add(key)
      anchors.push({
        kind: 'reasoning',
        id: message.id,
        sliceBoundary: messageIndex - 0.5,
        orderIndex: anchors.length,
      })
      return
    }
    if (message.role !== 'tool') {
      return
    }
    message.toolCalls.forEach((toolCall) => {
      const id = toolCall.request.id
      const key = `tool:${id}`
      if (seenKeys.has(key)) {
        return
      }
      seenKeys.add(key)
      anchors.push({
        kind: 'tool',
        id,
        sliceBoundary: messageIndex + 0.5,
        orderIndex: anchors.length,
      })
    })
  })

  return anchors
}

function collectValidPlaceholders(
  text: string,
  anchorsByKey: ReadonlyMap<string, PlaceholderAnchor>,
): ValidPlaceholder[] {
  const placeholders: ValidPlaceholder[] = []
  const seenKeys = new Set<string>()
  let lastOrderIndex = -1

  for (const match of text.matchAll(PLACEHOLDER_TOKEN_REGEX)) {
    const emoji = match[1]
    const kind: PlaceholderKind = emoji === '💭' ? 'reasoning' : 'tool'
    if (kind === 'reasoning' && match[2].trim() !== REASONING_LITERAL) {
      continue
    }
    const id = match[3]
    const key = `${kind}:${id}`
    const anchor = anchorsByKey.get(key)
    if (!anchor || seenKeys.has(key) || anchor.orderIndex <= lastOrderIndex) {
      continue
    }
    const tokenStart = match.index
    const tokenEnd = tokenStart + match[0].length
    const start = consumeLeadingNewlines(text, tokenStart)
    const end = consumeTrailingNewlines(text, tokenEnd)

    seenKeys.add(key)
    lastOrderIndex = anchor.orderIndex
    placeholders.push({
      ...anchor,
      start,
      end,
    })
  }

  return placeholders
}

function consumeLeadingNewlines(text: string, tokenStart: number): number {
  let cursor = tokenStart
  for (let i = 0; i < 2; i += 1) {
    if (cursor > 0 && text[cursor - 1] === '\n') {
      cursor -= 1
    } else {
      break
    }
  }
  return cursor
}

function consumeTrailingNewlines(text: string, tokenEnd: number): number {
  let cursor = tokenEnd
  for (let i = 0; i < 2; i += 1) {
    if (cursor < text.length && text[cursor] === '\n') {
      cursor += 1
    } else {
      break
    }
  }
  return cursor
}

function sliceTextByPlaceholders(
  text: string,
  placeholders: readonly ValidPlaceholder[],
): string[] {
  if (placeholders.length === 0) {
    return [text]
  }

  const slices: string[] = []
  let cursor = 0
  placeholders.forEach((placeholder) => {
    slices.push(text.slice(cursor, placeholder.start))
    cursor = placeholder.end
  })
  slices.push(text.slice(cursor))
  return slices
}

function assignSlicesToAssistantSlots({
  slices,
  placeholders,
  messages,
}: {
  slices: readonly string[]
  placeholders: readonly ValidPlaceholder[]
  messages: AssistantToolMessageGroup
}): Map<number, string> {
  const assistantIndexes = messages
    .map((message, index) => (message.role === 'assistant' ? index : null))
    .filter((index): index is number => index !== null)
  const contentByAssistantIndex = new Map<number, string>()

  slices.forEach((slice, sliceIndex) => {
    const previousBoundary =
      placeholders[sliceIndex - 1]?.sliceBoundary ?? -Infinity
    const nextBoundary = placeholders[sliceIndex]?.sliceBoundary ?? Infinity
    const carrierIndex = findSliceCarrierAssistantIndex({
      assistantIndexes,
      previousBoundary,
      nextBoundary,
    })
    if (carrierIndex === null) {
      return
    }
    contentByAssistantIndex.set(
      carrierIndex,
      `${contentByAssistantIndex.get(carrierIndex) ?? ''}${slice}`,
    )
  })

  return contentByAssistantIndex
}

function findSliceCarrierAssistantIndex({
  assistantIndexes,
  previousBoundary,
  nextBoundary,
}: {
  assistantIndexes: readonly number[]
  previousBoundary: number
  nextBoundary: number
}): number | null {
  const inRange = assistantIndexes.filter(
    (index) => index > previousBoundary && index < nextBoundary,
  )
  if (inRange.length > 0) {
    return inRange[inRange.length - 1]
  }

  const afterNextBoundary = assistantIndexes.find(
    (index) => index > nextBoundary,
  )
  if (afterNextBoundary !== undefined) {
    return afterNextBoundary
  }

  for (let i = assistantIndexes.length - 1; i >= 0; i -= 1) {
    const assistantIndex = assistantIndexes[i]
    if (assistantIndex < previousBoundary) {
      return assistantIndex
    }
  }

  return null
}

function isEmptyAssistantShell(message: ChatAssistantMessage): boolean {
  return (
    message.content.length === 0 &&
    (message.toolCallRequests?.length ?? 0) === 0 &&
    !message.reasoning &&
    (message.annotations?.length ?? 0) === 0
  )
}
