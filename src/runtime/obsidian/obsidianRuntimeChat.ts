import type { App } from 'obsidian'

import { serializeChatMessage } from '../../core/agent/conversationPersistence'
import { batchLookupImageCache } from '../../database/json/chat/imageCacheStore'
import { ChatManager } from '../../database/json/chat/ChatManager'
import { compactConversationMessagesForStorage } from '../../database/json/chat/promptSnapshotStore'
import { DEFAULT_UNTITLED_CONVERSATION_TITLE } from '../../constants'
import type SmartComposerPlugin from '../../main'
import type { Mentionable } from '../../types/mentionable'
import type {
  ChatMessage,
  ChatUserMessage,
  SerializedChatMessage,
} from '../../types/chat'
import { normalizeChatConversationCompactionState } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { deserializeMentionable } from '../../utils/chat/mentionable'
import type { YoloRuntime } from '../yoloRuntime.types'

const structurallyEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

export function createObsidianRuntimeChat(
  plugin: SmartComposerPlugin,
): YoloRuntime['chat'] {
  const getManager = () => new ChatManager(plugin.app, plugin.settings)

  return {
    list: () => getManager().listChats(),
    get: async (id) => {
      const chat = await getManager().findById(id)
      if (!chat) return null

      const messages = chat.messages.map((message) =>
        deserializeChatMessage(message, plugin.app),
      )
      await hydrateImageCacheRefs(messages, plugin.app, plugin.settings)

      return {
        id: chat.id,
        title: chat.title,
        messages,
        overrides: chat.overrides,
        conversationModelId: chat.conversationModelId,
        messageModelMap: chat.messageModelMap,
        activeBranchByUserMessageId: chat.activeBranchByUserMessageId,
        assistantGroupBoundaryMessageIds:
          chat.assistantGroupBoundaryMessageIds,
        reasoningLevel: chat.reasoningLevel,
        compaction: normalizeChatConversationCompactionState(chat.compaction),
        updatedAt: chat.updatedAt,
      }
    },
    save: async (input) => {
      const manager = getManager()
      const serializedMessages = input.messages.map(serializeChatMessage)
      const existing = await manager.findById(input.id)
      const compactedMessages = await compactConversationMessagesForStorage({
        app: plugin.app,
        conversationId: input.id,
        messages: serializedMessages,
        previousMessages: existing?.messages,
        settings: plugin.settings,
      })

      const nextCompaction =
        input.compaction === undefined
          ? normalizeChatConversationCompactionState(existing?.compaction)
          : normalizeChatConversationCompactionState(input.compaction)
      const nextOverrides =
        input.overrides === undefined
          ? (existing?.overrides ?? null)
          : input.overrides
      const nextConversationModelId =
        input.conversationModelId === undefined
          ? existing?.conversationModelId
          : input.conversationModelId
      const nextMessageModelMap =
        input.messageModelMap === undefined
          ? existing?.messageModelMap
          : input.messageModelMap
      const nextActiveBranchByUserMessageId =
        input.activeBranchByUserMessageId === undefined
          ? existing?.activeBranchByUserMessageId
          : input.activeBranchByUserMessageId
      const nextAssistantGroupBoundaryMessageIds =
        input.assistantGroupBoundaryMessageIds === undefined
          ? existing?.assistantGroupBoundaryMessageIds
          : input.assistantGroupBoundaryMessageIds
      const nextReasoningLevel =
        input.reasoningLevel === undefined
          ? existing?.reasoningLevel
          : input.reasoningLevel

      if (existing) {
        if (
          structurallyEqual(existing.messages, compactedMessages) &&
          structurallyEqual(existing.overrides ?? null, nextOverrides ?? null) &&
          existing.conversationModelId === nextConversationModelId &&
          structurallyEqual(
            existing.messageModelMap ?? null,
            nextMessageModelMap ?? null,
          ) &&
          structurallyEqual(
            existing.activeBranchByUserMessageId ?? null,
            nextActiveBranchByUserMessageId ?? null,
          ) &&
          structurallyEqual(
            existing.assistantGroupBoundaryMessageIds ?? null,
            nextAssistantGroupBoundaryMessageIds ?? null,
          ) &&
          existing.reasoningLevel === nextReasoningLevel &&
          structurallyEqual(
            normalizeChatConversationCompactionState(existing.compaction),
            nextCompaction,
          )
        ) {
          return
        }

        await manager.updateChat(
          input.id,
          {
            messages: compactedMessages,
            overrides: nextOverrides,
            conversationModelId: nextConversationModelId,
            messageModelMap: nextMessageModelMap,
            activeBranchByUserMessageId: nextActiveBranchByUserMessageId,
            assistantGroupBoundaryMessageIds:
              nextAssistantGroupBoundaryMessageIds,
            reasoningLevel: nextReasoningLevel,
            compaction: nextCompaction,
          },
          { touchUpdatedAt: input.touchUpdatedAt },
        )
        return
      }

      await manager.createChat({
        id: input.id,
        title: DEFAULT_UNTITLED_CONVERSATION_TITLE,
        messages: compactedMessages,
        overrides: input.overrides,
        conversationModelId: input.conversationModelId,
        messageModelMap: input.messageModelMap,
        activeBranchByUserMessageId: input.activeBranchByUserMessageId,
        assistantGroupBoundaryMessageIds: input.assistantGroupBoundaryMessageIds,
        reasoningLevel: input.reasoningLevel,
        compaction: nextCompaction,
      })
    },
    delete: async (id) => {
      await getManager().deleteChat(id)
    },
    togglePinned: async (id) => {
      const manager = getManager()
      const chat = await manager.findById(id)
      if (!chat) return
      const nextIsPinned = !(chat.isPinned ?? false)
      await manager.updateChat(id, {
        isPinned: nextIsPinned,
        ...(nextIsPinned ? { pinnedAt: Date.now() } : { pinnedAt: undefined }),
      })
    },
    updateTitle: async (id, title, options) => {
      await getManager().updateChat(
        id,
        { title },
        options?.touchUpdatedAt === undefined
          ? undefined
          : { touchUpdatedAt: options.touchUpdatedAt },
      )
    },
    generateTitle: async () => {
      // Keep title generation in the existing shared hook first.
      // Move it here only after Chat stops owning title generation.
    },
  }
}

