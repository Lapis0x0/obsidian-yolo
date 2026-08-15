// Proves the ported `bash` `execute()` implementation
// (src/core/tools/bash/definition.ts) behaves identically to the still-present
// `case BASH_TOOL_NAME` branch of `callLocalFileTool` it was copied from —
// per D6 batch 7's exit condition (the last D6 batch: js_eval / terminal_command
// closed batch 6, this closes the set).
//
// Three things this batch's task brief calls out get direct coverage here:
//   1. All three approval tiers (`full_access` / `require_approval` /
//      `dangerous_only`) and the `dangerous_only` mid-script interception —
//      mirrors `localFileTools.test.ts`'s `describe('bash tool dispatch', ...)`
//      suite one-for-one against the new `execute()`.
//   2. Workspace-scope enforcement at the filesystem layer (master.md §5):
//      `bash`'s only argument is an opaque `command` string, so there is no
//      path literal for the dispatcher's parameter-level
//      `findPathOutsideScope` scan to see — enforcement happens inside
//      `createVaultBashFileSystem`, called with `(app, workspaceScope,
//      settings)` from both the old switch case and the new `execute()`.
//      Rather than re-deriving `vaultBashFileSystem.test.ts`'s own extensive
//      scope-enforcement coverage (483 lines), this file proves both call
//      sites hand that function (and `createVaultBashSearch`) *identical*
//      arguments for identical inputs — which is what "the boundary still
//      applies after the move" actually requires.
//   3. `getMcpTool()` matches the still-live `getLocalFileTools()` projection
//      (drift guard), gated the same way that array gates it —
//      `isRuntimeComponentEnabled('bash-engine')`.
//
// `callLocalFileTool` is NOT the delegation boundary (D6a fix) — see
// context-tools-equivalence.test.ts's doc comment for the full explanation.
// `registry.test.ts`'s `isBuiltinToolName('bash')` coverage is what proves
// this tool actually routes through the new path at the real call site.

jest.mock('obsidian')

import { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import {
  getPendingDangerousBashApproval,
  resolveDangerousBashApproval,
} from '../agent/bash/dangerousOperationGate'
import * as vaultBashFileSystemModule from '../agent/bash/vaultBashFileSystem'
import * as vaultBashSearchModule from '../agent/bash/vaultBashSearch'
import { callLocalFileTool, getLocalFileTools } from '../mcp/localFileTools'
import type {
  RuntimeComponentId,
  RuntimeComponentLease,
} from '../runtime-components/contracts'
import {
  setRuntimeComponentAcquirerForTests,
  setRuntimeComponentEnabledOverrideForTests,
} from '../runtime-components/runtimeComponentAccess'

import { bashDefinition } from './bash/definition'
import { executeBuiltinTool } from './dispatcher'
import type { ToolContext } from './types'

const app = { vault: {}, fileManager: {} } as unknown as App

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return { app, ...overrides }
}

