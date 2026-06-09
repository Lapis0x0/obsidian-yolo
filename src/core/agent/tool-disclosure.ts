import type {
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import { getLatestChatConversationCompaction } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { isLoadToolSchemasToolName } from './tool-selection'

export const LOAD_TOOL_SCHEMAS_RESULT_TOOL = 'load_tool_schemas'

export type LoadedDeferredToolSchema = {
  name: string
  description: string
  parameters: unknown
}

const parseToolSearchResult = (
  text: string,
): {
  loadedToolNames: string[]
  schemas: LoadedDeferredToolSchema[]
} | null => {
  try {
    const parsed = JSON.parse(text) as {
      tool?: unknown
      loadedToolNames?: unknown
      matches?: unknown
    }
    if (parsed.tool !== LOAD_TOOL_SCHEMAS_RESULT_TOOL) {
      return null
    }
    const loadedToolNames: string[] = []
    if (Array.isArray(parsed.loadedToolNames)) {
      for (const name of parsed.loadedToolNames) {
        if (typeof name === 'string' && name.trim().length > 0) {
          loadedToolNames.push(name)
        }
      }
    }
    const schemas: LoadedDeferredToolSchema[] = []
    if (Array.isArray(parsed.matches)) {
      for (const match of parsed.matches) {
        if (!match || typeof match !== 'object') continue
        const m = match as Record<string, unknown>
        const name = typeof m.name === 'string' ? m.name.trim() : ''
        if (!name) continue
        const description =
          typeof m.description === 'string' ? m.description : ''
        schemas.push({
          name,
          description,
          parameters: m.parameters,
        })
      }
    }
    return { loadedToolNames, schemas }
  } catch {
    return null
  }
}

export const extractLoadedDeferredToolNames = ({
  messages,
  compaction,
}: {
  messages: ChatMessage[]
  compaction?: ChatConversationCompactionLike | null
}): Set<string> => {
  const loaded = new Set<string>()
  const latestCompaction = getLatestChatConversationCompaction(compaction)
  for (const name of latestCompaction?.loadedDeferredToolNames ?? []) {
    loaded.add(name)
  }
  for (const schema of latestCompaction?.loadedDeferredToolSchemas ?? []) {
    if (typeof schema?.name === 'string' && schema.name.trim().length > 0) {
      loaded.add(schema.name)
    }
  }

  for (const message of messages) {
    if (message.role !== 'tool') {
      continue
    }
    for (const toolCall of message.toolCalls) {
      if (!isLoadToolSchemasToolName(toolCall.request.name)) {
        continue
      }
      if (toolCall.response.status !== ToolCallResponseStatus.Success) {
        continue
      }
      const parsed = parseToolSearchResult(toolCall.response.data.text)
      if (!parsed) continue
      for (const name of parsed.loadedToolNames) {
        loaded.add(name)
      }
    }
  }

  return loaded
}

/**
 * Walk the conversation (and latest compaction registry) to recover full
 * schemas for every on-demand tool that has been disclosed via `load_tool_schemas`.
 * Used by compaction to persist the registry forward and by the request
 * builder to re-inject disclosed schemas after compaction discards history.
 *
 * Later occurrences win, so a tool re-disclosed mid-conversation reflects its
 * latest schema. Compaction-registered schemas are seeded first and then
 * overwritten by any post-compaction disclosure in the live transcript.
 */
export const extractLoadedDeferredToolSchemas = ({
  messages,
  compaction,
}: {
  messages: ChatMessage[]
  compaction?: ChatConversationCompactionLike | null
}): LoadedDeferredToolSchema[] => {
  const byName = new Map<string, LoadedDeferredToolSchema>()
  const latestCompaction = getLatestChatConversationCompaction(compaction)
  for (const schema of latestCompaction?.loadedDeferredToolSchemas ?? []) {
    if (typeof schema?.name === 'string' && schema.name.trim().length > 0) {
      byName.set(schema.name, {
        name: schema.name,
        description: schema.description ?? '',
        parameters: schema.parameters,
      })
    }
  }

  for (const message of messages) {
    if (message.role !== 'tool') {
      continue
    }
    for (const toolCall of message.toolCalls) {
      if (!isLoadToolSchemasToolName(toolCall.request.name)) {
        continue
      }
      if (toolCall.response.status !== ToolCallResponseStatus.Success) {
        continue
      }
      const parsed = parseToolSearchResult(toolCall.response.data.text)
      if (!parsed) continue
      for (const schema of parsed.schemas) {
        byName.set(schema.name, schema)
      }
    }
  }

  return [...byName.values()]
}