const deserializeChatMessage = (
  message: SerializedChatMessage,
  app: App,
): ChatMessage => {
  switch (message.role) {
    case 'user':
      return {
        role: 'user',
        content: message.content,
        promptContent: message.promptContent,
        snapshotRef: message.snapshotRef,
        id: message.id,
        mentionables: (message.mentionables ?? [])
          .map((mentionable) => deserializeMentionable(mentionable, app))
          .filter(
            (mentionable): mentionable is Mentionable => mentionable !== null,
          ),
        selectedSkills: message.selectedSkills ?? [],
        selectedModelIds: message.selectedModelIds ?? [],
        reasoningLevel: message.reasoningLevel,
      } satisfies ChatUserMessage
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        reasoning: message.reasoning,
        annotations: message.annotations,
        toolCallRequests: message.toolCallRequests,
        id: message.id,
        metadata: message.metadata,
      }
    case 'tool':
      return {
        role: 'tool',
        toolCalls: message.toolCalls,
        id: message.id,
        metadata: message.metadata,
      }
    case 'external_agent_result':
      return message
  }
}

const hydrateImageCacheRefs = async (
  messages: ChatMessage[],
  app: App,
  settings?: { yolo?: { baseDir?: string } } | null,
): Promise<void> => {
  const cacheKeys = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const toolCall of message.toolCalls) {
      if (toolCall.response.status !== ToolCallResponseStatus.Success) continue
      const parts = toolCall.response.data.contentParts
      if (!parts) continue
      for (const part of parts) {
        if (
          part.type === 'image_url' &&
          part.image_url.url.startsWith('cache://')
        ) {
          cacheKeys.add(part.image_url.cacheKey ?? part.image_url.url.slice(8))
        }
      }
    }
  }

  if (cacheKeys.size === 0) {
    return
  }

  const resolved = await batchLookupImageCache(
    app,
    Array.from(cacheKeys),
    settings,
  )

  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const toolCall of message.toolCalls) {
      if (toolCall.response.status !== ToolCallResponseStatus.Success) continue
      const parts = toolCall.response.data.contentParts
      if (!parts) continue
      for (const part of parts) {
        if (
          part.type === 'image_url' &&
          part.image_url.url.startsWith('cache://')
        ) {
          const key = part.image_url.cacheKey ?? part.image_url.url.slice(8)
          const dataUrl = resolved.get(key)
          if (dataUrl) {
            part.image_url.url = dataUrl
          }
        }
      }
    }
  }
}
