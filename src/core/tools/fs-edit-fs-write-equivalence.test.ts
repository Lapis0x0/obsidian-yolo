// Proves the ported `fs_edit` / `fs_write` `execute()` implementations
// (src/core/tools/fs_edit/definition.ts, src/core/tools/fs_write/definition.ts)
// behave identically to the still-present `case 'fs_edit'` / `case 'fs_write'`
// branches of `callLocalFileTool` they were copied from — per D6 batch 4's
// exit condition (phase2-migration.md D6 批 4).
//
// This batch is the most approval-coupled of D6: `waitForFsEditReview`
// (src/core/tools/fs_edit/schema-helpers.ts) now reads `openApplyReview` /
// `requireReview` off `ToolContext` instead of `callLocalFileTool`'s own
// destructured parameters — a dependency-source change only, not a change
// to its timing or semantics (master.md D6 批 4 item 2). The approval-path
// tests below (accept / partial-reject / full-reject / abort) exercise that
// exact function through the new `ToolContext`-based call site and compare
// against the old parameter-based one, so any accidental timing/semantics
// drift introduced while re-plumbing the dependency would show up as a
// mismatch here.
//
// `callLocalFileTool` is NOT the delegation boundary (D6a fix) — the fork
// between the old switch and the new dispatcher lives at
// `McpManager.callTool`'s local-tool branch in `core/mcp/mcpManager.ts`.
// Calling `callLocalFileTool` directly here exercises its own still-live
// switch case, which is exactly the "old" baseline this file compares
// against. `registry.test.ts`'s `isBuiltinToolName` coverage (extended in
// this batch) is what proves these tools actually route through the new
// path at the real call site.

jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import type { AssistantWorkspaceScope } from '../../types/assistant.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { callLocalFileTool, getLocalFileTools } from '../mcp/localFileTools'

import { executeBuiltinTool } from './dispatcher'
import { fsEditDefinition } from './fs_edit/definition'
import { fsWriteDefinition } from './fs_write/definition'
import type { ToolContext } from './types'

const app = {} as App

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return { app, ...overrides }
}

// `appliedAt: Date.now()` is stamped independently by the old and new call
// each test makes back-to-back — real wall-clock time can tick between them
// and fail a deep-equality comparison for a reason that has nothing to do
// with behavior. Pin it for the duration of each test so the two calls see
// the same instant, matching how a single real dispatch would.
let dateNowSpy: jest.SpyInstance<number, []>
beforeEach(() => {
  dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
})
afterEach(() => {
  dateNowSpy.mockRestore()
})

const makeEditFile = (path: string, size = 20): TFile =>
  Object.assign(new TFile(), { path, stat: { size } })

/** Minimal edit-capable mock vault app: existing file, read + modify. */
const makeEditApp = (content: string, file = makeEditFile('note.md')): App =>
  ({
    vault: {
      getAbstractFileByPath: jest.fn().mockReturnValue(file),
      read: jest.fn().mockResolvedValue(content),
      modify: jest.fn().mockResolvedValue(undefined),
    },
  }) as unknown as App

/** Minimal write-capable mock vault app: `existing` is what
 * `getAbstractFileByPath` returns for every path (null = new file). */
const makeWriteApp = (existing: TFile | TFolder | null = null): App =>
  ({
    vault: {
      getAbstractFileByPath: jest.fn().mockReturnValue(existing),
      read: jest.fn().mockResolvedValue('old content'),
      modify: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      createFolder: jest.fn().mockResolvedValue(undefined),
    },
  }) as unknown as App

