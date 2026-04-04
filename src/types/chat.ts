import { SerializedEditorState } from 'lexical'

import { SelectEmbedding } from '../database/schema'

import { ChatModel } from './chat-model.types'
import { ContentPart } from './llm/request'
import { Annotation, ProviderMetadata, ResponseUsage } from './llm/response'
import { Mentionable, SerializedMentionable } from './mentionable'
import { ToolCallRequest, ToolCallResponse } from './tool-call.types'

export type PromptSnapshotRef = {
  hash: string
}

export type ChatSelectedSkill = {
  id: string
  name: string
  description: string
  path: string
}

export type ChatConversationCompaction = {
  anchorMessageId: string
  summary: string
  compactedAt: number
  triggerToolCallId?: string
  summaryModelId?: string
  estimatedNextContextTokens?: number
}

export type ChatConversationCompactionState = ChatConversationCompaction[]

export type ChatConversationCompactionLike =
  | ChatConversationCompaction
  | ChatConversationCompactionState

export const normalizeChatConversationCompactionState = (
  compaction: ChatConversationCompactionLike | null | undefined,
): ChatConversationCompactionState => {
  if (!compaction) {
    return []
  }

  return Array.isArray(compaction) ? [...compaction] : [compaction]
}

export const getLatestChatConversationCompaction = (
  compaction: ChatConversationCompactionLike | null | undefined,
): ChatConversationCompaction | null => {
  const normalized = normalizeChatConversationCompactionState(compaction)
  return normalized.at(-1) ?? null
}

export type ChatUserMessage = {
  role: 'user'
  content: SerializedEditorState | null
  promptContent: string | ContentPart[] | null
  snapshotRef?: PromptSnapshotRef
  id: string
  mentionables: Mentionable[]
  selectedSkills?: ChatSelectedSkill[]
  selectedModelIds?: string[]
  reasoningLevel?: string
  similaritySearchResults?: (Omit<SelectEmbedding, 'embedding'> & {
    similarity: number
  })[]
}
export type ChatAssistantMessage = {
  role: 'assistant'
  content: string
  reasoning?: string
  annotations?: Annotation[]
  toolCallRequests?: ToolCallRequest[]
  id: string
  metadata?: {
    usage?: ResponseUsage
    model?: ChatModel // TODO: migrate legacy data to new model type
    durationMs?: number
    generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
    providerMetadata?: ProviderMetadata
    sourceUserMessageId?: string
    branchId?: string
    branchModelId?: string
    branchLabel?: string
    branchConversationId?: string
  }
}
export type ChatToolMessage = {
  role: 'tool'
  id: string
  toolCalls: {
    request: ToolCallRequest
    response: ToolCallResponse
  }[]
  metadata?: {
    sourceUserMessageId?: string
    branchId?: string
    branchModelId?: string
    branchLabel?: string
    branchConversationId?: string
  }
}

export type ChatMessage =
  | ChatUserMessage
  | ChatAssistantMessage
  | ChatToolMessage

export type AssistantToolMessageGroup = (
  | ChatAssistantMessage
  | ChatToolMessage
)[]

export type SerializedChatUserMessage = {
  role: 'user'
  content: SerializedEditorState | null
  promptContent: string | ContentPart[] | null
  snapshotRef?: PromptSnapshotRef
  id: string
  mentionables: SerializedMentionable[]
  selectedSkills?: ChatSelectedSkill[]
  selectedModelIds?: string[]
  reasoningLevel?: string
  similaritySearchResults?: (Omit<SelectEmbedding, 'embedding'> & {
    similarity: number
  })[]
}
export type SerializedChatAssistantMessage = {
  role: 'assistant'
  content: string
  reasoning?: string
  annotations?: Annotation[]
  toolCallRequests?: ToolCallRequest[]
  id: string
  metadata?: {
    usage?: ResponseUsage
    model?: ChatModel // TODO: migrate legacy data to new model type
    durationMs?: number
    generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
    providerMetadata?: ProviderMetadata
    sourceUserMessageId?: string
    branchId?: string
    branchModelId?: string
    branchLabel?: string
    branchConversationId?: string
  }
}
export type SerializedChatToolMessage = {
  role: 'tool'
  toolCalls: {
    request: ToolCallRequest
    response: ToolCallResponse
  }[]
  id: string
  metadata?: {
    sourceUserMessageId?: string
    branchId?: string
    branchModelId?: string
    branchLabel?: string
    branchConversationId?: string
  }
}
export type SerializedChatMessage =
  | SerializedChatUserMessage
  | SerializedChatAssistantMessage
  | SerializedChatToolMessage

export type ChatConversation = {
  schemaVersion: number
  id: string
  title: string
  createdAt: number
  updatedAt: number
  isPinned?: boolean
  pinnedAt?: number
  messages: SerializedChatMessage[]
  activeBranchByUserMessageId?: Record<string, string>
  reasoningLevel?: string
  compaction?: ChatConversationCompactionLike | null
}
export type ChatConversationMeta = {
  schemaVersion: number
  id: string
  title: string
  createdAt: number
  updatedAt: number
  isPinned?: boolean
  pinnedAt?: number
}
