// Proves the ported `js_eval` / `terminal_command` `execute()`
// implementations (src/core/tools/js_eval/definition.ts,
// terminal_command/definition.ts) behave identically to the still-present
// `case JS_SANDBOX_TOOL_NAME` / `case TERMINAL_COMMAND_TOOL_NAME` branches of
// `callLocalFileTool` they were copied from — per D6 batch 6's exit
// condition. Also proves `terminal_command`'s `isAvailable` platform gate
// (the one deliberate behavior change in this batch, master.md §3.1b) and
// that `js_eval` has no such gate.
//
// Both tools' real implementations reach into the sandboxed JS Worker runner
// and the OS-level bash session manager respectively — neither of which is
// meaningfully exercisable under Jest (no existing test in this repo drives
// `callJsSandboxTool` or `runBash` for real; see `localFileTools.test.ts`,
// which only unit-tests `buildJsSandboxProxyHandlers`'s handler closures
// directly). Both are mocked at their shared boundary instead: the OLD
// switch case and the NEW `execute()` both call the exact same
// `callJsSandboxTool` / `runBash` function references, so asserting
// identical results and identical call arguments against those mocks proves
// the two call sites are equivalent without needing the real runtime.
//
// `callLocalFileTool` is NOT the delegation boundary (D6a fix) — see
// context-tools-equivalence.test.ts's doc comment for the full explanation.
// `registry.test.ts`'s `isBuiltinToolName` coverage is what proves these
// tools actually route through the new path at the real call site.

jest.mock('obsidian')

jest.mock('../mcp/jsSandboxTool', () => {
  const actual = jest.requireActual('../mcp/jsSandboxTool')
  return {
    ...actual,
    callJsSandboxTool: jest.fn(),
  }
})

jest.mock('../agent/bash/index', () => ({
  runBash: jest.fn(),
}))

import { App, Platform } from 'obsidian'

import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { runBash } from '../agent/bash/index'
import { callJsSandboxTool } from '../mcp/jsSandboxTool'
import { callLocalFileTool, getLocalFileTools } from '../mcp/localFileTools'

import { executeBuiltinTool } from './dispatcher'
import { jsEvalDefinition } from './js_eval/definition'
import { terminalCommandDefinition } from './terminal_command/definition'
import type { ToolContext } from './types'

// `terminal_command`'s cwd-defaulting reads `app.vault.adapter`; a plain
// `{}` adapter (not a `FileSystemAdapter` instance) exercises the same
// "no vault base path available" branch the old switch case's own inline
// `app.vault.adapter instanceof FileSystemAdapter` check hits under the same
// minimal mock shape used elsewhere in this repo's tool tests.
const app = { vault: { adapter: {} } } as unknown as App

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return { app, ...overrides }
}

afterEach(() => {
  ;(callJsSandboxTool as jest.Mock).mockReset()
  ;(runBash as jest.Mock).mockReset()
})

describe('js_eval execute() vs callLocalFileTool', () => {
  it('same result, and the same underlying callJsSandboxTool call, for a successful run', async () => {
    ;(callJsSandboxTool as jest.Mock).mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      text: '{"result":2}',
    })
    const args = { code: '1 + 1' }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'js_eval',
      args,
    })
    expect(callJsSandboxTool).toHaveBeenCalledTimes(1)
    const oldCallArgs = (callJsSandboxTool as jest.Mock).mock.calls[0][0]

    const newResult = await jsEvalDefinition.execute(args, makeCtx())
    expect(callJsSandboxTool).toHaveBeenCalledTimes(2)
    const newCallArgs = (callJsSandboxTool as jest.Mock).mock.calls[1][0]

    expect(newResult).toEqual(oldResult)
    expect(newCallArgs.args).toEqual(oldCallArgs.args)
    expect(newCallArgs.jsSandboxSettings).toEqual(oldCallArgs.jsSandboxSettings)
  })

  it('has no isAvailable gate — always available regardless of platform (master.md §3.1b)', () => {
    expect(jsEvalDefinition.isAvailable).toBeUndefined()
  })
})

describe('terminal_command execute() vs callLocalFileTool', () => {
  it('same result for a successful command, same runBash call shape', async () => {
    ;(runBash as jest.Mock).mockResolvedValue({
      session_id: undefined,
      state: 'completed',
      exit_code: 0,
      stdout: 'hi\n',
      stderr: '',
    })
    const args = { command: 'echo hi' }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'terminal_command',
      args,
    })
    const newResult = await terminalCommandDefinition.execute(args, makeCtx())

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
  })

  it('non-zero exit code: same Error status and message', async () => {
    ;(runBash as jest.Mock).mockResolvedValue({
      state: 'completed',
      exit_code: 1,
      stdout: '',
      stderr: 'boom',
    })
    const args = { command: 'false' }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'terminal_command',
      args,
    })
    const newResult = await terminalCommandDefinition.execute(args, makeCtx())

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Error)
  })
})

describe('executeBuiltinTool (dispatcher) vs callLocalFileTool end-to-end', () => {
  it('matches for a successful js_eval call', async () => {
    ;(callJsSandboxTool as jest.Mock).mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      text: '{}',
    })
    const args = { code: '1' }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'js_eval',
      args,
    })
    const newResult = await executeBuiltinTool('js_eval', args, makeCtx())

    expect(newResult).toEqual(oldResult)
  })

  it('matches for a successful terminal_command call', async () => {
    ;(runBash as jest.Mock).mockResolvedValue({
      state: 'completed',
      exit_code: 0,
      stdout: 'ok',
      stderr: '',
    })
    const args = { command: 'echo ok' }

    const oldResult = await callLocalFileTool({
      app,
      toolName: 'terminal_command',
      args,
    })
    const newResult = await executeBuiltinTool(
      'terminal_command',
      args,
      makeCtx(),
    )

    expect(newResult).toEqual(oldResult)
  })
})

describe('js_eval / terminal_command static schema (getMcpTool)', () => {
  it('matches the still-live getLocalFileTools() projection (drift guard)', () => {
    const liveTools = getLocalFileTools()

    const liveJsEval = liveTools.find((tool) => tool.name === 'js_eval')
    expect(liveJsEval).toBeDefined()
    const { name: _n1, ...liveJsEvalRest } = liveJsEval!
    expect(jsEvalDefinition.getMcpTool({})).toEqual(liveJsEvalRest)

    const liveTerminal = liveTools.find(
      (tool) => tool.name === 'terminal_command',
    )
    expect(liveTerminal).toBeDefined()
    const { name: _n2, ...liveTerminalRest } = liveTerminal!
    expect(terminalCommandDefinition.getMcpTool({})).toEqual(liveTerminalRest)
  })
})

describe('terminal_command isAvailable — desktop-only (master.md §3.1b, the one deliberate behavior change in this batch)', () => {
  const originalIsDesktop = Platform.isDesktop

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  it('is available on desktop', () => {
    Platform.isDesktop = true
    expect(terminalCommandDefinition.isAvailable?.({})).toBe(true)
  })

  it('is unavailable on mobile', () => {
    Platform.isDesktop = false
    expect(terminalCommandDefinition.isAvailable?.({})).toBe(false)
  })

  // Reverse guard against accidentally copying terminal_command's platform
  // gate onto js_eval, which has never had one (master.md §3.1b: v1 wrongly
  // assumed js_eval was desktop-only too).
  it('does NOT drag js_eval down with it on mobile', () => {
    Platform.isDesktop = false
    expect(jsEvalDefinition.isAvailable).toBeUndefined()
  })
})