describe('fs_edit execute() vs callLocalFileTool (requireReview: false)', () => {
  it('exact-text replace: same result, same modify() call', async () => {
    const oldApp = makeEditApp('hello world')
    const newApp = makeEditApp('hello world')
    const args = { path: 'note.md', oldText: 'world', newText: 'there' }

    const oldResult = await callLocalFileTool({
      app: oldApp,
      toolName: 'fs_edit',
      args,
    })
    const newResult = await fsEditDefinition.execute(
      args,
      makeCtx({ app: newApp }),
    )

    expect(newResult).toEqual(oldResult)
    expect(newResult.status).toBe(ToolCallResponseStatus.Success)
    expect(
      (newApp as unknown as { vault: { modify: jest.Mock } }).vault.modify,
    ).toHaveBeenCalledTimes(1)
  })

  it('line-range replace: same result', async () => {
    const oldApp = makeEditApp('line1\nline2\nline3')
    const newApp = makeEditApp('line1\nline2\nline3')
    const args = { path: 'note.md', startLine: 2, endLine: 2, newText: 'LINE2' }

    const oldResult = await callLocalFileTool({
      app: oldApp,
      toolName: 'fs_edit',
      args,
    })
    const newResult = await fsEditDefinition.execute(
      args,
      makeCtx({ app: newApp }),
    )

    expect(newResult).toEqual(oldResult)
  })

  it('missing locator: old wraps to an Error result, new throws for the dispatcher to normalize', async () => {
    const oldApp = makeEditApp('hello world')
    const newApp = makeEditApp('hello world')
    const args = { path: 'note.md', newText: 'there' }

    const oldResult = await callLocalFileTool({
      app: oldApp,
      toolName: 'fs_edit',
      args,
    })
    expect(oldResult.status).toBe(ToolCallResponseStatus.Error)

    await expect(
      fsEditDefinition.execute(args, makeCtx({ app: newApp })),
    ).rejects.toThrow(
      'Provide either oldText (exact replace) or startLine+endLine (line range).',
    )
  })

  it('file not found: same error', async () => {
    const oldApp = {
      vault: { getAbstractFileByPath: jest.fn().mockReturnValue(null) },
    } as unknown as App
    const newApp = {
      vault: { getAbstractFileByPath: jest.fn().mockReturnValue(null) },
    } as unknown as App
    const args = { path: 'missing.md', oldText: 'a', newText: 'b' }

    const oldResult = await callLocalFileTool({
      app: oldApp,
      toolName: 'fs_edit',
      args,
    })
    await expect(
      fsEditDefinition.execute(args, makeCtx({ app: newApp })),
    ).rejects.toThrow('File not found: missing.md')
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'File not found: missing.md',
    })
  })
})

describe('fs_edit approval path (requireReview: true) — waitForFsEditReview dependency source change only', () => {
  it('accepted review: same result; modify() is NOT called directly (the review UI owns the write)', async () => {
    const file = makeEditFile('note.md')
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onComplete?.({
        finalContent: 'hello changed',
        review: { totalChanges: 1, rejectedChanges: [] },
      })
      return true
    })
    const args = { path: 'note.md', oldText: 'world', newText: 'changed' }

    const oldApp = makeEditApp('hello world', file)
    const oldResult = await callLocalFileTool({
      app: oldApp,
      openApplyReview,
      toolName: 'fs_edit',
      args,
      requireReview: true,
    })

    const newApp = makeEditApp('hello world', file)
    const newResult = await fsEditDefinition.execute(
      args,
      makeCtx({ app: newApp, openApplyReview, requireReview: true }),
    )

    expect(newResult).toEqual(oldResult)
    expect(newResult.status).toBe(ToolCallResponseStatus.Success)
    expect(
      (newApp as unknown as { vault: { modify: jest.Mock } }).vault.modify,
    ).not.toHaveBeenCalled()
  })

  it('partially rejected review: same compact-preview payload', async () => {
    const file = makeEditFile('note.md')
    const proposedText =
      'This proposed paragraph is intentionally much longer than forty characters.'
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onComplete?.({
        finalContent: 'hello changed',
        review: {
          totalChanges: 2,
          rejectedChanges: [{ index: 2, originalText: 'world', proposedText }],
        },
      })
      return true
    })
    const args = { path: 'note.md', oldText: 'world', newText: 'changed' }

    const oldResult = await callLocalFileTool({
      app: makeEditApp('hello world', file),
      openApplyReview,
      toolName: 'fs_edit',
      args,
      requireReview: true,
    })
    const newResult = await fsEditDefinition.execute(
      args,
      makeCtx({
        app: makeEditApp('hello world', file),
        openApplyReview,
        requireReview: true,
      }),
    )

    expect(newResult).toEqual(oldResult)
  })

  it('fully rejected review: same Rejected status + reason', async () => {
    const file = makeEditFile('note.md')
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onComplete?.({
        finalContent: 'hello world',
        review: {
          totalChanges: 1,
          rejectedChanges: [
            { index: 1, originalText: 'world', proposedText: 'changed' },
          ],
        },
      })
      return true
    })
    const args = { path: 'note.md', oldText: 'world', newText: 'changed' }

    const oldResult = await callLocalFileTool({
      app: makeEditApp('hello world', file),
      openApplyReview,
      toolName: 'fs_edit',
      args,
      requireReview: true,
    })
    const newResult = await fsEditDefinition.execute(
      args,
      makeCtx({
        app: makeEditApp('hello world', file),
        openApplyReview,
        requireReview: true,
      }),
    )

    expect(newResult).toEqual(oldResult)
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Rejected,
      reason:
        'Explicit user decision: this change was rejected in the review UI. This is not an edit or matching failure. Do not retry it with another locator or tool this turn; acknowledge the decision and wait for the user.',
    })
  })

  it('review closed without a decision: same Aborted status, no write', async () => {
    const file = makeEditFile('note.md')
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onCancel?.()
      return true
    })
    const args = { path: 'note.md', oldText: 'world', newText: 'changed' }

    const oldApp = makeEditApp('hello world', file)
    const oldResult = await callLocalFileTool({
      app: oldApp,
      openApplyReview,
      toolName: 'fs_edit',
      args,
      requireReview: true,
    })

    const newApp = makeEditApp('hello world', file)
    const newResult = await fsEditDefinition.execute(
      args,
      makeCtx({ app: newApp, openApplyReview, requireReview: true }),
    )

    expect(newResult).toEqual(oldResult)
    expect(oldResult).toEqual({ status: ToolCallResponseStatus.Aborted })
    expect(
      (newApp as unknown as { vault: { modify: jest.Mock } }).vault.modify,
    ).not.toHaveBeenCalled()
  })

  it('requireReview true but no openApplyReview supplied: same error, same message', async () => {
    const file = makeEditFile('note.md')
    const args = { path: 'note.md', oldText: 'world', newText: 'changed' }

    const oldResult = await callLocalFileTool({
      app: makeEditApp('hello world', file),
      toolName: 'fs_edit',
      args,
      requireReview: true,
    })
    await expect(
      fsEditDefinition.execute(
        args,
        makeCtx({ app: makeEditApp('hello world', file), requireReview: true }),
      ),
    ).rejects.toThrow('Apply review is unavailable for fs_edit.')
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'Apply review is unavailable for fs_edit.',
    })
  })

  it('signal already aborted: same Aborted short-circuit before opening the review UI', async () => {
    const file = makeEditFile('note.md')
    const controller = new AbortController()
    controller.abort()
    const openApplyReview = jest.fn()
    const args = { path: 'note.md', oldText: 'world', newText: 'changed' }

    const oldResult = await callLocalFileTool({
      app: makeEditApp('hello world', file),
      openApplyReview,
      toolName: 'fs_edit',
      args,
      requireReview: true,
      signal: controller.signal,
    })
    const newResult = await fsEditDefinition.execute(
      args,
      makeCtx({
        app: makeEditApp('hello world', file),
        openApplyReview,
        requireReview: true,
        signal: controller.signal,
      }),
    )

    expect(newResult).toEqual(oldResult)
    expect(oldResult).toEqual({ status: ToolCallResponseStatus.Aborted })
    expect(openApplyReview).not.toHaveBeenCalled()
  })
})

