import type { App } from 'obsidian'

import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'

import { createGrokRuntimeFactory } from './factory'
import { resolveGrokCommand } from './resolve-command'

jest.mock('../cli-path-override', () => ({
  getCliPathOverride: jest.fn(() => '/configured/grok'),
}))
jest.mock('../login-shell-env', () => ({
  loadLoginShellEnvironment: jest.fn(async () => ({ PATH: '/usr/bin' })),
}))
jest.mock('./resolve-command', () => ({
  resolveGrokCommand: jest.fn(async () => ({
    command: '/bin/grok',
    args: [
      '--no-auto-update',
      '--permission-mode',
      'default',
      'agent',
      '--no-leader',
      'stdio',
    ],
  })),
}))

type HostPoolInstance = {
  createOptions: (key: string) => unknown
  acquire: jest.Mock
  release: jest.Mock
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

const app = {} as App

type CapturedRuntimeOptions = {
  cwd: string
  resolveHost: () => Promise<unknown>
  releaseHost: () => void
}

describe('createGrokRuntimeFactory', () => {
  beforeEach(() => {
    hostPoolInstances.length = 0
    AcpHostPoolMock.mockClear()
    AcpCliRuntimeMock.mockClear()
    jest.mocked(getCliPathOverride).mockClear()
    jest.mocked(loadLoginShellEnvironment).mockClear()
    jest.mocked(resolveGrokCommand).mockClear()
  })

  it('resolves the official ACP command for the vault on every host spawn', async () => {
    await createGrokRuntimeFactory({ app, vaultPath: '/vault' })
    const pool = hostPoolInstances[0]
    const hostOptions = pool.createOptions('default') as {
      runtimeId: string
      clientName: string
      resolveProcessOptions: () => Promise<unknown>
      selectAuthMethod: (init: {
        authMethods?: Array<{ id: string; name: string }>
      }) => string
    }

    await expect(hostOptions.resolveProcessOptions()).resolves.toEqual({
      command: '/bin/grok',
      args: [
        '--no-auto-update',
        '--permission-mode',
        'default',
        'agent',
        '--no-leader',
        'stdio',
      ],
      cwd: '/vault',
      env: { XAI_API_KEY: '', GROK_API_KEY: '' },
    })
    expect(hostOptions.runtimeId).toBe('grok')
    expect(hostOptions.clientName).toBe('obsidian-yolo')
    expect(jest.mocked(getCliPathOverride)).toHaveBeenCalledWith(app, 'grok')
    expect(jest.mocked(resolveGrokCommand)).toHaveBeenCalledWith(
      { PATH: '/usr/bin' },
      process.platform,
      '/configured/grok',
    )
    expect(
      hostOptions.selectAuthMethod({
        authMethods: [{ id: 'cached_token', name: 'Cached token' }],
      }),
    ).toBe('cached_token')
  })

  it('creates a Grok runtime backed by one acquired host and releases it on dispose', async () => {
    const factory = await createGrokRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    const pool = hostPoolInstances[0]

    factory.create({ app, vaultPath: '/vault' })
    const [runtimeId, options] = AcpCliRuntimeMock.mock.calls[0] as unknown as [
      string,
      CapturedRuntimeOptions,
    ]
    expect(runtimeId).toBe('grok')
    expect(options.cwd).toBe('/vault')
    expect(await options.resolveHost()).toEqual({ __hostFor: 'default' })
    expect(await options.resolveHost()).toEqual({ __hostFor: 'default' })
    expect(pool.acquire).toHaveBeenCalledTimes(1)

    options.releaseHost()
    options.releaseHost()
    expect(pool.release).toHaveBeenCalledTimes(1)
    expect(pool.release).toHaveBeenCalledWith('default')
  })

  it('disposes the shared host pool', async () => {
    const factory = await createGrokRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    await factory.dispose?.()
    expect(hostPoolInstances[0].dispose).toHaveBeenCalledTimes(1)
  })
})
