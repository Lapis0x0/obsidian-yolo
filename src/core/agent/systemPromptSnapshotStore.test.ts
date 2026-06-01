import {
  SystemPromptSnapshot,
  SystemPromptSnapshotStore,
} from './systemPromptSnapshotStore'

const makeSnapshot = (text: string): SystemPromptSnapshot => ({
  systemSections: [{ bucket: 'system', id: 'system.x', content: text }],
  systemContent: text,
})

describe('SystemPromptSnapshotStore', () => {
  it('create mode: builds once on miss, then reuses the frozen snapshot for the same fingerprint', async () => {
    const store = new SystemPromptSnapshotStore()
    const build = jest.fn(async () => makeSnapshot('v1'))

    const first = await store.getOrCreate('conv-1', 'fp-1', build, {
      reuseOnly: false,
    })
    const second = await store.getOrCreate(
      'conv-1',
      'fp-1',
      // a different build result proves the cached one is returned, not rebuilt
      async () => makeSnapshot('v2-should-not-be-used'),
      { reuseOnly: false },
    )

    expect(build).toHaveBeenCalledTimes(1)
    expect(first.systemContent).toBe('v1')
    expect(second.systemContent).toBe('v1')
    expect(second).toBe(first)
  })

  it('create mode: a fingerprint change is a miss and refreshes the snapshot', async () => {
    const store = new SystemPromptSnapshotStore()

    const a = await store.getOrCreate(
      'conv-1',
      'fp-1',
      async () => makeSnapshot('v1'),
      { reuseOnly: false },
    )
    const b = await store.getOrCreate(
      'conv-1',
      'fp-2',
      async () => makeSnapshot('v2'),
      { reuseOnly: false },
    )

    expect(a.systemContent).toBe('v1')
    expect(b.systemContent).toBe('v2')
  })

  it('reuse mode: builds fresh on miss but does NOT write, so a later create still builds', async () => {
    const store = new SystemPromptSnapshotStore()
    const reuseBuild = jest.fn(async () => makeSnapshot('estimate'))
    const createBuild = jest.fn(async () => makeSnapshot('real'))

    const estimate = await store.getOrCreate('conv-1', 'fp-1', reuseBuild, {
      reuseOnly: true,
    })
    expect(estimate.systemContent).toBe('estimate')
    expect(reuseBuild).toHaveBeenCalledTimes(1)

    // The estimate must not have frozen anything ahead of the real request.
    const real = await store.getOrCreate('conv-1', 'fp-1', createBuild, {
      reuseOnly: false,
    })
    expect(createBuild).toHaveBeenCalledTimes(1)
    expect(real.systemContent).toBe('real')
  })

  it('reuse mode: reuses an already-frozen snapshot without rebuilding', async () => {
    const store = new SystemPromptSnapshotStore()
    await store.getOrCreate(
      'conv-1',
      'fp-1',
      async () => makeSnapshot('real'),
      {
        reuseOnly: false,
      },
    )

    const reuseBuild = jest.fn(async () => makeSnapshot('estimate'))
    const result = await store.getOrCreate('conv-1', 'fp-1', reuseBuild, {
      reuseOnly: true,
    })

    expect(reuseBuild).not.toHaveBeenCalled()
    expect(result.systemContent).toBe('real')
  })

  it('keeps snapshots isolated per conversationId', async () => {
    const store = new SystemPromptSnapshotStore()

    const a = await store.getOrCreate(
      'conv-a',
      'fp-1',
      async () => makeSnapshot('a'),
      { reuseOnly: false },
    )
    const b = await store.getOrCreate(
      'conv-b',
      'fp-1',
      async () => makeSnapshot('b'),
      { reuseOnly: false },
    )

    expect(a.systemContent).toBe('a')
    expect(b.systemContent).toBe('b')
  })

  it('evict drops a conversation snapshot so the next request rebuilds', async () => {
    const store = new SystemPromptSnapshotStore()
    const build = jest.fn(async () => makeSnapshot('v1'))

    await store.getOrCreate('conv-1', 'fp-1', build, { reuseOnly: false })
    store.evict('conv-1')
    await store.getOrCreate('conv-1', 'fp-1', build, { reuseOnly: false })

    expect(build).toHaveBeenCalledTimes(2)
  })

  it('create mode: coalesces concurrent misses for the same key onto one build', async () => {
    const store = new SystemPromptSnapshotStore()
    let resolveBuild: (snapshot: SystemPromptSnapshot) => void = () => {}
    const build = jest.fn(
      () =>
        new Promise<SystemPromptSnapshot>((resolve) => {
          resolveBuild = resolve
        }),
    )

    // Two real requests race on the same (conversation, fingerprint), e.g. a
    // multi-model compare run.
    const p1 = store.getOrCreate('conv-1', 'fp-1', build, { reuseOnly: false })
    const p2 = store.getOrCreate('conv-1', 'fp-1', build, { reuseOnly: false })
    expect(build).toHaveBeenCalledTimes(1)

    resolveBuild(makeSnapshot('frozen'))
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
    expect(r1.systemContent).toBe('frozen')
  })

  it('does not write back a snapshot whose conversation was evicted mid-build', async () => {
    const store = new SystemPromptSnapshotStore()
    let resolveBuild: (snapshot: SystemPromptSnapshot) => void = () => {}
    const build = jest.fn(
      () =>
        new Promise<SystemPromptSnapshot>((resolve) => {
          resolveBuild = resolve
        }),
    )

    const pending = store.getOrCreate('conv-1', 'fp-1', build, {
      reuseOnly: false,
    })
    // Conversation cleared/deleted while the build is still in flight.
    store.evict('conv-1')
    resolveBuild(makeSnapshot('stale'))
    await pending

    // The stale build must not have been committed; the next request rebuilds.
    const rebuild = jest.fn(async () => makeSnapshot('fresh'))
    const result = await store.getOrCreate('conv-1', 'fp-1', rebuild, {
      reuseOnly: false,
    })
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(result.systemContent).toBe('fresh')
  })
})
