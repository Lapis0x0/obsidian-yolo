import type { App } from 'obsidian'

import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'

import { createHermesRuntimeFactory } from './factory'
import { resolveHermesCommand } from './resolve-command'

jest.mock('../cli-path-override', () => ({
  getCliPathOverride: jest.fn(() => '/configured/hermes'),
}))
jest.mock('../login-shell-env', () => ({
  loadLoginShellEnvironment: jest.fn(async () => ({ PATH: '/usr/bin' })),
}))
jest.mock('./resolve-command', () => ({
  resolveHermesCommand: jest.fn(
    async (
      _env: unknown,
      _platform: unknown,
      _override: unknown,
      profileId: string,
    ) => ({
      command: `/bin/hermes-${profileId}`,
      args: ['-p', profileId, 'acp'],
    }),
  ),
}))

type HostPoolInstance = {
  createOptions: (key: string) => unknown
  acquire: jest.Mock
  release: jest.Mock
  warm: jest.Mock
  dispose: jest.Mock
}
const hostPoolInstances: HostPoolInstance[] = []
const AcpHostPoolMock = jest.fn(function (
  this: HostPoolInstance,
  createOptions: (key: string) => unknown,
) {
  this.createOptions = createOptions
  this.acquire = jest.fn(async (key: string) => ({ __hostFor: key }))
  this.release = jest.fn()
  this.warm = jest.fn(async () => undefined)
  this.dispose = jest.fn(async () => undefined)
  hostPoolInstances.push(this)
})
jest.mock('../acp/host', () => ({
  get AcpHostPool() {
    return AcpHostPoolMock
  },
}))

const AcpCliRuntimeMock = jest.fn(function (
  this: { runtimeId: string; options: unknown },
  runtimeId: string,
  options: unknown,
) {
  this.runtimeId = runtimeId
  this.options = options
})
jest.mock('../acp/AcpCliRuntime', () => ({
  get AcpCliRuntime() {
    return AcpCliRuntimeMock
  },
}))

const mockedGetCliPathOverride = jest.mocked(getCliPathOverride)
const mockedLoadLoginShellEnvironment = jest.mocked(loadLoginShellEnvironment)
const mockedResolveHermesCommand = jest.mocked(resolveHermesCommand)

const app = {} as App

type CapturedRuntimeOptions = {
  cwd: string
  resolveHost: () => Promise<unknown>
  sessionRecovery?: { resolveHost: () => Promise<unknown> }
  releaseHost?: () => void
  compactCommand?: string
}

describe('createHermesRuntimeFactory', () => {
  beforeEach(() => {
    hostPoolInstances.length = 0
    AcpHostPoolMock.mockClear()
    AcpCliRuntimeMock.mockClear()
    mockedGetCliPathOverride.mockClear()
    mockedLoadLoginShellEnvironment.mockClear()
    mockedResolveHermesCommand.mockClear()
  })

  it('constructs one shared host pool up front', async () => {
    await createHermesRuntimeFactory({ app, vaultPath: '/vault' })
    expect(hostPoolInstances).toHaveLength(1)
  })

  it('keys the pool by the create-time profileId, defaulting to "default" when absent', async () => {
    const factory = await createHermesRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    const pool = hostPoolInstances[0]

    factory.create({ app, vaultPath: '/vault', profileId: 'work' })
    factory.create({ app, vaultPath: '/vault' })

    const [withProfile, withoutProfile] = AcpCliRuntimeMock.mock
      .calls as unknown as [string, CapturedRuntimeOptions][]
    await withProfile[1].resolveHost()
    await withoutProfile[1].resolveHost()

    expect(pool.acquire).toHaveBeenNthCalledWith(1, 'work')
    expect(pool.acquire).toHaveBeenNthCalledWith(2, 'default')
  })

  it('resolves per-key launch args through resolveHermesCommand, forwarding the profile id', async () => {
    const factory = await createHermesRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    const pool = hostPoolInstances[0]

    const options = pool.createOptions('research') as {
      resolveProcessOptions: () => Promise<unknown>
    }
    await expect(options.resolveProcessOptions()).resolves.toEqual({
      command: '/bin/hermes-research',
      args: ['-p', 'research', 'acp'],
      cwd: '/vault',
    })
    expect(mockedResolveHermesCommand).toHaveBeenCalledWith(
      { PATH: '/usr/bin' },
      process.platform,
      '/configured/hermes',
      'research',
    )
    expect(mockedGetCliPathOverride).toHaveBeenCalledWith(app, 'hermes')

    void factory
  })

  it("wires sessionRecovery to the default profile's host, distinct from the conversation's own profile", async () => {
    const factory = await createHermesRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    const pool = hostPoolInstances[0]

    factory.create({ app, vaultPath: '/vault', profileId: 'work' })
    const options = AcpCliRuntimeMock.mock.calls[0][1] as CapturedRuntimeOptions

    const primaryHost = await options.resolveHost()
    const fallbackHost = await options.sessionRecovery!.resolveHost()

    expect(pool.acquire).toHaveBeenNthCalledWith(1, 'work')
    expect(pool.acquire).toHaveBeenNthCalledWith(2, 'default')
    expect(primaryHost).not.toBe(fallbackHost)
  })

  it('releaseHost() releases every pool key this runtime actually acquired, including a triggered fallback', async () => {
    const factory = await createHermesRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    const pool = hostPoolInstances[0]

    factory.create({ app, vaultPath: '/vault', profileId: 'work' })
    const options = AcpCliRuntimeMock.mock.calls[0][1] as CapturedRuntimeOptions

    await options.resolveHost()
    await options.sessionRecovery!.resolveHost()
    options.releaseHost!()

    expect(pool.release).toHaveBeenCalledWith('work')
    expect(pool.release).toHaveBeenCalledWith('default')
    expect(pool.release).toHaveBeenCalledTimes(2)
  })

  it('releaseHost() only releases what was actually acquired when sessionRecovery never fires', async () => {
    const factory = await createHermesRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    const pool = hostPoolInstances[0]

    factory.create({ app, vaultPath: '/vault', profileId: 'work' })
    const options = AcpCliRuntimeMock.mock.calls[0][1] as CapturedRuntimeOptions

    await options.resolveHost()
    options.releaseHost!()

    expect(pool.release).toHaveBeenCalledTimes(1)
    expect(pool.release).toHaveBeenCalledWith('work')
  })

  it('warm() always warms the default profile', async () => {
    const factory = await createHermesRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    const pool = hostPoolInstances[0]

    await factory.warm?.()
    expect(pool.warm).toHaveBeenCalledWith('default')
  })

  it('dispose() tears down the whole shared pool', async () => {
    const factory = await createHermesRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    const pool = hostPoolInstances[0]

    await factory.dispose?.()
    expect(pool.dispose).toHaveBeenCalledTimes(1)
  })
})
