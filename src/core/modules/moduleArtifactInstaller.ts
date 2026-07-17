import { type DataAdapter, normalizePath } from 'obsidian'

import {
  type ModuleArtifactDescriptor,
  verifyInstalledModuleArtifact,
} from './moduleArtifactVerifier'
import { verifyModuleBytes } from './moduleIntegrity'
import {
  MAX_MODULE_MANIFEST_BYTES,
  type ModuleArtifactManifest,
  type ModuleStore,
  assertModuleId,
  assertModulePathSegment,
  normalizeModuleArtifactFilePath,
  parseModuleArtifactManifest,
  parseModuleReadyMarker,
} from './moduleStore'

export type ModuleArtifactDownloadRequest = Readonly<{
  moduleId: string
  version: string
  path: string
}>

export type ModuleArtifactInstallerOptions = {
  adapter: DataAdapter
  store: ModuleStore
  download(request: ModuleArtifactDownloadRequest): Promise<Uint8Array>
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
  reportCleanupError?: (error: unknown) => void
}

const adapterQueues = new WeakMap<object, Map<string, Promise<void>>>()

/** Downloads and promotes an immutable module version without activating it. */
export class ModuleArtifactInstaller {
  private readonly subtleCrypto: Pick<SubtleCrypto, 'digest'>

  constructor(private readonly options: ModuleArtifactInstallerOptions) {
    const subtleCrypto = options.subtleCrypto ?? globalThis.crypto?.subtle
    if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
    this.subtleCrypto = subtleCrypto
  }

  install(
    descriptor: ModuleArtifactDescriptor,
  ): Promise<ModuleArtifactManifest> {
    const snapshot = snapshotDescriptor(descriptor)
    return enqueue(this.options.adapter, this.options.store.pluginDir, () =>
      this.installUnlocked(snapshot),
    )
  }

  private async installUnlocked(
    descriptor: ModuleArtifactDescriptor,
  ): Promise<ModuleArtifactManifest> {
    const adapter = this.options.adapter
    const moduleRoot = normalizePath(
      `${this.options.store.pluginDir}/modules/${descriptor.id}`,
    )
    const targetDir = normalizePath(`${moduleRoot}/${descriptor.version}`)
    const stagingDir = normalizePath(
      `${moduleRoot}/.staging-${descriptor.version}`,
    )

    await ensureDir(
      adapter,
      normalizePath(`${this.options.store.pluginDir}/modules`),
    )
    await ensureDir(adapter, moduleRoot)
    if (await adapter.exists(targetDir)) {
      try {
        const verified = await verifyInstalledModuleArtifact(
          this.options.store,
          descriptor,
          this.subtleCrypto,
        )
        await this.cleanupDir(stagingDir)
        return verified.manifest
      } catch (error) {
        await this.cleanupDir(stagingDir)
        throw new Error(
          `Module "${descriptor.id}" version directory exists but is invalid: ${describeError(error)}`,
        )
      }
    }

    await removeDir(adapter, stagingDir)
    await ensureDir(adapter, stagingDir)
    try {
      const manifestBytes = await this.options.download({
        moduleId: descriptor.id,
        version: descriptor.version,
        path: 'module.json',
      })
      await verifyModuleBytes(
        manifestBytes,
        descriptor.manifest,
        `Module "${descriptor.id}" manifest`,
        this.subtleCrypto,
      )
      const manifest = parseModuleArtifactManifest(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
        ),
      )
      if (
        manifest.id !== descriptor.id ||
        manifest.version !== descriptor.version
      ) {
        throw new Error(`Module "${descriptor.id}" manifest identity mismatch`)
      }

      for (const file of manifest.files) {
        const bytes = await this.options.download({
          moduleId: descriptor.id,
          version: descriptor.version,
          path: file.path,
        })
        await verifyModuleBytes(
          bytes,
          file,
          `Module "${descriptor.id}" file "${file.path}"`,
          this.subtleCrypto,
        )
        const target = normalizePath(`${stagingDir}/${file.path}`)
        await ensureParentDirs(adapter, stagingDir, file.path)
        await adapter.writeBinary(target, toArrayBuffer(bytes))
      }
      await adapter.writeBinary(
        normalizePath(`${stagingDir}/module.json`),
        toArrayBuffer(manifestBytes),
      )
      const readyBytes = new TextEncoder().encode(
        `${JSON.stringify({
          schemaVersion: 1,
          id: descriptor.id,
          version: descriptor.version,
          manifestSha256: descriptor.manifest.sha256,
        })}\n`,
      )
      await adapter.writeBinary(
        normalizePath(`${stagingDir}/ready.json`),
        toArrayBuffer(readyBytes),
      )
      await verifyStaging(
        adapter,
        stagingDir,
        descriptor,
        manifest,
        this.subtleCrypto,
      )

      if (await adapter.exists(targetDir)) {
        throw new Error(
          `Module "${descriptor.id}" version directory appeared during install`,
        )
      }
      await adapter.rename(stagingDir, targetDir)
      const verified = await verifyInstalledModuleArtifact(
        this.options.store,
        descriptor,
        this.subtleCrypto,
      )
      return verified.manifest
    } finally {
      // Never delete a target after rename: DataAdapter does not guarantee an
      // atomic move, so ownership cannot be proven on every platform.
      await this.cleanupDir(stagingDir)
    }
  }

  private async cleanupDir(path: string): Promise<void> {
    try {
      await removeDir(this.options.adapter, path)
    } catch (error) {
      try {
        this.options.reportCleanupError?.(error)
      } catch {
        // Cleanup diagnostics cannot alter an already-decided install result.
      }
    }
  }
}

