import type { App } from 'obsidian'

import { getCliPathOverride } from '../cli-path-override'

import { createClaudeRuntimeFactory } from './factory'

jest.mock('../cli-path-override', () => ({
  getCliPathOverride: jest.fn(() => '/configured/claude'),
}))

const ClaudeCliRuntimeMock = jest.fn(function ClaudeCliRuntimeMock(
  this: unknown,
  options: unknown,
) {
  Object.assign(this as object, { options, runtimeId: 'claude-code' })
})

jest.mock('./ClaudeCliRuntime', () => ({
  get ClaudeCliRuntime() {
    return ClaudeCliRuntimeMock
  },
}))

const mockedGetCliPathOverride = jest.mocked(getCliPathOverride)

const app = {} as App

describe('createClaudeRuntimeFactory', () => {
  beforeEach(() => {
    ClaudeCliRuntimeMock.mockClear()
    mockedGetCliPathOverride.mockClear()
  })

  it('falls back to the device-local CLI path override when no options are supplied', async () => {
    const factory = await createClaudeRuntimeFactory({
      app,
      vaultPath: '/vault',
    })

    const runtime = factory.create({ app, vaultPath: '/vault/current' })

    expect(ClaudeCliRuntimeMock).toHaveBeenCalledTimes(1)
    const [options] = ClaudeCliRuntimeMock.mock.calls[0] as [
      { vaultPath: string; getConfiguredCliPath: () => string | undefined },
    ]
    expect(options.vaultPath).toBe('/vault/current')
    expect(options.getConfiguredCliPath()).toBe('/configured/claude')
    expect(mockedGetCliPathOverride).toHaveBeenCalledWith(app, 'claude-code')
    expect(runtime).toBeDefined()
  })

  it('uses the caller-supplied options verbatim, merged with the create-time vault path', async () => {
    const getConfiguredCliPath = () => '/bin/claude'
    const getClaudeRuntimeOptions = jest.fn(() => ({ getConfiguredCliPath }))
    const factory = await createClaudeRuntimeFactory({
      app,
      vaultPath: '/vault',
      getClaudeRuntimeOptions,
    })

    factory.create({ app, vaultPath: '/vault/current' })

    expect(getClaudeRuntimeOptions).toHaveBeenCalledTimes(1)
    expect(ClaudeCliRuntimeMock).toHaveBeenCalledWith({
      getConfiguredCliPath,
      vaultPath: '/vault/current',
    })
    expect(mockedGetCliPathOverride).not.toHaveBeenCalled()
  })

  it('re-reads the options getter on every create call', async () => {
    let callCount = 0
    const getClaudeRuntimeOptions = jest.fn(() => {
      callCount += 1
      return { getConfiguredCliPath: () => `/bin/claude-${callCount}` }
    })
    const factory = await createClaudeRuntimeFactory({
      app,
      vaultPath: '/vault',
      getClaudeRuntimeOptions,
    })

    factory.create({ app, vaultPath: '/vault' })
    factory.create({ app, vaultPath: '/vault' })

    expect(getClaudeRuntimeOptions).toHaveBeenCalledTimes(2)
  })

  it('has no warm or dispose hook — Claude Code owns no shared infrastructure', async () => {
    const factory = await createClaudeRuntimeFactory({
      app,
      vaultPath: '/vault',
    })

    expect(factory.warm).toBeUndefined()
    expect(factory.dispose).toBeUndefined()
  })
})
