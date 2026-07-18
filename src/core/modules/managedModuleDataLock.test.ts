import {
  ManagedModuleDataLockDisposedError,
  ManagedModuleDataLockOwner,
  managedModuleDataNamespace,
  runExclusive,
} from './managedModuleDataLock'

function deferred(): {
  promise: Promise<void>
  resolve(): void
} {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('managed module data lock', () => {
  it('runs same-namespace operations fairly and releases after errors', async () => {
    const vaultIdentity = {}
    const gate = deferred()
    const order: string[] = []
    const first = runExclusive(vaultIdentity, 'shared', async () => {
      order.push('first:start')
      await gate.promise
      order.push('first:end')
    })
    const second = runExclusive(vaultIdentity, 'shared', () => {
      order.push('second')
      throw new Error('failed')
    })
    const third = runExclusive(vaultIdentity, 'shared', () => {
      order.push('third')
      return 3
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    gate.resolve()
    await first
    await expect(second).rejects.toThrow('failed')
    await expect(third).resolves.toBe(3)
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third'])
  })

  it('allows different namespaces to run concurrently', async () => {
    const vaultIdentity = {}
    const gate = deferred()
    const started: string[] = []
    const first = runExclusive(vaultIdentity, 'one', async () => {
      started.push('one')
      await gate.promise
    })
    const second = runExclusive(vaultIdentity, 'two', () => {
      started.push('two')
    })

    await Promise.resolve()
    expect(started).toEqual(['one', 'two'])
    gate.resolve()
    await Promise.all([first, second])
  })

  it('rejects queued owner work on dispose while letting running work finish', async () => {
    const owner = new ManagedModuleDataLockOwner({})
    const gate = deferred()
    const running = owner.runExclusive('shared', () => gate.promise)
    const queued = owner.runExclusive('shared', () => 'never')

    await Promise.resolve()
    owner.dispose()
    await expect(queued).rejects.toBeInstanceOf(
      ManagedModuleDataLockDisposedError,
    )
    gate.resolve()
    await expect(running).resolves.toBeUndefined()
    await expect(owner.runExclusive('shared', () => 1)).rejects.toBeInstanceOf(
      ManagedModuleDataLockDisposedError,
    )
  })

  it('defines the module-isolated namespace shared with Core', () => {
    expect(managedModuleDataNamespace('learning', 'srs')).toBe(
      'module/learning/srs',
    )
    expect(() => managedModuleDataNamespace('learning', '../srs')).toThrow(
      'namespace',
    )
    expect(() => runExclusive({}, 'learning//srs', () => undefined)).toThrow(
      'namespace',
    )
  })
})
