import { ModuleCleanupError, ModuleLifecycleScope } from './lifecycleScope'

describe('ModuleLifecycleScope', () => {
  it('disposes resources in LIFO order and only once', () => {
    const calls: number[] = []
    const scope = new ModuleLifecycleScope()
    scope.add(() => calls.push(1))
    scope.add(() => calls.push(2))

    scope.dispose()
    scope.dispose()

    expect(calls).toEqual([2, 1])
  })

  it('rolls back only resources staged by a failed activation', () => {
    const calls: string[] = []
    const scope = new ModuleLifecycleScope()
    scope.add(() => calls.push('existing'))

    expect(() =>
      scope.activate((lifecycle) => {
        lifecycle.add(() => calls.push('first'))
        lifecycle.add(() => calls.push('second'))
        throw new Error('activation failed')
      }),
    ).toThrow('activation failed')
    expect(calls).toEqual(['second', 'first'])

    scope.dispose()
    expect(calls).toEqual(['second', 'first', 'existing'])
  })

  it('attempts every cleanup and reports disposal failures', () => {
    const calls: string[] = []
    const scope = new ModuleLifecycleScope()
    scope.add(() => {
      calls.push('first')
      throw new Error('first failed')
    })
    scope.add(() => calls.push('second'))

    expect(() => scope.dispose()).toThrow(ModuleCleanupError)
    expect(calls).toEqual(['second', 'first'])
  })

  it('rejects resources added after disposal', () => {
    const scope = new ModuleLifecycleScope()
    scope.dispose()
    expect(() => scope.add(() => undefined)).toThrow(
      'disposed module lifecycle',
    )
  })

  it('reports asynchronous cleanup as a contract violation', () => {
    const scope = new ModuleLifecycleScope()
    scope.add(async () => undefined)
    expect(() => scope.dispose()).toThrow('disposal reported errors')
  })

  it('awaits whenActive callbacks in registration order and owns their disposers', async () => {
    const calls: string[] = []
    const scope = new ModuleLifecycleScope()
    scope.whenActive(async () => {
      calls.push('first:start')
      await Promise.resolve()
      calls.push('first:end')
      scope.add(() => calls.push('first:dispose'))
    })
    scope.whenActive(() => {
      calls.push('second')
      scope.add(() => calls.push('second:dispose'))
    })

    scope.closeWhenActiveRegistration()
    await scope.runWhenActiveCallbacks(() => false)
    expect(calls).toEqual(['first:start', 'first:end', 'second'])

    scope.dispose()
    expect(calls).toEqual([
      'first:start',
      'first:end',
      'second',
      'second:dispose',
      'first:dispose',
    ])
  })

  it('fails closed for late registration and repeated callback activation', async () => {
    const scope = new ModuleLifecycleScope()
    scope.whenActive(() => undefined)
    scope.closeWhenActiveRegistration()

    expect(() => scope.whenActive(() => undefined)).toThrow(
      'can only be registered during module activation',
    )
    await scope.runWhenActiveCallbacks(() => false)
    await expect(scope.runWhenActiveCallbacks(() => false)).rejects.toThrow(
      'cannot be activated',
    )
    scope.dispose()
  })

  it('stops before the next whenActive callback when cancelled', async () => {
    const scope = new ModuleLifecycleScope()
    const calls: string[] = []
    let cancelled = false
    scope.whenActive(() => {
      calls.push('first')
      cancelled = true
    })
    scope.whenActive(() => {
      calls.push('second')
    })
    scope.closeWhenActiveRegistration()

    await expect(scope.runWhenActiveCallbacks(() => cancelled)).rejects.toThrow(
      'activation was cancelled',
    )
    expect(calls).toEqual(['first'])
    scope.dispose()
  })

  it('waits for registered quiescence once before disposal', async () => {
    const scope = new ModuleLifecycleScope()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const quiesce = jest.fn(() => pending)
    scope.onQuiesce(quiesce)
    scope.closeWhenActiveRegistration()
    await scope.runWhenActiveCallbacks(() => false)

    const first = scope.quiesce()
    const second = scope.quiesce()
    expect(quiesce).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([first, second])
    scope.dispose()
  })
})
