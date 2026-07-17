import type { ModuleDisposer, YoloModuleLifecycle } from './types'

export class ModuleCleanupError extends Error {
  constructor(
    message: string,
    readonly errors: unknown[],
    readonly activationError?: unknown,
  ) {
    super(message)
    this.name = 'ModuleCleanupError'
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

/** Owns a module's synchronous resources and releases them in reverse order. */
export class ModuleLifecycleScope implements YoloModuleLifecycle {
  private disposers: ModuleDisposer[] = []
  private disposed = false

  add(disposer: ModuleDisposer): void {
    if (this.disposed) {
      throw new Error('Cannot add a disposer to a disposed module lifecycle')
    }
    if (typeof disposer !== 'function') {
      throw new TypeError('Module disposer must be a function')
    }
    this.disposers.push(disposer)
  }

  activate(activation: (lifecycle: YoloModuleLifecycle) => void): void {
    const checkpoint = this.disposers.length
    try {
      activation(this)
    } catch (activationError) {
      const errors = this.releaseFrom(checkpoint)
      if (errors.length > 0) {
        throw new ModuleCleanupError(
          'Module activation failed and rollback reported errors',
          errors,
          activationError,
        )
      }
      throw activationError
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const errors = this.releaseFrom(0)
    if (errors.length > 0) {
      throw new ModuleCleanupError(
        'Module lifecycle disposal reported errors',
        errors,
      )
    }
  }

  private releaseFrom(checkpoint: number): unknown[] {
    const errors: unknown[] = []
    while (this.disposers.length > checkpoint) {
      const disposer = this.disposers.pop()!
      try {
        const result: unknown = disposer()
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => undefined)
          errors.push(new Error('Module cleanup must be synchronous'))
        }
      } catch (error) {
        errors.push(error)
      }
    }
    return errors
  }
}
