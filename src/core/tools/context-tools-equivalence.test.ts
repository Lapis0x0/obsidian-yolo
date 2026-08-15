// Proves the ported `context_prune_tool_results` / `context_compact`
// `execute()` implementations (src/core/tools/context_prune_tool_results/
// definition.ts, context_compact/definition.ts) behave identically to the
// still-present `case 'context_prune_tool_results'` / `case
// 'context_compact'` branches of `callLocalFileTool` they were copied from —
// per D6 batch 1's exit condition. Also exercises `executeBuiltinTool`
// (dispatcher.ts) end-to-end for both tools.
//
// `callLocalFileTool` itself is NOT the delegation boundary (D6a fix): the
// fork between the old switch and the new dispatcher lives at
// `McpManager.callTool`'s local-tool branch
// (`isBuiltinToolName(toolName) ? executeBuiltinTool(...) :
// callLocalFileTool(...)`, `core/mcp/mcpManager.ts`), not inside
// `callLocalFileTool` — see that fork's doc comment for why. Calling
// `callLocalFileTool` directly here still exercises its own (still-live,
// intentionally kept for this comparison) switch case, which is exactly
// what these equivalence tests need as the "old" baseline.
// `registry.test.ts`'s `isBuiltinToolName` coverage is what proves these
// tool names actually route through the new path at the real call site.

jest.mock('obsidian')

import { App } from 'obsidian'

import type { ChatMessage } from '../../types/chat'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { callLocalFileTool } from '../mcp/localFileTools'

import { contextCompactDefinition } from './context_compact/definition'
import { contextPruneToolResultsDefinition } from './context_prune_tool_results/definition'
import { executeBuiltinTool } from './dispatcher'
import type { ToolContext } from './types'

const app = {} as App

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return { app, ...overrides }
}

/** One prior 'tool' message with a single prunable fs_read Success result. */
const buildConversationWithPrunableCall = (
  toolCallId: string,
): ChatMessage[] => [
  {
    role: 'tool',
    id: 'tool-msg-1',
    toolCalls: [
      {
        request: {
          id: toolCallId,
          name: 'fs_read',
          arguments: createCompleteToolCallArguments({
            value: { paths: ['a.md'] },
          }),
        },
        response: {
          status: ToolCallResponseStatus.Success,
          data: { type: 'text', text: '{"results":[]}' },
        },
      },
    ],
  } as ChatMessage,
]

describe('context_prune_tool_results execute() vs callLocalFileTool', () => {
  it('mode "all": same result for an identical conversation history', async () => {
    const conversationMessages = buildConversationWithPrunableCall('call_1')
    const args = { mode: 'all', reason: 'cleanup' }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'context_prune_tool_results',
      args,
      conversationMessages,
      toolCallId: 'call_current',
    })
    const newResult = await contextPruneToolResultsDefinition.execute(
      args,
      makeCtx({ conversationMessages, toolCallId: 'call_current' }),
    )

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
  })

  it('mode "selected" with an empty toolCallIds array: old wraps to an Error result, new throws for the dispatcher to normalize', async () => {
    const args = { mode: 'selected', toolCallIds: [] }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'context_prune_tool_results',
      args,
    })
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'toolCallIds cannot be empty when mode is selected.',
    })

    await expect(
      contextPruneToolResultsDefinition.execute(args, makeCtx()),
    ).rejects.toThrow('toolCallIds cannot be empty when mode is selected.')
  })

  it('mode "selected" filters ids into accepted/ignored buckets identically', async () => {
    const conversationMessages = buildConversationWithPrunableCall('call_1')
    const args = { mode: 'selected', toolCallIds: ['call_1', 'not_prunable'] }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'context_prune_tool_results',
      args,
      conversationMessages,
      toolCallId: 'call_current',
    })
    const newResult = await contextPruneToolResultsDefinition.execute(
      args,
      makeCtx({ conversationMessages, toolCallId: 'call_current' }),
    )

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
    if (oldResult.status === ToolCallResponseStatus.Success) {
      expect(oldResult.text).toContain(
        '"acceptedToolCallIds": [\n    "call_1"\n  ]',
      )
      expect(oldResult.text).toContain(
        '"ignoredToolCallIds": [\n    "not_prunable"\n  ]',
      )
    }
  })
})

describe('context_compact execute() vs callLocalFileTool', () => {
  it('same result for an identical reason/instruction pair', async () => {
    const args = { reason: 'too long', instruction: 'focus on the plan' }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'context_compact',
      args,
      toolCallId: 'call_current',
    })
    const newResult = await contextCompactDefinition.execute(
      args,
      makeCtx({ toolCallId: 'call_current' }),
    )

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
  })

  it('omitted reason/instruction: both null in the result', async () => {
    const oldResult = await callLocalFileTool({
      app,
      toolName: 'context_compact',
      args: {},
    })
    const newResult = await contextCompactDefinition.execute({}, makeCtx())

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
    if (oldResult.status === ToolCallResponseStatus.Success) {
      expect(oldResult.text).toContain('"reason": null')
      expect(oldResult.text).toContain('"instruction": null')
    }
  })
})

describe('executeBuiltinTool (dispatcher) vs callLocalFileTool end-to-end', () => {
  it('matches for context_prune_tool_results', async () => {
    const args = { mode: 'all' }
    const oldResult = await callLocalFileTool({
      app,
      toolName: 'context_prune_tool_results',
      args,
    })
    const newResult = await executeBuiltinTool(
      'context_prune_tool_results',
      args,
      makeCtx(),
    )

    expect(newResult).toEqual(oldResult)
  })

  it('matches for context_compact', async () => {
    const args = { reason: 'r' }
    const oldResult = await callLocalFileTool({
      app,
      toolName: 'context_compact',
      args,
    })
    const newResult = await executeBuiltinTool(
      'context_compact',
      args,
      makeCtx(),
    )

    expect(newResult).toEqual(oldResult)
  })
})
