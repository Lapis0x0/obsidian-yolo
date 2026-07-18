import type { ModuleIntent, ModuleIntentStore } from './moduleIntentStore'
import type { ModuleManager } from './moduleManager'
import { assertModuleId } from './moduleStore'

export type ModuleIntentCoordinatorOptions = Readonly<{
  store: Pick<ModuleIntentStore, 'get' | 'set'>
  manager: Pick<ModuleManager, 'refresh'>
}>

export class ModuleIntentOperationError extends Error {
  readonly operationError: unknown
  readonly refreshError: unknown

  constructor(
    moduleId: string,
    operationError: unknown,
    refreshError: unknown,
  ) {
    super(
      `Module intent operation for "${moduleId}" and manager refresh both failed`,
    )
    this.name = 'ModuleIntentOperationError'
    this.operationError = operationError
    this.refreshError = refreshError
  }
}

const EMPTY_INTENT: ModuleIntent = Object.freeze({
  desiredInstalled: false,
  enabled: false,
})
const coordinatorQueues = new WeakMap<object, Map<string, Promise<void>>>()

/** Coordinates user-facing changes to synchronized module intent. */
export class ModuleIntentCoordinator {
  private readonly queues: Map<string, Promise<void>>
  private disposed = false

  constructor(private readonly options: ModuleIntentCoordinatorOptions) {
    if (
      !options ||
      typeof options.store?.get !== 'function' ||
      typeof options.store?.set !== 'function' ||
      typeof options.manager?.refresh !== 'function'
    ) {
      throw new Error('Module intent coordinator options are invalid')
    }
    let queues = coordinatorQueues.get(options.store)
    if (!queues) {
      queues = new Map()
      coordinatorQueues.set(options.store, queues)
    }
    this.queues = queues
  }

  install(moduleId: string): Promise<ModuleIntent> {
    return this.update(moduleId, (current) => ({
      desiredInstalled: true,
      enabled: current.enabled,
    }))
  }

  enable(moduleId: string): Promise<ModuleIntent> {
    return this.update(moduleId, (current) => ({
      desiredInstalled: current.desiredInstalled,
      enabled: true,
    }))
  }

  disable(moduleId: string): Promise<ModuleIntent> {
    return this.update(moduleId, (current) => ({
      desiredInstalled: current.desiredInstalled,
      enabled: false,
    }))
  }

  uninstall(moduleId: string): Promise<ModuleIntent> {
    return this.update(moduleId, (current) => ({
      desiredInstalled: false,
      enabled: current.enabled,
    }))
  }

  dispose(): void {
    this.disposed = true
  }

  private update(
    moduleId: string,
    resolve: (current: ModuleIntent) => ModuleIntent,
  ): Promise<ModuleIntent> {
    if (this.disposed) return Promise.reject(disposedError())
    try {
      assertModuleId(moduleId, 'Module id')
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      )
    }

    const previous = this.queues.get(moduleId) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed) throw disposedError()
        return this.writeAndRefresh(moduleId, resolve)
      })
    const settled = operation.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(moduleId, settled)
    void settled.then(() => {
      if (this.queues.get(moduleId) === settled) this.queues.delete(moduleId)
    })
    return operation
  }

  private async writeAndRefresh(
    moduleId: string,
    resolve: (current: ModuleIntent) => ModuleIntent,
  ): Promise<ModuleIntent> {
    let result: ModuleIntent | undefined
    let operationError: unknown
    let operationFailed = false
    try {
      const current = (await this.options.store.get(moduleId)) ?? EMPTY_INTENT
      result = await this.options.store.set(moduleId, resolve(current))
    } catch (error) {
      operationFailed = true
      operationError = error
    }

    try {
      await this.options.manager.refresh()
    } catch (refreshError) {
      if (operationFailed) {
        throw new ModuleIntentOperationError(
          moduleId,
          operationError,
          refreshError,
        )
      }
      throw refreshError
    }

    if (operationFailed) throw operationError
    return result!
  }
}

function disposedError(): Error {
  return new Error('Module intent coordinator is disposed')
}
