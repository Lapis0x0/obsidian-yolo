import { AcpHost, type AcpHostOptions, AcpHostPool } from './host'

const createOptions = (key: string): AcpHostOptions => ({
  runtimeId: 'hermes',
  clientName: 'test',
  resolveProcessOptions: async () => ({
    command: `/bin/agent-${key}`,
    args: [],
    cwd: '/vault',
  }),
})

describe('AcpHostPool', () => {
  it('returns the same host for repeated acquires of the same key', async () => {
    const pool = new AcpHostPool(createOptions)
    const first = await pool.acquire('profile-a')
    const second = await pool.acquire('profile-a')
    expect(second).toBe(first)
  })

  it('returns distinct hosts for distinct keys', async () => {
    const pool = new AcpHostPool(createOptions)
    const a = await pool.acquire('profile-a')
    const b = await pool.acquire('profile-b')
    expect(a).not.toBe(b)
  })

  it('passes each key through to createOptions, so per-key launch args differ', async () => {
    const seenKeys: string[] = []
    const pool = new AcpHostPool((key) => {
      seenKeys.push(key)
      return createOptions(key)
    })
    await pool.acquire('profile-a')
    await pool.acquire('profile-b')
    // A second acquire of an already-created key must not re-create it.
    await pool.acquire('profile-a')
    expect(seenKeys).toEqual(['profile-a', 'profile-b'])
  })

  it('keeps a key alive while any reference is outstanding, disposing only once the last is released', async () => {
    const pool = new AcpHostPool(createOptions)
    const host = await pool.acquire('profile-a')
    await pool.acquire('profile-a') // second reference to the same key
    const disposeSpy = jest.spyOn(host, 'dispose').mockResolvedValue(undefined)

    pool.release('profile-a')
    expect(disposeSpy).not.toHaveBeenCalled()

    pool.release('profile-a')
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('creates a fresh host for a key once its previous host was fully released', async () => {
    const pool = new AcpHostPool(createOptions)
    const first = await pool.acquire('profile-a')
    jest.spyOn(first, 'dispose').mockResolvedValue(undefined)
    pool.release('profile-a')

    const second = await pool.acquire('profile-a')
    expect(second).not.toBe(first)
  })

  it('release() on a never-acquired or already-fully-released key is a no-op', async () => {
    const pool = new AcpHostPool(createOptions)
    expect(() => pool.release('never-acquired')).not.toThrow()

    const host = await pool.acquire('profile-a')
    jest.spyOn(host, 'dispose').mockResolvedValue(undefined)
    pool.release('profile-a')
    // Refcount is already at zero; a stray extra release must not go negative
    // and disturb a *later* acquire's accounting.
    expect(() => pool.release('profile-a')).not.toThrow()
    const next = await pool.acquire('profile-a')
    const nextDisposeSpy = jest
      .spyOn(next, 'dispose')
      .mockResolvedValue(undefined)
    pool.release('profile-a')
    expect(nextDisposeSpy).toHaveBeenCalledTimes(1)
  })

  it('two different profile keys never share or disturb each other while both are held', async () => {
    // Models two surfaces with different Hermes profiles open at once: one
    // surface releasing its own conversation must not affect the other's
    // still-live host.
    const pool = new AcpHostPool(createOptions)
    const a = await pool.acquire('profile-a')
    const b = await pool.acquire('profile-b')
    const disposeA = jest.spyOn(a, 'dispose').mockResolvedValue(undefined)
    const disposeB = jest.spyOn(b, 'dispose').mockResolvedValue(undefined)

    pool.release('profile-a')
    expect(disposeA).toHaveBeenCalledTimes(1)
    expect(disposeB).not.toHaveBeenCalled()
    expect(await pool.acquire('profile-b')).toBe(b)
  })

  it('dispose() tears down every pooled host regardless of outstanding refcounts', async () => {
    const pool = new AcpHostPool(createOptions)
    const a = await pool.acquire('profile-a')
    await pool.acquire('profile-a')
    const b = await pool.acquire('profile-b')
    const disposeA = jest.spyOn(a, 'dispose').mockResolvedValue(undefined)
    const disposeB = jest.spyOn(b, 'dispose').mockResolvedValue(undefined)

    await pool.dispose()

    expect(disposeA).toHaveBeenCalledTimes(1)
    expect(disposeB).toHaveBeenCalledTimes(1)
  })

  it('warm() readies a key without acquiring a reference, and does not dispose the process it just started', async () => {
    const ensureReadySpy = jest
      .spyOn(AcpHost.prototype, 'ensureReady')
      .mockResolvedValue(undefined)
    const disposeSpy = jest
      .spyOn(AcpHost.prototype, 'dispose')
      .mockResolvedValue(undefined)
    const pool = new AcpHostPool(createOptions)

    await pool.warm('profile-a')

    expect(ensureReadySpy).toHaveBeenCalledTimes(1)
    // The whole point of warming is to have the process already running and
    // connected by the time something actually needs it — disposing it the
    // instant warm() returns (the pre-fix behavior: acquire+release around
    // ensureReady) would defeat that. warm() must leave the host alive,
    // unowned, in the pool.
    expect(disposeSpy).not.toHaveBeenCalled()

    ensureReadySpy.mockRestore()
    disposeSpy.mockRestore()
  })

  it('a warmed host is reused (not re-created) by the first real acquire, and is disposed on that acquire being released', async () => {
    const ensureReadySpy = jest
      .spyOn(AcpHost.prototype, 'ensureReady')
      .mockResolvedValue(undefined)
    const pool = new AcpHostPool(createOptions)

    await pool.warm('profile-a')
    const acquired = await pool.acquire('profile-a')
    const disposeSpy = jest
      .spyOn(acquired, 'dispose')
      .mockResolvedValue(undefined)

    // warm() must not have already spent a reference: the first real
    // acquire() is what owns the host, and releasing that one reference is
    // enough to tear it down.
    pool.release('profile-a')
    expect(disposeSpy).toHaveBeenCalledTimes(1)

    ensureReadySpy.mockRestore()
    disposeSpy.mockRestore()
  })

  it('calling warm() again on an already-warmed key reuses the same host instead of starting a second process', async () => {
    const ensureReadySpy = jest
      .spyOn(AcpHost.prototype, 'ensureReady')
      .mockResolvedValue(undefined)
    const seenKeys: string[] = []
    const pool = new AcpHostPool((key) => {
      seenKeys.push(key)
      return createOptions(key)
    })

    await pool.warm('profile-a')
    await pool.warm('profile-a')

    expect(seenKeys).toEqual(['profile-a'])
    expect(ensureReadySpy).toHaveBeenCalledTimes(2)

    ensureReadySpy.mockRestore()
  })
})
