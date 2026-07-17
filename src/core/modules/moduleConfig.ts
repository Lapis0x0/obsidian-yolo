import type { ModuleLifecycleScope } from './lifecycleScope'
import type { ModuleDataEnvelope } from './moduleSettingsStore'
import { assertModuleId } from './moduleStore'
import type { ModuleDisposer } from './types'

export type ModuleConfigSnapshot<T = unknown> = ModuleDataEnvelope<T>

export type ModuleConfigBackend<T = unknown> = Readonly<{
  read(): Promise<ModuleConfigSnapshot<T>>
  write(next: ModuleConfigSnapshot<T>): Promise<void>
  subscribe(listener: () => void): ModuleDisposer
}>

export type ModuleConfigV1<T = unknown> = Readonly<{
  getSnapshot(): ModuleConfigSnapshot<T>
  replace(next: ModuleConfigSnapshot<T>): Promise<ModuleConfigSnapshot<T>>
  subscribe(listener: () => void): ModuleDisposer
}>

export type ModuleConfigCapabilityActivationV1<T = unknown> = Readonly<{
  api: ModuleConfigV1<T>
  activate(): Promise<void>
}>

export type ModuleConfigCapabilityProviderOptions<T = unknown> = Readonly<{
  createBackend(moduleId: string): ModuleConfigBackend<T>
  reportCallbackError?: (moduleId: string, error: unknown) => void
}>

const MAX_ACTIVATION_READS = 100

/**
 * A lifecycle-scoped view of one module's configuration document.
 *
 * The injected backend owns the mapping from module id to host settings. This
 * capability intentionally does not expose arbitrary core settings.
 */
export class ModuleConfigCapabilityProvider<T = unknown> {
  constructor(
    private readonly options: ModuleConfigCapabilityProviderOptions<T>,
  ) {}

  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleConfigCapabilityActivationV1<T> {
    assertModuleId(moduleId, 'Module id')
    const backend = this.options.createBackend(moduleId)
    let state: 'inactive' | 'activating' | 'active' | 'disposed' = 'inactive'
    let snapshot: ModuleConfigSnapshot<T> | undefined
    let unsubscribeBackend: ModuleDisposer | undefined
    let backendGeneration = 0
    let queue = Promise.resolve()
    const listeners = new Set<() => void>()
    const isDisposed = (): boolean => state === 'disposed'

    const reportCallbackError = (error: unknown): void => {
      try {
        this.options.reportCallbackError?.(moduleId, error)
      } catch {
        // Reporting failures must not cross the module boundary.
      }
    }
    const assertActive = (): void => {
      if (state !== 'active') {
        throw new Error(`Module "${moduleId}" config is unavailable`)
      }
    }
    const publish = (next: ModuleConfigSnapshot<T>): void => {
      if (state !== 'active') return
      const changed = canonicalSnapshot(next) !== canonicalSnapshot(snapshot)
      snapshot = next
      if (!changed) return
      for (const listener of [...listeners]) {
        if (state !== 'active') break
        try {
          listener()
        } catch (error) {
          reportCallbackError(error)
        }
      }
    }
    const enqueue = <R>(operation: () => Promise<R>): Promise<R> => {
      const result = queue.catch(() => undefined).then(operation)
      queue = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }
    const refresh = (): void => {
      if (state === 'activating') {
        backendGeneration += 1
        return
      }
      if (state !== 'active') return
      void enqueue(async () => {
        if (state !== 'active') return
        const next = cloneAndFreezeSnapshot<T>(await backend.read())
        publish(next)
      }).catch(reportCallbackError)
    }

    lifecycle.add(() => {
      state = 'disposed'
      listeners.clear()
      const unsubscribe = unsubscribeBackend
      unsubscribeBackend = undefined
      unsubscribe?.()
    })

    const api: ModuleConfigV1<T> = Object.freeze({
      getSnapshot: () => {
        assertActive()
        return snapshot!
      },
      replace: (next) => {
        assertActive()
        const ownedNext = cloneAndFreezeSnapshot<T>(next)
        return enqueue(async () => {
          assertActive()
          await backend.write(ownedNext)
          assertActive()
          const persisted = cloneAndFreezeSnapshot<T>(await backend.read())
          assertActive()
          publish(persisted)
          return persisted
        })
      },
      subscribe: (listener) => {
        assertActive()
        if (typeof listener !== 'function') {
          throw new TypeError('Module config listener must be a function')
        }
        listeners.add(listener)
        let subscribed = true
        return () => {
          if (!subscribed) return
          subscribed = false
          listeners.delete(listener)
        }
      },
    })

    return Object.freeze({
      api,
      activate: async () => {
        if (state !== 'inactive') {
          throw new Error(`Module "${moduleId}" config cannot be activated`)
        }
        state = 'activating'
        try {
          unsubscribeBackend = backend.subscribe(refresh)
          let initial: ModuleConfigSnapshot<T> | undefined
          let stable = false
          for (let reads = 0; reads < MAX_ACTIVATION_READS; reads += 1) {
            const generationBeforeRead = backendGeneration
            initial = cloneAndFreezeSnapshot<T>(await backend.read())
            if (backendGeneration === generationBeforeRead) {
              stable = true
              break
            }
          }
          if (!stable) {
            throw new Error(
              `Module "${moduleId}" config did not stabilize during activation`,
            )
          }
          if (isDisposed()) {
            throw new Error(`Module "${moduleId}" config is unavailable`)
          }
          snapshot = initial!
          state = 'active'
        } catch (error) {
          if (!isDisposed()) state = 'inactive'
          const unsubscribe = unsubscribeBackend
          unsubscribeBackend = undefined
          unsubscribe?.()
          throw error
        }
      },
    })
  }
}

