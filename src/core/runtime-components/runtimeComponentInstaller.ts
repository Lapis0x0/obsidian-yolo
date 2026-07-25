import { type DataAdapter, normalizePath } from 'obsidian'

import { verifyModuleBytes } from '../modules/moduleIntegrity'

import {
  RuntimeComponentInstallError,
  isTransientRuntimeComponentError,
} from './runtimeComponentErrors'
import type { RuntimeComponentDescriptor } from './runtimeComponentManifest'
import { RuntimeComponentStore } from './runtimeComponentStore'

export type RuntimeComponentDownload = (request: {
  descriptor: RuntimeComponentDescriptor
  source: string
  signal?: AbortSignal
}) => Promise<Uint8Array>

const queues = new WeakMap<object, Map<string, Promise<void>>>()
let transaction = 0

export class RuntimeComponentInstaller {
  constructor(
    private readonly options: Readonly<{
      store: RuntimeComponentStore
      download: RuntimeComponentDownload
      resolveDownloadSources?: (
        descriptor: RuntimeComponentDescriptor,
      ) => readonly string[]
      subtleCrypto?: Pick<SubtleCrypto, 'digest'>
      reportCleanupError?: (error: unknown) => void
    }>,
  ) {}

  ensure(
    descriptor: RuntimeComponentDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    const subtle = this.options.subtleCrypto ?? globalThis.crypto?.subtle
    if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable')
    throwIfAborted(signal)
    return enqueue(
      this.options.store.adapter,
      `${this.options.store.rootPath()}\u0000${descriptor.id}`,
      () => this.ensureUnlocked(descriptor, subtle, signal),
    )
  }

  private async ensureUnlocked(
    descriptor: RuntimeComponentDescriptor,
    subtle: Pick<SubtleCrypto, 'digest'>,
    signal?: AbortSignal,
  ): Promise<void> {
    const staging = normalizePath(
      `${this.options.store.componentRoot(descriptor)}/.staging-${descriptor.sha256}`,
    )
    if (
      await this.options.store.adapter.exists(
        this.options.store.targetDir(descriptor),
      )
    ) {
      try {
        await this.verifyInstalled(descriptor, subtle)
        await this.cleanup(staging)
        return
      } catch {
        await this.repair(descriptor, subtle, signal)
        return
      }
    }

    await ensureDir(this.options.store.adapter, this.options.store.rootPath())
    await ensureDir(
      this.options.store.adapter,
      this.options.store.componentRoot(descriptor),
    )
    await removeDir(this.options.store.adapter, staging)
    await ensureDir(this.options.store.adapter, staging)
    try {
      const bytes = await this.downloadVerified(descriptor, subtle, signal)
      throwIfAborted(signal)
      await this.options.store.adapter.writeBinary(
        normalizePath(`${staging}/entry.js`),
        exactArrayBuffer(bytes),
      )
      await verifyPath(
        this.options.store.adapter,
        normalizePath(`${staging}/entry.js`),
        descriptor,
        subtle,
      )
      if (
        await this.options.store.adapter.exists(
          this.options.store.targetDir(descriptor),
        )
      ) {
        await this.verifyInstalled(descriptor, subtle)
        return
      }
      await this.options.store.adapter.rename(
        staging,
        this.options.store.targetDir(descriptor),
      )
      await this.verifyInstalled(descriptor, subtle)
    } finally {
      await this.cleanup(staging)
    }
  }

  private async repair(
    descriptor: RuntimeComponentDescriptor,
    subtle: Pick<SubtleCrypto, 'digest'>,
    signal?: AbortSignal,
  ): Promise<void> {
    const adapter = this.options.store.adapter
    const id = `${Date.now()}-${transaction++}`
    const root = this.options.store.componentRoot(descriptor)
    const target = this.options.store.targetDir(descriptor)
    const staging = normalizePath(`${root}/.repair-staging-${id}`)
    const backup = normalizePath(`${root}/.repair-backup-${id}`)
    await removeDir(adapter, staging)
    await removeDir(adapter, backup)
    await ensureDir(adapter, staging)
    let backupOwned = false
    let promoted = false
    try {
      const bytes = await this.downloadVerified(descriptor, subtle, signal)
      await adapter.writeBinary(
        normalizePath(`${staging}/entry.js`),
        exactArrayBuffer(bytes),
      )
      await verifyPath(
        adapter,
        normalizePath(`${staging}/entry.js`),
        descriptor,
        subtle,
      )
      throwIfAborted(signal)
      if (await adapter.exists(target)) {
        await adapter.rename(target, backup)
        if (!(await adapter.exists(backup))) {
          throw new Error('Runtime component backup promotion was not visible')
        }
        backupOwned = true
      }
      await adapter.rename(staging, target)
      promoted = await adapter.exists(target)
      if (!promoted)
        throw new Error('Runtime component promotion was not visible')
      await this.verifyInstalled(descriptor, subtle)
      await this.cleanup(backup)
      backupOwned = false
    } catch (error) {
      if (backupOwned) {
        try {
          if (await adapter.exists(target)) await removeDir(adapter, target)
          await adapter.rename(backup, target)
          backupOwned = false
        } catch (rollbackError) {
          this.reportCleanup(rollbackError)
        }
      }
      throw error
    } finally {
      if (!promoted) await this.cleanup(staging)
      if (backupOwned) await this.cleanup(backup)
    }
  }

