import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import type {
  AssistantToolMessageGroup,
  ChatUserMessage,
} from '../../types/chat'
import { parseTagContents } from '../../utils/chat/parse-tag-content'

const MESSAGE_NAVIGATOR_PREVIEW_SOURCE_MAX_LENGTH = 360

export const getPromptContentText = (
  promptContent: ChatUserMessage['promptContent'],
): string => {
  if (!promptContent) {
    return ''
  }
  if (typeof promptContent === 'string') {
    return promptContent
  }
  return promptContent
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ')
}

export const normalizeNavigatorPreview = (
  text: string,
  maxLength: number,
  fallback = '',
): string => {
  const normalized = text
    .replace(/```(?:[A-Za-z0-9_-]+)?/g, ' ')
    .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)](?:\([^)]*\)|\[[^\]]*])/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/<([^>\n]+)>/g, '$1')
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/g, '$1')
    .replace(/[`*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) {
    return fallback
  }
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

export const getNavigatorAssistantText = (
  messages: AssistantToolMessageGroup,
): string => {
  const parts: string[] = []
  let remainingLength = MESSAGE_NAVIGATOR_PREVIEW_SOURCE_MAX_LENGTH

  for (const message of messages) {
    if (remainingLength <= 0) {
      break
    }
    if (message.role !== 'assistant') {
      continue
    }

    const contentParts = /<(?:think|yolo_block)\b/i.test(message.content)
      ? parseTagContents(message.content)
          .filter((block) => block.type !== 'think')
          .map((block) => block.content)
      : [message.content]

    for (const contentPart of contentParts) {
      if (remainingLength <= 0) {
        break
      }
      const previewPart = contentPart.slice(0, remainingLength)
      parts.push(previewPart)
      remainingLength -= previewPart.length
    }
  }

  return parts.join(' ')
}

export const isDelegateSubagentToolName = (name: string): boolean => {
  try {
    const parsed = parseToolName(name)
    return (
      parsed.serverName === getLocalFileToolServerName() &&
      parsed.toolName === 'delegate_subagent'
    )
  } catch {
    return name === 'delegate_subagent'
  }
}
