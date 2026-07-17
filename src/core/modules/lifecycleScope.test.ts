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
})