describe('fs_write execute() vs callLocalFileTool', () => {
  it('creates a new file: same result, same create()/createFolder() calls', async () => {
    const oldApp = makeWriteApp(null)
    const newApp = makeWriteApp(null)
    const args = { path: 'docs/new.md', content: 'hello' }

    const oldResult = await callLocalFileTool({
      app: oldApp,
      toolName: 'fs_write',
      args,
    })
    const newResult = await fsWriteDefinition.execute(
      args,
      makeCtx({ app: newApp }),
    )

    expect(newResult).toEqual(oldResult)
    expect(newResult.status).toBe(ToolCallResponseStatus.Success)
    const payload = JSON.parse((newResult as { text: string }).text) as {
      results: Array<{ message: string }>
    }
    expect(payload.results[0]?.message).toBe('Created file.')
  })

  it('overwrites an existing file: same result', async () => {
    const existing = Object.assign(new TFile(), {
      path: 'docs/a.md',
      stat: { size: 10 },
    })
    const oldApp = makeWriteApp(existing)
    const newApp = makeWriteApp(existing)
    const args = { path: 'docs/a.md', content: 'new content' }

    const oldResult = await callLocalFileTool({
      app: oldApp,
      toolName: 'fs_write',
      args,
    })
    const newResult = await fsWriteDefinition.execute(
      args,
      makeCtx({ app: newApp }),
    )

    expect(newResult).toEqual(oldResult)
    const payload = JSON.parse((newResult as { text: string }).text) as {
      results: Array<{ message: string }>
    }
    expect(payload.results[0]?.message).toBe('Overwrote file.')
  })

  it('target path is an existing folder: same Error', async () => {
    const folder = Object.assign(new TFolder(), { path: 'docs', children: [] })
    const oldApp = makeWriteApp(folder)
    const newApp = makeWriteApp(folder)
    const args = { path: 'docs', content: 'x' }

    const oldResult = await callLocalFileTool({
      app: oldApp,
      toolName: 'fs_write',
      args,
    })
    expect(oldResult.status).toBe(ToolCallResponseStatus.Error)

    await expect(
      fsWriteDefinition.execute(args, makeCtx({ app: newApp })),
    ).rejects.toThrow('Path is a folder, cannot overwrite as a file: docs')
  })

  it('content exceeding MAX_FILE_SIZE_BYTES: same Error', async () => {
    const oldApp = makeWriteApp(null)
    const newApp = makeWriteApp(null)
    const args = { path: 'docs/big.md', content: 'x'.repeat(3 * 1024 * 1024) }

    const oldResult = await callLocalFileTool({
      app: oldApp,
      toolName: 'fs_write',
      args,
    })
    expect(oldResult.status).toBe(ToolCallResponseStatus.Error)

    await expect(
      fsWriteDefinition.execute(args, makeCtx({ app: newApp })),
    ).rejects.toThrow(/Content too large/)
  })
})