// Mirrors `localFileTools.test.ts`'s `mockBashEngine` helper exactly — both
// suites must stub the `bash-engine` runtime component the same way so a
// real behavioral drift between the old switch case and the new `execute()`
// can't hide behind differently-shaped mocks.
const mockBashEngine = (
  execImpl: (
    command: string,
    confirm: (
      kind: 'rm' | 'mv',
      targets: readonly string[],
    ) => Promise<boolean>,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
) => {
  let capturedConfirm:
    | ((kind: 'rm' | 'mv', targets: readonly string[]) => Promise<boolean>)
    | undefined
  const dispose = jest.fn()
  const release = jest.fn()
  setRuntimeComponentAcquirerForTests(
    async <I extends RuntimeComponentId>(
      id: I,
    ): Promise<RuntimeComponentLease<I>> => {
      if (id !== 'bash-engine') throw new Error('Unexpected component')
      const api = {
        createSession: jest.fn().mockImplementation((options) => {
          capturedConfirm = options.confirmDangerousOperation
          return {
            exec: (command: string) =>
              execImpl(command, options.confirmDangerousOperation),
            dispose,
          }
        }),
        dispose: async () => undefined,
      }
      return { api, release } as unknown as RuntimeComponentLease<I>
    },
  )
  return {
    release,
    dispose,
    getCapturedConfirm: () => capturedConfirm,
  }
}

afterEach(() => {
  setRuntimeComponentAcquirerForTests(null)
  setRuntimeComponentEnabledOverrideForTests(null)
  jest.restoreAllMocks()
})

describe('bash execute() vs callLocalFileTool', () => {
  it('same result for a successful command', async () => {
    mockBashEngine(async (command) => {
      expect(command).toBe('ls')
      return { stdout: 'a.md\nb.md\n', stderr: '', exitCode: 0 }
    })
    const oldResult = await callLocalFileTool({
      app,
      toolName: 'bash',
      args: { command: 'ls' },
      toolCallId: 'call-1',
    })

    mockBashEngine(async (command) => {
      expect(command).toBe('ls')
      return { stdout: 'a.md\nb.md\n', stderr: '', exitCode: 0 }
    })
    const newResult = await bashDefinition.execute(
      { command: 'ls' },
      makeCtx({ toolCallId: 'call-1' }),
    )

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
  })

  it('non-zero exit code: still Success status (bash reports exit_code inside the JSON payload, unlike terminal_command)', async () => {
    mockBashEngine(async () => ({
      stdout: '',
      stderr: 'boom',
      exitCode: 1,
    }))
    const oldResult = await callLocalFileTool({
      app,
      toolName: 'bash',
      args: { command: 'false' },
      toolCallId: 'call-err',
    })

    mockBashEngine(async () => ({
      stdout: '',
      stderr: 'boom',
      exitCode: 1,
    }))
    const newResult = await bashDefinition.execute(
      { command: 'false' },
      makeCtx({ toolCallId: 'call-err' }),
    )

    expect(newResult).toEqual(oldResult)
    expect(oldResult.status).toBe(ToolCallResponseStatus.Success)
    if (oldResult.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(JSON.parse(oldResult.text)).toMatchObject({ exit_code: 1 })
  })

  it('never pauses for confirmation under full_access', async () => {
    mockBashEngine(async (command, confirm) => {
      const approved = await confirm('rm', ['/vault/a.md'])
      expect(approved).toBe(true)
      return { stdout: '', stderr: '', exitCode: 0 }
    })

    const result = await bashDefinition.execute(
      { command: 'rm a.md' },
      makeCtx({ toolCallId: 'call-full', bashApprovalMode: 'full_access' }),
    )

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(getPendingDangerousBashApproval('call-full')).toBeNull()
  })

  it('never pauses for confirmation under require_approval (the whole call was already gated)', async () => {
    mockBashEngine(async (command, confirm) => {
      const approved = await confirm('mv', ['/vault/a.md -> /vault/b.md'])
      expect(approved).toBe(true)
      return { stdout: '', stderr: '', exitCode: 0 }
    })

    const result = await bashDefinition.execute(
      { command: 'mv a.md b.md' },
      makeCtx({
        toolCallId: 'call-require',
        bashApprovalMode: 'require_approval',
      }),
    )

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(getPendingDangerousBashApproval('call-require')).toBeNull()
  })

  it('pauses mid-script for rm/mv under dangerous_only and resumes once approved', async () => {
    const { getCapturedConfirm } = mockBashEngine(async (command, confirm) => {
      const approved = await confirm('rm', ['/vault/a.md'])
      return {
        stdout: approved ? 'removed' : '',
        stderr: approved ? '' : 'operation denied by user',
        exitCode: approved ? 0 : 1,
      }
    })

    const resultPromise = bashDefinition.execute(
      { command: 'rm a.md' },
      makeCtx({
        toolCallId: 'call-dangerous',
        bashApprovalMode: 'dangerous_only',
      }),
    )

    await Promise.resolve()
    await Promise.resolve()

    const pending = getPendingDangerousBashApproval('call-dangerous')
    expect(pending).toMatchObject({ kind: 'rm', targets: ['/vault/a.md'] })
    expect(getCapturedConfirm()).toBeDefined()

    resolveDangerousBashApproval('call-dangerous', pending!.requestId, true)

    const result = await resultPromise
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(JSON.parse(result.text)).toMatchObject({
      exit_code: 0,
      stdout: 'removed',
    })
  })

  it('denying a dangerous operation returns a nonzero exit code without failing the tool call', async () => {
    mockBashEngine(async (command, confirm) => {
      const approved = await confirm('rm', ['/vault/a.md'])
      return {
        stdout: '',
        stderr: approved ? '' : 'operation denied by user',
        exitCode: approved ? 0 : 1,
      }
    })

    const resultPromise = bashDefinition.execute(
      { command: 'rm a.md' },
      makeCtx({
        toolCallId: 'call-denied',
        bashApprovalMode: 'dangerous_only',
      }),
    )

    await Promise.resolve()
    await Promise.resolve()
    const pending = getPendingDangerousBashApproval('call-denied')
    resolveDangerousBashApproval('call-denied', pending!.requestId, false)

    const result = await resultPromise
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const payload = JSON.parse(result.text) as {
      exit_code: number
      stderr: string
    }
    expect(payload.exit_code).toBe(1)
    expect(payload.stderr).toContain('operation denied by user')
  })

  it('fails closed (denies) when there is no toolCallId to attach an approval card to', async () => {
    mockBashEngine(async (command, confirm) => {
      const approved = await confirm('rm', ['/vault/a.md'])
      expect(approved).toBe(false)
      return { stdout: '', stderr: '', exitCode: approved ? 0 : 1 }
    })

    const result = await bashDefinition.execute(
      { command: 'rm a.md' },
      // toolCallId intentionally omitted.
      makeCtx({ bashApprovalMode: 'dangerous_only' }),
    )

    expect(result.status).toBe(ToolCallResponseStatus.Success)
  })

  it('passes readOnly through to the bash-engine session when bashReadOnly is set', async () => {
    let createSessionOptions: { readOnly?: boolean } | undefined
    setRuntimeComponentAcquirerForTests(
      async <I extends RuntimeComponentId>(
        id: I,
      ): Promise<RuntimeComponentLease<I>> => {
        if (id !== 'bash-engine') throw new Error('Unexpected component')
        const api = {
          createSession: jest.fn().mockImplementation((options) => {
            createSessionOptions = options
            return {
              exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
              dispose: jest.fn(),
            }
          }),
          dispose: async () => undefined,
        }
        return {
          api,
          release: jest.fn(),
        } as unknown as RuntimeComponentLease<I>
      },
    )

    await bashDefinition.execute(
      { command: 'ls' },
      makeCtx({ toolCallId: 'call-ro', bashReadOnly: true }),
    )

    expect(createSessionOptions?.readOnly).toBe(true)
  })

  it('defaults readOnly to false when bashReadOnly is not set', async () => {
    let createSessionOptions: { readOnly?: boolean } | undefined
    setRuntimeComponentAcquirerForTests(
      async <I extends RuntimeComponentId>(
        id: I,
      ): Promise<RuntimeComponentLease<I>> => {
        if (id !== 'bash-engine') throw new Error('Unexpected component')
        const api = {
          createSession: jest.fn().mockImplementation((options) => {
            createSessionOptions = options
            return {
              exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
              dispose: jest.fn(),
            }
          }),
          dispose: async () => undefined,
        }
        return {
          api,
          release: jest.fn(),
        } as unknown as RuntimeComponentLease<I>
      },
    )

    await bashDefinition.execute(
      { command: 'ls' },
      makeCtx({ toolCallId: 'call-rw' }),
    )

    expect(createSessionOptions?.readOnly).toBe(false)
  })
})

describe('executeBuiltinTool (dispatcher) vs callLocalFileTool end-to-end', () => {
  it('matches for a successful bash call', async () => {
    mockBashEngine(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }))
    const oldResult = await callLocalFileTool({
      app,
      toolName: 'bash',
      args: { command: 'echo ok' },
      toolCallId: 'call-e2e',
    })

    mockBashEngine(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }))
    const newResult = await executeBuiltinTool(
      'bash',
      { command: 'echo ok' },
      makeCtx({ toolCallId: 'call-e2e' }),
    )

    expect(newResult).toEqual(oldResult)
  })
})

