import { App } from 'obsidian'

import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { executeBuiltinTool } from '../tools/dispatcher'

const stubApp = {} as unknown as App

// See the same note in `localFileTools.test.ts`: `callLocalFileTool` was
// deleted with the old switch (D12); this suite now runs `todo_write`
// through the registry dispatcher instead.
const call = (args: Record<string, unknown>) =>
  executeBuiltinTool('todo_write', args, { app: stubApp })

describe('todo_write tool (validation)', () => {
  it('returns success on a valid todo list', async () => {
    const result = await call({
      todos: [
        { content: 'Run tests', status: 'pending' },
        { content: 'Build project', status: 'in_progress' },
      ],
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
  })

  it('returns success on an empty list', async () => {
    const result = await call({ todos: [] })
    expect(result.status).toBe(ToolCallResponseStatus.Success)
  })

  it('errors when todos is not an array', async () => {
    const result = await call({ todos: 'not-an-array' })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status !== ToolCallResponseStatus.Error) return
    expect(result.error).toMatch(/todos must be an array/)
  })

  it('errors when content is empty', async () => {
    const result = await call({
      todos: [{ content: '   ', status: 'pending' }],
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status !== ToolCallResponseStatus.Error) return
    expect(result.error).toMatch(/content/)
  })

  it('errors when status is invalid', async () => {
    const result = await call({
      todos: [{ content: 'A', status: 'done' }],
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status !== ToolCallResponseStatus.Error) return
    expect(result.error).toMatch(/status/)
  })

  it('errors when more than one item is in_progress', async () => {
    const result = await call({
      todos: [
        { content: 'A', status: 'in_progress' },
        { content: 'B', status: 'in_progress' },
      ],
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status !== ToolCallResponseStatus.Error) return
    expect(result.error).toMatch(/in_progress/)
  })
})
