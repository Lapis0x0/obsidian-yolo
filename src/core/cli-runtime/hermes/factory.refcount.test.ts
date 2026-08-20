import type { App } from 'obsidian'

import { createHermesRuntimeFactory } from './factory'

// Unlike `factory.test.ts`, this file keeps `../acp/host`'s real
// `AcpHostPool`/`AcpHost` (only `AcpCliRuntime` is mocked, purely to capture
// the options object the factory builds). A mocked pool can't demonstrate a
// reference-counting leak — its `acquire`/`release` are bare `jest.fn()`s
// with no bookkeeping of their own, so `factory.test.ts`'s assertions on
// *how many times* `pool.release` was called can never actually prove a
// process got reclaimed. This file proves it end to end: real refcounting,
// real (never-connected, so dispose() needs no live process) `AcpHost`
// instances.
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
  resolveHost: () => Promise<{ dispose: () => Promise<void> }>
  sessionRecovery?: {
    resolveHost: () => Promise<{ dispose: () => Promise<void> }>
  }
  releaseHost?: () => void
}

describe('createHermesRuntimeFactory ref-count leak regression (real AcpHostPool)', () => {
  beforeEach(() => {
    AcpCliRuntimeMock.mockClear()
  })

  it('disposes the shared default-profile host once releaseHost() gives back both references acquired for it', async () => {
    // The conversation's own profile *is* already "default" — the most
    // common case for a single-profile user — so `resolveHost()` (primary)
    // and `sessionRecovery.resolveHost()` (fallback, triggered here to
    // simulate a resumed session recovering) both acquire the exact same
    // pool key. Pre-fix, `releaseHost()` tracked acquired keys in a `Set`
    // and released each distinct key only once, leaking one reference here
    // and keeping the Hermes subprocess alive forever.
    const factory = await createHermesRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    factory.create({ app, vaultPath: '/vault' }) // no profileId -> 'default'
    const options = AcpCliRuntimeMock.mock.calls[0][1] as CapturedRuntimeOptions

    const primaryHost = await options.resolveHost()
    const fallbackHost = await options.sessionRecovery!.resolveHost()
    // Confirms the premise: both calls really did resolve to the same
    // pooled `AcpHost` instance (same key), not merely equal-looking ones.
    expect(fallbackHost).toBe(primaryHost)

    const disposeSpy = jest
      .spyOn(primaryHost, 'dispose')
      .mockResolvedValue(undefined)

    options.releaseHost!()

    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('only releases what this runtime instance itself acquired, leaving a separate holder of the same key untouched', async () => {
    const factory = await createHermesRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    // Two independent conversation surfaces, both on the default profile —
    // e.g. two Hermes conversations open at once, neither ever hitting
    // recovery. Both end up sharing the same pooled 'default' host.
    factory.create({ app, vaultPath: '/vault' })
    factory.create({ app, vaultPath: '/vault' })
    const optionsA = AcpCliRuntimeMock.mock
      .calls[0][1] as CapturedRuntimeOptions
    const optionsB = AcpCliRuntimeMock.mock
      .calls[1][1] as CapturedRuntimeOptions

    const hostA = await optionsA.resolveHost()
    const hostB = await optionsB.resolveHost()
    expect(hostB).toBe(hostA)

    const disposeSpy = jest.spyOn(hostA, 'dispose').mockResolvedValue(undefined)

    // Only A's single acquisition should be given back — B's own reference
    // (and thus the shared host) must survive.
    optionsA.releaseHost!()

    expect(disposeSpy).not.toHaveBeenCalled()
  })
})