function cloneAndFreezeSnapshot<T>(value: unknown): ModuleConfigSnapshot<T> {
  assertPlainObject(value, 'Config snapshot')
  const names = Object.getOwnPropertyNames(value)
  if (
    names.length !== 2 ||
    !names.includes('schemaVersion') ||
    !names.includes('data')
  ) {
    throw new TypeError(
      'Config snapshot must contain only schemaVersion and data',
    )
  }
  const schemaVersion = readDataProperty(value, 'schemaVersion')
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) {
    throw new TypeError('Config schemaVersion must be a positive safe integer')
  }
  const data = cloneJson(readDataProperty(value, 'data'), new Set()) as T
  return Object.freeze({ schemaVersion: schemaVersion as number, data })
}

function cloneJson(value: unknown, active: Set<object>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('JSON numbers must be finite')
    return value
  }
  if (typeof value !== 'object') {
    throw new TypeError('Config data must contain only plain JSON values')
  }
  if (active.has(value))
    throw new TypeError('Config data must not contain cycles')
  active.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Config arrays must have the ordinary prototype')
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError('Config arrays must not have symbol properties')
      }
      const names = Object.getOwnPropertyNames(value)
      if (
        names.length !== value.length + 1 ||
        !names.includes('length') ||
        !Array.from({ length: value.length }, (_, index) =>
          names.includes(String(index)),
        ).every(Boolean)
      ) {
        throw new TypeError(
          'Config arrays must not be sparse or have properties',
        )
      }
      const clone: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        clone.push(cloneJson(readDataProperty(value, String(index)), active))
      }
      return Object.freeze(clone)
    }
    assertPlainObject(value, 'Config object')
    const clone: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(value)) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneJson(readDataProperty(value, key), active),
      })
    }
    return Object.freeze(clone)
  } finally {
    active.delete(value)
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is object {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new TypeError(`${label} must be a plain object`)
  }
}

function readDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`Config property "${key}" must be a data property`)
  }
  return descriptor.value
}

function canonicalSnapshot(value: ModuleConfigSnapshot | undefined): string {
  if (!value) return ''
  return `${String(value.schemaVersion)}:${canonicalJson(value.data)}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    const entries: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      entries.push(
        Object.prototype.hasOwnProperty.call(value, index)
          ? `v${canonicalJson(value[index])}`
          : 'h',
      )
    }
    return `[${entries.join(',')}]`
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`
}
