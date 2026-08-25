// One run of tools a provider executed inside its own runtime.
//
// These never reach the tool gateway: the provider's own loop ran them and
// only reported back what it did (see `ProviderExecutedToolCall`). What is
// built here is a read-only record of that, placed in the conversation where
// the run happened, so the answer keeps its shape — text, the run, more text.
//
// The requests are built with `createCliToolCallRequest` so the cards render
// exactly as they do in Claude Code chat mode: the tools are the same tools,
// only the surface that hosts them differs.

import type { ChatToolMessage } from '../../types/chat'
import type { ProviderExecutedToolCall } from '../../types/llm/response'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { createCliToolCallRequest } from '../cli-runtime/tool-call'

/**
 * Identity of a run, derived from its first call. Every update to the run
 * carries the same first call, so the message it produces replaces the
 * previous one instead of appending a second copy.
 */
const providerToolRunMessageId = (calls: ProviderExecutedToolCall[]): string =>
  `provider-run-${calls[0].id}`

export const buildProviderToolRunMessage = ({
  calls,
  conversationId,
  branchId,
  sourceUserMessageId,
  branchModelId,
  branchLabel,
}: {
  calls: ProviderExecutedToolCall[]
  conversationId: string
  branchId?: string
  sourceUserMessageId?: string
  branchModelId?: string
  branchLabel?: string
}): ChatToolMessage => ({
  role: 'tool',
  id: providerToolRunMessageId(calls),
  metadata: {
    branchConversationId: conversationId,
    branchId,
    sourceUserMessageId,
    branchModelId,
    branchLabel,
  },
  toolCalls: calls.map((call) => ({
    request: createCliToolCallRequest({
      id: call.id,
      metadata: {
        runtimeId: 'claude-code',
        eventType: 'tool_use',
        name: call.name,
      },
      input: call.input ?? {},
    }),
    response: toResponse(call),
  })),
})

const toResponse = (
  call: ProviderExecutedToolCall,
): ChatToolMessage['toolCalls'][number]['response'] => {
  switch (call.status) {
    case 'running':
      return { status: ToolCallResponseStatus.Running }
    case 'error':
      return {
        status: ToolCallResponseStatus.Error,
        error: call.resultText ?? 'The tool reported an error.',
      }
    case 'success':
      return {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: call.resultText ?? '' },
      }
  }
}