  private async downloadVerified(
    descriptor: RuntimeComponentDescriptor,
    subtle: Pick<SubtleCrypto, 'digest'>,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    throwIfAborted(signal)
    const sources = this.options.resolveDownloadSources?.(descriptor) ?? [
      descriptor.entry,
    ]
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      sources.some((source) => typeof source !== 'string' || !source) ||
      new Set(sources).size !== sources.length
    ) {
      throw new Error('Runtime component download sources are invalid')
    }
    const failures: string[] = []
    let hasTransientFailure = false
    for (const source of sources) {
      throwIfAborted(signal)
      try {
        const bytes = await this.options.download({
          descriptor,
          source,
          ...(signal ? { signal } : {}),
        })
        throwIfAborted(signal)
        if (!(bytes instanceof Uint8Array)) {
          throw new TypeError(
            'Runtime component download must return Uint8Array',
          )
        }
        if (bytes.byteLength !== descriptor.byteSize) {
          throw new Error(
            `Runtime component "${descriptor.id}" byte size mismatch`,
          )
        }
        await verifyModuleBytes(
          bytes,
          descriptor,
          `Runtime component "${descriptor.id}"`,
          subtle,
        )
        return bytes
      } catch (error) {
        if (signal?.aborted) throw error
        hasTransientFailure ||= isTransientRuntimeComponentError(error)
        failures.push(`${sourceName(source)}: ${describeError(error)}`)
      }
    }
    throw new RuntimeComponentInstallError(
      descriptor.id,
      hasTransientFailure,
      failures,
    )
  }

  async verifyInstalled(
    descriptor: RuntimeComponentDescriptor,
    subtle = this.options.subtleCrypto ?? globalThis.crypto?.subtle,
  ): Promise<void> {
    if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable')
    await verifyPath(
      this.options.store.adapter,
      this.options.store.entryPath(descriptor),
      descriptor,
      subtle,
    )
  }

  private async cleanup(path: string): Promise<void> {
    try {
      await removeDir(this.options.store.adapter, path)
    } catch (error) {
      this.reportCleanup(error)
    }
  }

  private reportCleanup(error: unknown): void {
    try {
      this.options.reportCleanupError?.(error)
    } catch {
      // Diagnostics cannot replace the primary artifact failure.
    }
  }
}

function sourceName(source: string): string {
  try {
    return new URL(source).hostname
  } catch {
    return source
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function verifyPath(
  adapter: DataAdapter,
  path: string,
  descriptor: RuntimeComponentDescriptor,
  subtle: Pick<SubtleCrypto, 'digest'>,
): Promise<void> {
  const stat = await adapter.stat(path)
  if (stat?.type !== 'file' || stat.size !== descriptor.byteSize) {
    throw new Error(`Runtime component "${descriptor.id}" entry is incomplete`)
  }
  const bytes = new Uint8Array(await adapter.readBinary(path))
  if (bytes.byteLength !== descriptor.byteSize) {
    throw new Error(`Runtime component "${descriptor.id}" byte size mismatch`)
  }
  await verifyModuleBytes(
    bytes,
    descriptor,
    `Runtime component "${descriptor.id}"`,
    subtle,
  )
}

async function ensureDir(adapter: DataAdapter, path: string): Promise<void> {
  if (!(await adapter.exists(path))) await adapter.mkdir(path)
}

async function removeDir(adapter: DataAdapter, path: string): Promise<void> {
  if (!(await adapter.exists(path))) return
  await adapter.rmdir(path, true)
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError')
}

function enqueue<T>(
  identity: object,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queue = queues.get(identity)
  if (!queue) {
    queue = new Map()
    queues.set(identity, queue)
  }
  const previous = queue.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  queue.set(key, tail)
  void tail.then(() => {
    if (queue?.get(key) === tail) queue.delete(key)
  })
  return result
}
