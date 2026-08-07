// Display adapter for provider-run ("hosted") web searches.
//
// These searches never reach the agent as tool calls — the provider executes
// them inside the same HTTP request and only reports back what it did. The
// receipt is carried on the assistant message as provider metadata; here it is
// shaped into a read-only `web_search` card so a server-side search looks the
// same as one the agent ran itself. Nothing built here is ever dispatched.

import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { getToolName } from '../../../core/mcp/tool-name-utils'
import type { ChatAssistantMessage, ChatToolMessage } from '../../../types/chat'
import type { HostedWebSearchCall } from '../../../types/llm/response'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'

export function buildHostedWebSearchToolMessage(
  message: ChatAssistantMessage,
): ChatToolMessage | null {
  const calls = message.metadata?.providerMetadata?.hostedWebSearch
  if (!calls || calls.length === 0) {
    return null
  }

  return {
    role: 'tool',
    id: `${message.id}-hosted-web-search`,
    toolCalls: calls.map((call, index) => ({
      request: {
        id: `${message.id}-hosted-web-search-${call.id || index}`,
        name: getToolName(getLocalFileToolServerName(), 'web_search'),
        arguments: {
          kind: 'complete' as const,
          value: { query: call.query ?? '' },
        },
      },
      response: {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text' as const, text: formatHostedResults(call) },
      },
    })),
  }
}

// Mirrors the JSON the agent's own web_search tool returns, so the card body
// renders identically. `text` (the result snippet) has no counterpart here —
// providers return their search results with the page content encrypted.
function formatHostedResults(call: HostedWebSearchCall): string {
  return JSON.stringify(
    {
      tool: 'web_search',
      provider: 'provider-hosted',
      items: call.results.map((result, index) => ({
        index: index + 1,
        title: result.title,
        url: result.url,
      })),
    },
    null,
    2,
  )
}