describe('executeBuiltinTool (dispatcher) vs callLocalFileTool end-to-end: fs_edit / fs_write', () => {
  it('matches for a successful fs_edit call', async () => {
    const file = makeEditFile('note.md')
    const args = { path: 'note.md', oldText: 'world', newText: 'there' }

    const oldResult = await callLocalFileTool({
      app: makeEditApp('hello world', file),
      toolName: 'fs_edit',
      args,
    })
    const newResult = await executeBuiltinTool(
      'fs_edit',
      args,
      makeCtx({ app: makeEditApp('hello world', file) }),
    )

    expect(newResult).toEqual(oldResult)
  })

  it('matches for a successful fs_write call', async () => {
    const args = { path: 'docs/new.md', content: 'hello' }

    const oldResult = await callLocalFileTool({
      app: makeWriteApp(null),
      toolName: 'fs_write',
      args,
    })
    const newResult = await executeBuiltinTool(
      'fs_write',
      args,
      makeCtx({ app: makeWriteApp(null) }),
    )

    expect(newResult).toEqual(oldResult)
  })

  it('matches for a rejected fs_edit review, end-to-end through the dispatcher', async () => {
    const file = makeEditFile('note.md')
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onComplete?.({
        finalContent: 'hello world',
        review: {
          totalChanges: 1,
          rejectedChanges: [
            { index: 1, originalText: 'world', proposedText: 'changed' },
          ],
        },
      })
      return true
    })
    const args = { path: 'note.md', oldText: 'world', newText: 'changed' }

    const oldResult = await callLocalFileTool({
      app: makeEditApp('hello world', file),
      openApplyReview,
      toolName: 'fs_edit',
      args,
      requireReview: true,
    })
    const newResult = await executeBuiltinTool(
      'fs_edit',
      args,
      makeCtx({
        app: makeEditApp('hello world', file),
        openApplyReview,
        requireReview: true,
      }),
    )

    expect(newResult).toEqual(oldResult)
  })

  it('matches the workspace-scope rejection for both tools', async () => {
    const workspaceScope: AssistantWorkspaceScope = {
      enabled: true,
      include: ['Notes'],
      exclude: [],
    }

    for (const [toolName, args] of [
      ['fs_edit', { path: 'secret/a.md', oldText: 'x', newText: 'y' }],
      ['fs_write', { path: 'secret/new.md', content: 'leak' }],
    ] as const) {
      const oldResult = await callLocalFileTool({
        app: {} as App,
        toolName,
        args,
        workspaceScope,
      })
      const newResult = await executeBuiltinTool(
        toolName,
        args,
        makeCtx({ workspaceScope }),
      )

      expect(newResult).toEqual(oldResult)
      expect(oldResult.status).toBe(ToolCallResponseStatus.Error)
    }
  })
})

describe('fs_edit / fs_write static schema (getMcpTool)', () => {
  it('matches the still-live getLocalFileTools() projection (drift guard)', () => {
    const liveTools = getLocalFileTools()

    const liveFsEdit = liveTools.find((tool) => tool.name === 'fs_edit')
    expect(liveFsEdit).toBeDefined()
    const { name: _n1, ...liveFsEditRest } = liveFsEdit!
    expect(fsEditDefinition.getMcpTool({})).toEqual(liveFsEditRest)

    const liveFsWrite = liveTools.find((tool) => tool.name === 'fs_write')
    expect(liveFsWrite).toBeDefined()
    const { name: _n2, ...liveFsWriteRest } = liveFsWrite!
    expect(fsWriteDefinition.getMcpTool({})).toEqual(liveFsWriteRest)
  })
})