describe('bash static schema (getMcpTool)', () => {
  it('matches the still-live getLocalFileTools() projection (drift guard)', () => {
    // `getLocalFileTools()` only includes `bash` when the runtime component
    // is enabled — the same gate `bash-engine`'s real listing check uses.
    setRuntimeComponentEnabledOverrideForTests(() => true)

    const liveTools = getLocalFileTools()
    const liveBash = liveTools.find((tool) => tool.name === 'bash')
    expect(liveBash).toBeDefined()
    const { name: _name, ...liveBashRest } = liveBash!
    expect(bashDefinition.getMcpTool({})).toEqual(liveBashRest)
  })

  it('has no isAvailable gate at this layer (see bash/definition.ts for why)', () => {
    expect(bashDefinition.isAvailable).toBeUndefined()
  })
})

describe('bash workspace scope — filesystem-layer enforcement threads through identically (master.md §5)', () => {
  it('createVaultBashFileSystem and createVaultBashSearch receive identical arguments from the old switch case and the new execute()', async () => {
    const fsSpy = jest.spyOn(
      vaultBashFileSystemModule,
      'createVaultBashFileSystem',
    )
    const searchSpy = jest.spyOn(vaultBashSearchModule, 'createVaultBashSearch')
    const workspaceScope = {
      enabled: true,
      include: ['Notes'],
      exclude: [],
    }
    const settings = { yolo: { baseDir: 'YOLO' } } as unknown as YoloSettings

    mockBashEngine(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    await callLocalFileTool({
      app,
      toolName: 'bash',
      args: { command: 'ls' },
      toolCallId: 'call-scope-old',
      workspaceScope,
      settings,
    })

    mockBashEngine(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    await bashDefinition.execute(
      { command: 'ls' },
      makeCtx({
        toolCallId: 'call-scope-new',
        workspaceScope,
        settings,
      }),
    )

    expect(fsSpy).toHaveBeenCalledTimes(2)
    expect(fsSpy.mock.calls[1]).toEqual(fsSpy.mock.calls[0])
    expect(fsSpy.mock.calls[0]).toEqual([app, workspaceScope, settings])

    expect(searchSpy).toHaveBeenCalledTimes(2)
    const [oldSearchArgs] = searchSpy.mock.calls[0]
    const [newSearchArgs] = searchSpy.mock.calls[1]
    expect(newSearchArgs).toEqual(oldSearchArgs)
    expect(oldSearchArgs).toMatchObject({ app, settings, workspaceScope })
  })
})
