// Exercises `executeBuiltinTool`'s own responsibilities (master.md §3.4):
// abort short-circuit, the two security-boundary checks it shares with
// `callLocalFileTool` via `enforceBuiltinToolSecurityBoundary`
// (./security-boundary.ts), unknown-tool-name handling, and normalizing a
// thrown error into an Error-status result. Per phase2-migration.md D5,
// these boundaries are verified through the dispatcher, not per tool.
//
// `memory-equivalence.test.ts` already covers `executeBuiltinTool` producing
// the same result as `callLocalFileTool` for a registered tool (success,
// validation-error, unknown-tool-name); this file focuses on the boundary
// checks themselves, including tool names not yet migrated into the
// registry (D6) — the security boundary must reject them before registry
// lookup ever runs, exactly as `callLocalFileTool`'s inline checks ran
// before its `switch`.

jest.mock('obsidian')

import { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { AssistantWorkspaceScope } from '../../types/assistant.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { executeBuiltinTool } from './dispatcher'
import { memoryAddDefinition } from './memory_add/definition'
import type { ToolContext } from './types'

const app = {} as App

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { app, ...overrides }
}

describe('executeBuiltinTool: abort short-circuit', () => {
  it('returns Aborted and does not execute the tool body when signal is already aborted', async () => {
    const executeSpy = jest.spyOn(memoryAddDefinition, 'execute')
    const controller = new AbortController()
    controller.abort()

    const result = await executeBuiltinTool(
      'memory_add',
      { content: 'should not run' },
      makeCtx({ signal: controller.signal }),
    )

    expect(result).toEqual({ status: ToolCallResponseStatus.Aborted })
    expect(executeSpy).not.toHaveBeenCalled()
    executeSpy.mockRestore()
  })
})

describe('executeBuiltinTool: workspace-scope second line of defense', () => {
  const allowNotes: AssistantWorkspaceScope = {
    enabled: true,
    include: ['Notes'],
    exclude: [],
  }

  it('rejects an out-of-scope path with the same message callLocalFileTool used to throw, before the tool is even looked up', async () => {
    const result = await executeBuiltinTool(
      'fs_edit',
      { path: 'secret/a.md', oldText: 'x', newText: 'y' },
      makeCtx({ workspaceScope: allowNotes }),
    )

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'Path "secret/a.md" is outside this agent\'s workspace scope.',
    })
  })

  it('rejects fs_write when its path is outside scope', async () => {
    const result = await executeBuiltinTool(
      'fs_write',
      { path: 'secret/new.md', content: 'leak' },
      makeCtx({ workspaceScope: allowNotes }),
    )

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toMatch(/secret\/new\.md/)
    }
  })

  it('lets an in-scope path through the boundary (falls through to the not-yet-migrated-tool error, proving the check passed rather than blocking)', async () => {
    const result = await executeBuiltinTool(
      'fs_write',
      { path: 'Notes/a.md', content: 'ok' },
      makeCtx({ workspaceScope: allowNotes }),
    )

    // fs_write is not registered yet (D6) — reaching the unknown-tool error
    // instead of the scope error proves the boundary check itself passed.
    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'Unknown local file tool: fs_write',
    })
  })

  it('is a no-op when scope is disabled', async () => {
    const result = await executeBuiltinTool(
      'fs_write',
      { path: 'secret/a.md', content: 'ok' },
      makeCtx({
        workspaceScope: { enabled: false, include: ['Notes'], exclude: [] },
      }),
    )

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'Unknown local file tool: fs_write',
    })
  })
})

describe('executeBuiltinTool: YOLO user-data-root isolation', () => {
  const settings = { yolo: { baseDir: 'YOLO' } } as unknown as YoloSettings

  it('rejects a call whose path falls under <baseDir>/data', async () => {
    const result = await executeBuiltinTool(
      'fs_edit',
      {
        path: 'YOLO/data/chats/v1_abc.json',
        oldText: 'x',
        newText: 'y',
      },
      makeCtx({ settings }),
    )

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'File not found: YOLO/data/chats/v1_abc.json',
    })
  })

  it('still rejects the same path when workspace scope is disabled (unconditional, independent of scope)', async () => {
    const result = await executeBuiltinTool(
      'fs_edit',
      {
        path: 'YOLO/data/chats/v1_abc.json',
        oldText: 'x',
        newText: 'y',
      },
      makeCtx({
        settings,
        workspaceScope: { enabled: false, include: [], exclude: [] },
      }),
    )

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'File not found: YOLO/data/chats/v1_abc.json',
    })
  })

  it('still rejects the same path when workspace scope is enabled and would otherwise allow it', async () => {
    const result = await executeBuiltinTool(
      'fs_edit',
      {
        path: 'YOLO/data/chats/v1_abc.json',
        oldText: 'x',
        newText: 'y',
      },
      makeCtx({
        settings,
        workspaceScope: { enabled: true, include: ['YOLO'], exclude: [] },
      }),
    )

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'File not found: YOLO/data/chats/v1_abc.json',
    })
  })
})

describe('executeBuiltinTool: unknown tool name', () => {
  it('returns an explicit error instead of throwing', async () => {
    const result = await executeBuiltinTool('not_a_real_tool', {}, makeCtx())

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'Unknown local file tool: not_a_real_tool',
    })
  })
})

describe('executeBuiltinTool: normalizes a thrown tool error', () => {
  it('converts an Error thrown from execute() into an Error-status result rather than rejecting', async () => {
    const result = await executeBuiltinTool('memory_add', {}, makeCtx())

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'content or items is required.',
    })
  })
})
