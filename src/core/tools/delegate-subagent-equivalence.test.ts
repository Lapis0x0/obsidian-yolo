// Proves the ported `delegate_subagent` `execute()` implementation
// (src/core/tools/delegate_subagent/definition.ts) behaves identically to
// the still-live `case 'delegate_subagent'` branch of `callLocalFileTool`
// (src/core/mcp/localFileTools.ts) it was copied from — per Phase 1 D3's
// exit condition. Mirrors the existing `delegate_subagent model selection`
// suite in `localFileTools.test.ts` (same settings fixture, same
// `runSubagent` mock) so both paths are exercised under identical
// conditions. Also exercises `executeBuiltinTool` (dispatcher.ts)
// end-to-end for this tool.

jest.mock('obsidian')

jest.mock('../agent/subagent/runner', () => ({
  runSubagent: jest.fn().mockResolvedValue({
    accepted: true,
    taskId: 'sub_test',
    title: 'Test',
    status: 'running',
    note: 'accepted',
    modelName: 'mock',
  }),
}))

import { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { runSubagent } from '../agent/subagent/runner'
import { callLocalFileTool } from '../mcp/localFileTools'

import { delegateSubagentDefinition } from './delegate_subagent/definition'
import { executeBuiltinTool } from './dispatcher'
import type { ToolContext } from './types'

afterEach(() => {
  ;(runSubagent as jest.Mock).mockClear()
})

const buildSettings = (): YoloSettings =>
  ({
    providers: [
      {
        id: 'openai',
        presetType: 'openai',
        apiType: 'openai-compatible',
        apiKey: 'token',
      },
    ],
    chatModelId: 'openai/gpt-5',
    chatModels: [
      {
        id: 'openai/gpt-5',
        providerId: 'openai',
        model: 'gpt-5',
        enable: true,
      },
      {
        id: 'openai/gpt-4.1-mini',
        providerId: 'openai',
        model: 'gpt-4.1-mini',
        enable: true,
      },
    ],
    mcp: {
      servers: [],
      enableToolDisclosure: false,
      builtinToolOptions: {
        delegate_subagent: {
          allowedModelIds: ['openai/gpt-5', 'openai/gpt-4.1-mini'],
          preferredModelId: 'openai/gpt-4.1-mini',
        },
      },
    },
  }) as unknown as YoloSettings

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    app: {} as App,
    settings: buildSettings(),
    conversationId: 'conv',
    conversationMessages: [],
    toolCallId: 'tool-call',
    subagentParentContext: {} as never,
    ...overrides,
  }
}

const callOldDelegateSubagent = (args: Record<string, unknown>) =>
  callLocalFileTool({
    app: {} as App,
    settings: buildSettings(),
    conversationId: 'conv',
    conversationMessages: [],
    toolCallId: 'tool-call',
    toolName: 'delegate_subagent',
    args: {
      description: 'Scan',
      prompt: 'Scan notes',
      ...args,
    },
    subagentParentContext: {} as never,
  })

const callNewDelegateSubagent = (args: Record<string, unknown>) =>
  delegateSubagentDefinition.execute(
    { description: 'Scan', prompt: 'Scan notes', ...args },
    makeCtx(),
  )

describe('delegate_subagent execute() vs callLocalFileTool', () => {
  it('uses explicit modelId when it is in the subagent model pool', async () => {
    const oldResult = await callOldDelegateSubagent({
      modelId: 'openai/gpt-5',
    })
    const newResult = await callNewDelegateSubagent({
      modelId: 'openai/gpt-5',
    })

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
    expect(runSubagent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        childModel: expect.objectContaining({
          model: expect.objectContaining({ id: 'openai/gpt-5' }),
        }),
      }),
    )
    expect(runSubagent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        childModel: expect.objectContaining({
          model: expect.objectContaining({ id: 'openai/gpt-5' }),
        }),
      }),
    )
  })

  it('uses the preferred subagent model when modelId is omitted', async () => {
    const oldResult = await callOldDelegateSubagent({})
    const newResult = await callNewDelegateSubagent({})

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
    expect(runSubagent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        childModel: expect.objectContaining({
          model: expect.objectContaining({ id: 'openai/gpt-4.1-mini' }),
        }),
      }),
    )
    expect(runSubagent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        childModel: expect.objectContaining({
          model: expect.objectContaining({ id: 'openai/gpt-4.1-mini' }),
        }),
      }),
    )
  })

  it('rejects modelId values outside the subagent model pool: old wraps to an Error result, new throws', async () => {
    const oldResult = await callOldDelegateSubagent({
      modelId: 'openai/forbidden',
    })
    expect(oldResult.status).toBe(ToolCallResponseStatus.Error)
    if (oldResult.status !== ToolCallResponseStatus.Error) {
      throw new Error('expected an Error result')
    }
    expect(oldResult.error).toContain('not allowed for delegate_subagent')

    await expect(
      callNewDelegateSubagent({ modelId: 'openai/forbidden' }),
    ).rejects.toThrow('not allowed for delegate_subagent')
    expect(runSubagent).not.toHaveBeenCalled()
  })

  it('missing subagentParentContext: old wraps to an Error result, new throws for the dispatcher to normalize', async () => {
    const oldResult = await callLocalFileTool({
      app: {} as App,
      settings: buildSettings(),
      conversationId: 'conv',
      toolName: 'delegate_subagent',
      args: { description: 'Scan', prompt: 'Scan notes' },
      // subagentParentContext intentionally omitted
    })
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error:
        'delegate_subagent is only available during an active parent agent run.',
    })

    await expect(
      delegateSubagentDefinition.execute(
        { description: 'Scan', prompt: 'Scan notes' },
        makeCtx({ subagentParentContext: undefined }),
      ),
    ).rejects.toThrow(
      'delegate_subagent is only available during an active parent agent run.',
    )
  })
})

describe('executeBuiltinTool (dispatcher) vs callLocalFileTool end-to-end', () => {
  it('matches for a successful delegate_subagent call', async () => {
    const oldResult = await callOldDelegateSubagent({})
    const newResult = await executeBuiltinTool(
      'delegate_subagent',
      { description: 'Scan', prompt: 'Scan notes' },
      makeCtx(),
    )

    expect(newResult).toEqual(oldResult)
  })

  it('matches the old outer-catch Error result for a rejected modelId', async () => {
    const oldResult = await callOldDelegateSubagent({
      modelId: 'openai/forbidden',
    })
    const newResult = await executeBuiltinTool(
      'delegate_subagent',
      {
        description: 'Scan',
        prompt: 'Scan notes',
        modelId: 'openai/forbidden',
      },
      makeCtx(),
    )

    expect(newResult).toEqual(oldResult)
  })
})
