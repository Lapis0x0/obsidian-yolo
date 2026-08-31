import { type DataAdapter, normalizePath } from 'obsidian'

import { verifyModuleBytes } from '../modules/moduleIntegrity'

import {
  RuntimeComponentInstallError,
  isTransientRuntimeComponentError,
} from './runtimeComponentErrors'
import type {
  RuntimeComponentAssetDescriptor,
  RuntimeComponentDescriptor,
} from './runtimeComponentManifest'
import { RuntimeComponentStore } from './runtimeComponentStore'

export type RuntimeComponentDownload = (request: {
  descriptor: RuntimeComponentDescriptor
  /** Present when downloading an asset instead of the component's entry.js. */
  asset?: RuntimeComponentAssetDescriptor
  source: string
  signal?: AbortSignal
}) => Promise<Uint8Array>

type ArtifactTarget = Readonly<{ byteSize: number; sha256: string }>

const queues = new WeakMap<object, Map<string, Promise<void>>>()
let transaction = 0

export class RuntimeComponentInstaller {
  constructor(
    private readonly options: Readonly<{
      store: RuntimeComponentStore
      download: RuntimeComponentDownload
      resolveDownloadSources?: (
        descriptor: RuntimeComponentDescriptor,
        asset?: RuntimeComponentAssetDescriptor,
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
      await this.writeArtifactsToStaging(staging, descriptor, subtle, signal)
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

  /**
   * Downloads and writes `entry.js` plus every declared asset into `staging`
   * (a directory that later gets renamed atomically to the versioned target
   * dir), verifying each file's size+sha256 as it lands. Shared by the
   * first-install path and `repair` so both stage a complete, verified set
   * before anything is promoted.
   */
  private async writeArtifactsToStaging(
    staging: string,
    descriptor: RuntimeComponentDescriptor,
    subtle: Pick<SubtleCrypto, 'digest'>,
    signal?: AbortSignal,
  ): Promise<void> {
    const entryBytes = await this.downloadVerified(descriptor, subtle, signal)
    throwIfAborted(signal)
    const entryPath = normalizePath(`${staging}/entry.js`)
    await this.options.store.adapter.writeBinary(
      entryPath,
      exactArrayBuffer(entryBytes),
    )
    await verifyPath(
      this.options.store.adapter,
      entryPath,
      descriptor,
      subtle,
      `Runtime component "${descriptor.id}" entry`,
    )
    const assets = descriptor.assets ?? []
    if (assets.length === 0) return
    const assetsDir = normalizePath(`${staging}/assets`)
    await ensureDir(this.options.store.adapter, assetsDir)
    for (const asset of assets) {
      const assetBytes = await this.downloadVerified(
        descriptor,
        subtle,
        signal,
        asset,
      )
      throwIfAborted(signal)
      const assetPath = normalizePath(`${assetsDir}/${asset.name}`)
      await this.options.store.adapter.writeBinary(
        assetPath,
        exactArrayBuffer(assetBytes),
      )
      await verifyPath(
        this.options.store.adapter,
        assetPath,
        asset,
        subtle,
        `Runtime component "${descriptor.id}" asset "${asset.name}"`,
      )
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
      await this.writeArtifactsToStaging(staging, descriptor, subtle, signal)
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
    asset?: RuntimeComponentAssetDescriptor,
  ): Promise<Uint8Array> {
    throwIfAborted(signal)
    const target: ArtifactTarget = asset ?? descriptor
    const label = asset
      ? `Runtime component "${descriptor.id}" asset "${asset.name}"`
      : `Runtime component "${descriptor.id}"`
    const sources = this.options.resolveDownloadSources?.(
      descriptor,
      asset,
    ) ?? [asset ? asset.path : descriptor.entry]
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
          ...(asset ? { asset } : {}),
          source,
          ...(signal ? { signal } : {}),
        })
        throwIfAborted(signal)
        if (!(bytes instanceof Uint8Array)) {
          throw new TypeError(
            'Runtime component download must return Uint8Array',
          )
        }
        if (bytes.byteLength !== target.byteSize) {
          throw new Error(`${label} byte size mismatch`)
        }
        await verifyModuleBytes(bytes, target, label, subtle)
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
      `Runtime component "${descriptor.id}" entry`,
    )
    for (const asset of descriptor.assets ?? []) {
      await verifyPath(
        this.options.store.adapter,
        this.options.store.assetPath(descriptor, asset),
        asset,
        subtle,
        `Runtime component "${descriptor.id}" asset "${asset.name}"`,
      )
    }
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
  target: ArtifactTarget,
  subtle: Pick<SubtleCrypto, 'digest'>,
  label: string,
): Promise<void> {
  const stat = await adapter.stat(path)
  if (stat?.type !== 'file' || stat.size !== target.byteSize) {
    throw new Error(`${label} is incomplete`)
  }
  const bytes = new Uint8Array(await adapter.readBinary(path))
  if (bytes.byteLength !== target.byteSize) {
    throw new Error(`${label} byte size mismatch`)
  }
  await verifyModuleBytes(bytes, target, label, subtle)
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