async function verifyStaging(
  adapter: DataAdapter,
  stagingDir: string,
  descriptor: ModuleArtifactDescriptor,
  manifest: ModuleArtifactManifest,
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
): Promise<void> {
  const readyBytes = new Uint8Array(
    await adapter.readBinary(normalizePath(`${stagingDir}/ready.json`)),
  )
  const marker = parseModuleReadyMarker(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readyBytes)),
  )
  if (
    marker.id !== descriptor.id ||
    marker.version !== descriptor.version ||
    marker.manifestSha256 !== descriptor.manifest.sha256
  ) {
    throw new Error(`Module "${descriptor.id}" staging marker mismatch`)
  }
  const manifestBytes = new Uint8Array(
    await adapter.readBinary(normalizePath(`${stagingDir}/module.json`)),
  )
  await verifyModuleBytes(
    manifestBytes,
    descriptor.manifest,
    `Module "${descriptor.id}" staged manifest`,
    subtleCrypto,
  )
  for (const file of manifest.files) {
    const bytes = new Uint8Array(
      await adapter.readBinary(normalizePath(`${stagingDir}/${file.path}`)),
    )
    await verifyModuleBytes(
      bytes,
      file,
      `Module "${descriptor.id}" staged file "${file.path}"`,
      subtleCrypto,
    )
  }
}

function snapshotDescriptor(
  descriptor: ModuleArtifactDescriptor,
): ModuleArtifactDescriptor {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError('Module artifact descriptor must be an object')
  }
  assertModuleId(descriptor.id, 'Module id')
  assertModulePathSegment(descriptor.version, 'Module version')
  const byteSize = descriptor.manifest?.byteSize
  const sha256 = descriptor.manifest?.sha256
  if (
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    byteSize > MAX_MODULE_MANIFEST_BYTES ||
    typeof sha256 !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(sha256)
  ) {
    throw new Error('Module manifest metadata is invalid')
  }
  return Object.freeze({
    id: descriptor.id,
    version: descriptor.version,
    manifest: Object.freeze({ byteSize, sha256: sha256.toLowerCase() }),
  })
}

async function ensureParentDirs(
  adapter: DataAdapter,
  root: string,
  relativePath: string,
): Promise<void> {
  const normalized = normalizeModuleArtifactFilePath(relativePath)
  const parts = normalized.split('/').slice(0, -1)
  let current = root
  for (const part of parts) {
    current = normalizePath(`${current}/${part}`)
    await ensureDir(adapter, current)
  }
}

async function ensureDir(adapter: DataAdapter, path: string): Promise<void> {
  if (!(await adapter.exists(path))) await adapter.mkdir(path)
}

async function removeDir(adapter: DataAdapter, path: string): Promise<void> {
  if (await adapter.exists(path)) await adapter.rmdir(path, true)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function enqueue<T>(
  adapter: object,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = adapterQueues.get(adapter)
  if (!queues) {
    queues = new Map()
    adapterQueues.set(adapter, queues)
  }
  const previous = queues.get(key) ?? Promise.resolve()
  const result = previous.then(operation)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, settled)
  void settled.finally(() => {
    if (queues?.get(key) === settled) queues.delete(key)
  })
  return result
}
