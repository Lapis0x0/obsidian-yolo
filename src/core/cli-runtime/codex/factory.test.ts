import type { App } from 'obsidian'

import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'

import { createCodexRuntimeFactory } from './factory'
import { resolveCodexLaunch } from './launch'

jest.mock('../cli-path-override', () => ({
  getCliPathOverride: jest.fn(() => '/configured/codex'),
}))
jest.mock('../login-shell-env', () => ({
  loadLoginShellEnvironment: jest.fn(async () => ({ PATH: '/usr/bin' })),
}))

let launchCallCount = 0
jest.mock('./launch', () => ({
  resolveCodexLaunch: jest.fn(async () => {
    launchCallCount += 1
    return {
      command: `/bin/codex-${launchCallCount}`,
      runtimeCwd: `/resolved/cwd-${launchCallCount}`,
      spawnCwd: `/resolved/spawn-${launchCallCount}`,
      mapRuntimePathToHost: undefined,
    }
  }),
}))

type HostPoolInstance = {
  options: unknown
  acquire: jest.Mock
  warm: jest.Mock
  dispose: jest.Mock
}
const hostPoolInstances: HostPoolInstance[] = []
const CodexAppServerHostPoolMock = jest.fn(function (
  this: HostPoolInstance,
  options: unknown,
) {
  this.options = options
  this.acquire = jest.fn(async () => ({}))
  this.warm = jest.fn(async () => undefined)
  this.dispose = jest.fn(async () => undefined)
  hostPoolInstances.push(this)
})
jest.mock('./host', () => ({
  get CodexAppServerHostPool() {
    return CodexAppServerHostPoolMock
  },
}))

const CodexCliRuntimeMock = jest.fn(function (
  this: { options: unknown; runtimeId: string },
  options: unknown,
) {
  this.options = options
  this.runtimeId = 'codex'
})
jest.mock('./runtime', () => ({
  get CodexCliRuntime() {
    return CodexCliRuntimeMock
  },
}))

const mockedGetCliPathOverride = jest.mocked(getCliPathOverride)
const mockedLoadLoginShellEnvironment = jest.mocked(loadLoginShellEnvironment)
const mockedResolveCodexLaunch = jest.mocked(resolveCodexLaunch)

const app = {} as App

describe('createCodexRuntimeFactory', () => {
  beforeEach(() => {
    launchCallCount = 0
    hostPoolInstances.length = 0
    CodexAppServerHostPoolMock.mockClear()
    CodexCliRuntimeMock.mockClear()
    mockedGetCliPathOverride.mockClear()
    mockedLoadLoginShellEnvironment.mockClear()
    mockedResolveCodexLaunch.mockClear()
  })

  it('auto-detects the launch command via the login-shell PATH when no options are supplied', async () => {
    const factory = await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
    })

    expect(mockedLoadLoginShellEnvironment).toHaveBeenCalledTimes(1)
    expect(mockedGetCliPathOverride).toHaveBeenCalledWith(app, 'codex')
    expect(mockedResolveCodexLaunch).toHaveBeenCalledWith(
      '/vault',
      { PATH: '/usr/bin' },
      process.platform,
      '/configured/codex',
    )
    // The host pool is constructed once, up front, from the resolved launch.
    expect(hostPoolInstances).toHaveLength(1)
    expect(hostPoolInstances[0]?.options).toMatchObject({
      command: '/bin/codex-1',
      cwd: '/resolved/cwd-1',
      spawnCwd: '/resolved/spawn-1',
    })

    const runtime = factory.create({ app, vaultPath: '/vault/current' })
    expect(CodexCliRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/bin/codex-1',
        // Resolved cwd wins over the create-time vault path.
        cwd: '/resolved/cwd-1',
        resolveHost: hostPoolInstances[0]?.acquire,
      }),
    )
    expect(runtime).toBeDefined()
  })

  it('uses caller-supplied options verbatim, falling back to the create-time vault path for cwd', async () => {
    const getCodexRuntimeOptions = jest.fn(() => ({ command: '/bin/codex' }))
    const factory = await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
      getCodexRuntimeOptions,
    })

    expect(mockedResolveCodexLaunch).not.toHaveBeenCalled()
    expect(hostPoolInstances[0]?.options).toMatchObject({
      command: '/bin/codex',
      cwd: '/vault',
    })

    factory.create({ app, vaultPath: '/vault/current' })
    expect(CodexCliRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/bin/codex',
        cwd: '/vault/current',
      }),
    )
  })

  it('keeps an explicit cwd from caller-supplied options over the create-time vault path', async () => {
    const getCodexRuntimeOptions = jest.fn(() => ({
      command: '/bin/codex',
      cwd: '/explicit/cwd',
    }))
    const factory = await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
      getCodexRuntimeOptions,
    })

    factory.create({ app, vaultPath: '/vault/current' })
    expect(CodexCliRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/explicit/cwd' }),
    )
  })

  it('delegates warm() and dispose() to the shared host pool', async () => {
    const factory = await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    const pool = hostPoolInstances[0]

    await factory.warm?.()
    expect(pool?.warm).toHaveBeenCalledTimes(1)

    await factory.dispose?.()
    expect(pool?.dispose).toHaveBeenCalledTimes(1)
  })

  it('re-resolves the launch on every host respawn via resolveProcessOptions', async () => {
    await createCodexRuntimeFactory({ app, vaultPath: '/vault' })

    const resolveProcessOptions = (
      hostPoolInstances[0]?.options as {
        resolveProcessOptions?: () => Promise<unknown>
      }
    ).resolveProcessOptions
    expect(resolveProcessOptions).toBeInstanceOf(Function)

    await expect(resolveProcessOptions?.()).resolves.toMatchObject({
      command: '/bin/codex-2',
      cwd: '/resolved/cwd-2',
    })
    expect(mockedResolveCodexLaunch).toHaveBeenCalledTimes(2)
  })

  it('has no resolveProcessOptions hook when the caller supplies its own options', async () => {
    await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
      getCodexRuntimeOptions: () => ({ command: '/bin/codex' }),
    })

    expect(
      (
        hostPoolInstances[0]?.options as {
          resolveProcessOptions?: () => Promise<unknown>
        }
      ).resolveProcessOptions,
    ).toBeUndefined()
  })
})
