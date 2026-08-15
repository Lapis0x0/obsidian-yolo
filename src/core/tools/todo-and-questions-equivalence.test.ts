// Proves the ported `todo_write` `execute()` implementation
// (src/core/tools/todo_write/definition.ts) behaves identically to the
// still-present `case 'todo_write'` branch of `callLocalFileTool` it was
// copied from — per D6 batch 2's exit condition. Also exercises
// `executeBuiltinTool` (dispatcher.ts) end-to-end, and separately documents
// `ask_user_question`'s intentional non-execution contract (it never had a
// `callLocalFileTool` case to compare against — see
// ask_user_question/definition.ts's doc comment).
//
// `callLocalFileTool` itself is NOT the delegation boundary (D6a fix): the
// fork between the old switch and the new dispatcher lives at
// `McpManager.callTool`'s local-tool branch
// (`isBuiltinToolName(toolName) ? executeBuiltinTool(...) :
// callLocalFileTool(...)`, `core/mcp/mcpManager.ts`), not inside
// `callLocalFileTool` — see that fork's doc comment for why. Calling
// `callLocalFileTool` directly here still exercises its own (still-live,
// intentionally kept for this comparison) switch case, which is exactly what
// these equivalence tests need as the "old" baseline. `registry.test.ts`'s
// `isBuiltinToolName` coverage is what proves this tool name actually routes
// through the new path at the real call site.

jest.mock('obsidian')

import { App } from 'obsidian'

import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { callLocalFileTool, getLocalFileTools } from '../mcp/localFileTools'

import { askUserQuestionDefinition } from './ask_user_question/definition'
import { executeBuiltinTool } from './dispatcher'
import { getToolDefinition, isBuiltinToolName } from './registry'
import { todoWriteDefinition } from './todo_write/definition'
import type { ToolContext } from './types'

const app = {} as App

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return { app, ...overrides }
}

describe('todo_write execute() vs callLocalFileTool', () => {
  it('valid todo list: same Success result', async () => {
    const args = {
      todos: [
        { content: 'Write tests', status: 'in_progress' },
        { content: 'Ship it', status: 'pending' },
      ],
    }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'todo_write',
      args,
    })
    const newResult = await todoWriteDefinition.execute(args, makeCtx())

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
  })

  it('clearing the list ([]): same Success result', async () => {
    const args = { todos: [] }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'todo_write',
      args,
    })
    const newResult = await todoWriteDefinition.execute(args, makeCtx())

    expect(newResult).toEqual(oldResult)
  })

  it('todos not an array: same Error result (neither throws — this tool wraps its own errors)', async () => {
    const args = { todos: 'nope' }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'todo_write',
      args,
    })
    const newResult = await todoWriteDefinition.execute(args, makeCtx())

    expect(newResult).toEqual(oldResult)
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'todos must be an array.',
    })
  })

  it('more than one in_progress item: same Error result', async () => {
    const args = {
      todos: [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'in_progress' },
      ],
    }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'todo_write',
      args,
    })
    const newResult = await todoWriteDefinition.execute(args, makeCtx())

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Error)
  })

  it('invalid item shape: same Error result', async () => {
    const args = { todos: [{ content: '', status: 'pending' }] }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'todo_write',
      args,
    })
    const newResult = await todoWriteDefinition.execute(args, makeCtx())

    expect(newResult).toEqual(oldResult)
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'todos[0].content must be a non-empty string.',
    })
  })
})

describe('executeBuiltinTool (dispatcher) vs callLocalFileTool end-to-end: todo_write', () => {
  it('matches for a successful call', async () => {
    const args = { todos: [{ content: 'x', status: 'pending' }] }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'todo_write',
      args,
    })
    const newResult = await executeBuiltinTool('todo_write', args, makeCtx())

    expect(newResult).toEqual(oldResult)
  })
})

describe('ask_user_question registration', () => {
  it('is registered as a builtin tool and resolves through the registry', () => {
    expect(isBuiltinToolName('ask_user_question')).toBe(true)
    expect(getToolDefinition('ask_user_question')).toBe(
      askUserQuestionDefinition,
    )
  })

  it('getMcpTool schema matches the still-live getLocalFileTools() entry (drift guard)', () => {
    const liveTool = getLocalFileTools().find(
      (tool) => tool.name === 'ask_user_question',
    )
    expect(liveTool).toBeDefined()

    const { name: _name, ...liveToolWithoutName } = liveTool!
    expect(askUserQuestionDefinition.getMcpTool({})).toEqual(
      liveToolWithoutName,
    )
  })

  // ask_user_question never had a `callLocalFileTool` case to compare
  // against — the gateway resolves it to `AwaitingUserInput` before tool
  // execution and `AgentService.answerUserQuestion` resolves that pause
  // directly from the user's answers (see definition.ts's doc comment and
  // `service.askUserQuestion.test.ts`, which covers that real flow). This
  // only pins the intentional defensive contract of the body required by
  // `BuiltinToolDefinition.execute`.
  it('execute() throws — it must never be reached by the live runtime', async () => {
    await expect(
      askUserQuestionDefinition.execute({}, makeCtx()),
    ).rejects.toThrow(/does not execute through executeBuiltinTool/)
  })

  it('executeBuiltinTool normalizes that throw into an Error result rather than rejecting', async () => {
    const result = await executeBuiltinTool('ask_user_question', {}, makeCtx())

    expect(result.status).toBe(ToolCallResponseStatus.Error)
  })
})
