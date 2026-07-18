import type { YoloModuleDefinition } from './types'

export type ModuleRuntimeReservationTarget = Readonly<{
  isActive(moduleId: string): boolean
  activate(
    definition: YoloModuleDefinition,
    version?: string,
    signal?: AbortSignal,
  ): Promise<void>
}>

export type ModuleRuntimeReservationOptions = Readonly<{
  runtime: ModuleRuntimeReservationTarget
}>

/** The narrow runtime surface consumed by ModuleUninstallCoordinator. */
export type ModuleRuntimeQuiescence = Readonly<{
  runWithModuleQuiesced<T>(
    moduleId: string,
    operation: () => Promise<T>,
  ): Promise<T>
}>

/**
 * Serializes activation and quiesced operations without owning the underlying
 * runtime. Every activation of a guarded runtime must pass through this gate.
 */
export class ModuleRuntimeReservation implements ModuleRuntimeQuiescence {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly pendingActivations = new Map<string, number>()
  private disposed = false

  constructor(private readonly options: ModuleRuntimeReservationOptions) {
    if (
      !options ||
      typeof options.runtime?.isActive !== 'function' ||
      typeof options.runtime?.activate !== 'function'
    ) {
      throw new Error('Module runtime reservation options are invalid')
    }
  }

  activate(
    definition: YoloModuleDefinition,
    version?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.disposed) return Promise.reject(disposedError())

    const moduleId = definition.id
    this.pendingActivations.set(
      moduleId,
      (this.pendingActivations.get(moduleId) ?? 0) + 1,
    )
    const activation = this.enqueue(moduleId, () =>
      this.options.runtime.activate(definition, version, signal),
    )
    return activation.finally(() => this.releaseActivation(moduleId))
  }

  runWithModuleQuiesced<T>(
    moduleId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(disposedError())
    if (typeof operation !== 'function') {
      return Promise.reject(
        new TypeError('Module quiesced operation must be a function'),
      )
    }

    try {
      this.assertQuiescent(moduleId)
    } catch (error) {
      return Promise.reject(toError(error))
    }

    return this.enqueue(moduleId, async () => {
      // Recheck after earlier quiesced work. This also closes the window for a
      // runtime that was activated outside the gate before this turn started.
      if (this.options.runtime.isActive(moduleId)) {
        throw activeModuleError(moduleId)
      }
      return operation()
    })
  }

  /**
   * Rejects new and queued work. An operation that has already entered keeps
   * its reservation until it settles; the underlying runtime is not disposed.
   */
  dispose(): void {
    this.disposed = true
  }

  private assertQuiescent(moduleId: string): void {
    if (this.options.runtime.isActive(moduleId)) {
      throw activeModuleError(moduleId)
    }
    if ((this.pendingActivations.get(moduleId) ?? 0) > 0) {
      throw new Error(
        `Module "${moduleId}" activation is pending and cannot be quiesced`,
      )
    }
  }

  private enqueue<T>(
    moduleId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(moduleId) ?? Promise.resolve()
    const result = previous.then(() => {
      if (this.disposed) throw disposedError()
      return operation()
    })
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(moduleId, tail)
    void tail.then(() => {
      if (this.queues.get(moduleId) === tail) this.queues.delete(moduleId)
    })
    return result
  }

  private releaseActivation(moduleId: string): void {
    const remaining = (this.pendingActivations.get(moduleId) ?? 1) - 1
    if (remaining === 0) this.pendingActivations.delete(moduleId)
    else this.pendingActivations.set(moduleId, remaining)
  }
}

function activeModuleError(moduleId: string): Error {
  return new Error(`Module "${moduleId}" is active and cannot be quiesced`)
}

function disposedError(): Error {
  return new Error('Module runtime reservation is disposed')
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
