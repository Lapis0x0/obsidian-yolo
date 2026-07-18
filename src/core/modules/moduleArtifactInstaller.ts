import { type DataAdapter, normalizePath } from 'obsidian'

import {
  type ModuleArtifactDescriptor,
  collectInstallableModuleFiles,
  verifyInstalledModuleArtifact,
} from './moduleArtifactVerifier'
import { verifyModuleBytes } from './moduleIntegrity'
import { parseModuleReleaseUrl } from './moduleReleaseUrl'
import {
  MAX_MODULE_MANIFEST_BYTES,
  type ModuleArtifactFile,
  type ModuleArtifactManifest,
  type ModuleStore,
  assertModuleId,
  assertModulePathSegment,
  isModuleHostApiRange,
  moduleReadyMarkerFileName,
  normalizeModuleArtifactFilePath,
  parseModuleArtifactManifest,
  parseModuleReadyMarker,
  selectModuleManifestVariant,
} from './moduleStore'

export type ModuleArtifactDownloadRequest = Readonly<{
  kind: 'manifest' | 'artifact'
  url: string
  byteSize: number
  signal?: AbortSignal
}>

export type ModuleArtifactInstallerOptions = {
  adapter: DataAdapter
  store: ModuleStore
  download(request: ModuleArtifactDownloadRequest): Promise<Uint8Array>
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
  reportCleanupError?: (error: unknown) => void
}

const adapterQueues = new WeakMap<object, Map<string, Promise<void>>>()
let transactionSequence = 0

/** Downloads and promotes an immutable module version without activating it. */
export class ModuleArtifactInstaller {
  constructor(private readonly options: ModuleArtifactInstallerOptions) {
    if (!options || typeof options.download !== 'function') {
      throw new Error('Module artifact installer options are invalid')
    }
  }

  install(
    descriptor: ModuleArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<ModuleArtifactManifest> {
    assertAbortSignal(signal)
    throwIfAborted(signal)
    const subtleCrypto = this.options.subtleCrypto ?? globalThis.crypto?.subtle
    if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
    const snapshot = snapshotDescriptor(descriptor)
    return enqueue(
      this.options.adapter,
      moduleLockKey(this.options.store.pluginDir, snapshot.id),
      () => this.installUnlocked(snapshot, subtleCrypto, signal),
    )
  }

  repair(
    descriptor: ModuleArtifactDescriptor,
    signal?: AbortSignal,
  ): Promise<ModuleArtifactManifest> {
    assertAbortSignal(signal)
    throwIfAborted(signal)
    const subtleCrypto = this.options.subtleCrypto ?? globalThis.crypto?.subtle
    if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
    const snapshot = snapshotDescriptor(descriptor)
    return enqueue(
      this.options.adapter,
      moduleLockKey(this.options.store.pluginDir, snapshot.id),
      () => this.repairUnlocked(snapshot, subtleCrypto, signal),
    )
  }

  private async installUnlocked(
    descriptor: ModuleArtifactDescriptor,
    subtleCrypto: Pick<SubtleCrypto, 'digest'>,
    signal?: AbortSignal,
  ): Promise<ModuleArtifactManifest> {
    throwIfAborted(signal)
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
          subtleCrypto,
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
        kind: 'manifest',
        url: descriptor.manifestUrl,
        byteSize: descriptor.manifest.byteSize,
        ...(signal ? { signal } : {}),
      })
      throwIfAborted(signal)
      await verifyModuleBytes(
        manifestBytes,
        descriptor.manifest,
        `Module "${descriptor.id}" manifest`,
        subtleCrypto,
      )
      const manifest = parseModuleArtifactManifest(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
        ),
      )
      if (!manifestMatchesDescriptor(manifest, descriptor)) {
        throw new Error(
          `Module "${descriptor.id}" manifest descriptor mismatch`,
        )
      }
      selectModuleManifestVariant(manifest, descriptor.platform)
      const files = collectInstallableModuleFiles(
        manifest,
        descriptor.manifestUrl,
      )

      for (const file of files) {
        const bytes = await this.options.download({
          kind: 'artifact',
          url: file.url,
          byteSize: file.byteSize,
          ...(signal ? { signal } : {}),
        })
        throwIfAborted(signal)
        await verifyModuleBytes(
          bytes,
          file,
          `Module "${descriptor.id}" file "${file.path}"`,
          subtleCrypto,
        )
        const target = normalizePath(`${stagingDir}/${file.path}`)
        throwIfAborted(signal)
        await ensureParentDirs(adapter, stagingDir, file.path)
        await adapter.writeBinary(target, toArrayBuffer(bytes))
      }
      await adapter.writeBinary(
        normalizePath(`${stagingDir}/module.json`),
        toArrayBuffer(manifestBytes),
      )
      await verifyStagingArtifacts(
        adapter,
        stagingDir,
        descriptor,
        files,
        subtleCrypto,
      )
      for (const markerVariant of manifest.variants) {
        const readyBytes = createReadyMarkerBytes(
          descriptor,
          markerVariant.platform,
        )
        await adapter.writeBinary(
          normalizePath(
            `${stagingDir}/${moduleReadyMarkerFileName(markerVariant.platform, descriptor.manifest.sha256)}`,
          ),
          toArrayBuffer(readyBytes),
        )
      }
      await verifyStagingMarkers(adapter, stagingDir, descriptor, manifest)

      if (await adapter.exists(targetDir)) {
        throw new Error(
          `Module "${descriptor.id}" version directory appeared during install`,
        )
      }
      throwIfAborted(signal)
      await adapter.rename(stagingDir, targetDir)
      const verified = await verifyInstalledModuleArtifact(
        this.options.store,
        descriptor,
        subtleCrypto,
      )
      return verified.manifest
    } finally {
      // Never delete a target after rename: DataAdapter does not guarantee an
      // atomic move, so ownership cannot be proven on every platform.
      await this.cleanupDir(stagingDir)
    }
  }

  private async repairUnlocked(
    descriptor: ModuleArtifactDescriptor,
    subtleCrypto: Pick<SubtleCrypto, 'digest'>,
    signal?: AbortSignal,
  ): Promise<ModuleArtifactManifest> {
    throwIfAborted(signal)
    const adapter = this.options.adapter
    if (
      typeof adapter.rename !== 'function' ||
      typeof adapter.rmdir !== 'function'
    ) {
      throw new Error(
        'Module adapter cannot atomically replace artifact directories',
      )
    }
    const moduleRoot = normalizePath(
      `${this.options.store.pluginDir}/modules/${descriptor.id}`,
    )
    const targetDir = normalizePath(`${moduleRoot}/${descriptor.version}`)
    const transactionId = nextTransactionId()
    const stagingDir = normalizePath(
      `${moduleRoot}/.repair-staging-${descriptor.version}-${transactionId}`,
    )
    const backupDir = normalizePath(
      `${moduleRoot}/.repair-backup-${descriptor.version}-${transactionId}`,
    )

    await ensureDir(
      adapter,
      normalizePath(`${this.options.store.pluginDir}/modules`),
    )
    await ensureDir(adapter, moduleRoot)
    if (!(await adapter.exists(targetDir))) {
      throw new Error(
        `Module "${descriptor.id}" version directory disappeared before repair`,
      )
    }
    if (
      (await adapter.exists(stagingDir)) ||
      (await adapter.exists(backupDir))
    ) {
      throw new Error(`Module "${descriptor.id}" repair workspace is occupied`)
    }

    await ensureDir(adapter, stagingDir)
    let originalMoved = false
    let promoted = false
    try {
      const manifest = await this.downloadAndVerifyStaging(
        stagingDir,
        descriptor,
        subtleCrypto,
        signal,
      )
      throwIfAborted(signal)
      originalMoved = true
      await renameWithReadback(
        adapter,
        targetDir,
        backupDir,
        `Module "${descriptor.id}" backup promotion`,
      )
      try {
        promoted = await renameWithReadback(
          adapter,
          stagingDir,
          targetDir,
          `Module "${descriptor.id}" repair promotion`,
        )
        if (!promoted) {
          throw new Error(`Module "${descriptor.id}" repair was not promoted`)
        }
      } catch (error) {
        await rollbackPromotion(adapter, targetDir, backupDir)
        originalMoved = false
        promoted = false
        throw error
      }
      await this.cleanupDir(backupDir)
      originalMoved = false
      return manifest
    } finally {
      if (!promoted) await this.cleanupDir(stagingDir)
      if (originalMoved) {
        try {
          await rollbackPromotion(adapter, targetDir, backupDir)
        } catch (error) {
          try {
            this.options.reportCleanupError?.(error)
          } catch {
            // Rollback diagnostics cannot replace the primary repair failure.
          }
        }
      }
    }
  }

  private async downloadAndVerifyStaging(
    stagingDir: string,
    descriptor: ModuleArtifactDescriptor,
    subtleCrypto: Pick<SubtleCrypto, 'digest'>,
    signal?: AbortSignal,
  ): Promise<ModuleArtifactManifest> {
    const adapter = this.options.adapter
    const manifestBytes = await this.options.download({
      kind: 'manifest',
      url: descriptor.manifestUrl,
      byteSize: descriptor.manifest.byteSize,
      ...(signal ? { signal } : {}),
    })
    throwIfAborted(signal)
    await verifyModuleBytes(
      manifestBytes,
      descriptor.manifest,
      `Module "${descriptor.id}" manifest`,
      subtleCrypto,
    )
    const manifest = parseModuleArtifactManifest(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
      ),
    )
    if (!manifestMatchesDescriptor(manifest, descriptor)) {
      throw new Error(`Module "${descriptor.id}" manifest descriptor mismatch`)
    }
    selectModuleManifestVariant(manifest, descriptor.platform)
    const files = collectInstallableModuleFiles(
      manifest,
      descriptor.manifestUrl,
    )
    for (const file of files) {
      const bytes = await this.options.download({
        kind: 'artifact',
        url: file.url,
        byteSize: file.byteSize,
        ...(signal ? { signal } : {}),
      })
      throwIfAborted(signal)
      await verifyModuleBytes(
        bytes,
        file,
        `Module "${descriptor.id}" file "${file.path}"`,
        subtleCrypto,
      )
      await ensureParentDirs(adapter, stagingDir, file.path)
      await adapter.writeBinary(
        normalizePath(`${stagingDir}/${file.path}`),
        toArrayBuffer(bytes),
      )
    }
    await adapter.writeBinary(
      normalizePath(`${stagingDir}/module.json`),
      toArrayBuffer(manifestBytes),
    )
    await verifyStagingArtifacts(
      adapter,
      stagingDir,
      descriptor,
      files,
      subtleCrypto,
    )
    for (const variant of manifest.variants) {
      await adapter.writeBinary(
        normalizePath(
          `${stagingDir}/${moduleReadyMarkerFileName(variant.platform, descriptor.manifest.sha256)}`,
        ),
        toArrayBuffer(createReadyMarkerBytes(descriptor, variant.platform)),
      )
    }
    await verifyStagingMarkers(adapter, stagingDir, descriptor, manifest)
    await verifyStagingClosure(adapter, stagingDir, manifest, files, descriptor)
    return manifest
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

function assertAbortSignal(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal !== 'object' ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function')
  ) {
    throw new TypeError('Module artifact install signal is invalid')
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new Error('Module artifact installation was aborted')
}

async function verifyStagingArtifacts(
  adapter: DataAdapter,
  stagingDir: string,
  descriptor: ModuleArtifactDescriptor,
  files: readonly ModuleArtifactFile[],
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
): Promise<void> {
  const manifestBytes = new Uint8Array(
    await adapter.readBinary(normalizePath(`${stagingDir}/module.json`)),
  )
  await verifyModuleBytes(
    manifestBytes,
    descriptor.manifest,
    `Module "${descriptor.id}" staged manifest`,
    subtleCrypto,
  )
  for (const file of files) {
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

async function verifyStagingMarkers(
  adapter: DataAdapter,
  stagingDir: string,
  descriptor: ModuleArtifactDescriptor,
  manifest: ModuleArtifactManifest,
): Promise<void> {
  for (const variant of manifest.variants) {
    const readyBytes = new Uint8Array(
      await adapter.readBinary(
        normalizePath(
          `${stagingDir}/${moduleReadyMarkerFileName(variant.platform, descriptor.manifest.sha256)}`,
        ),
      ),
    )
    const marker = parseModuleReadyMarker(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readyBytes)),
    )
    if (
      marker.id !== descriptor.id ||
      marker.version !== descriptor.version ||
      marker.platform !== variant.platform ||
      marker.manifestSha256 !== descriptor.manifest.sha256
    ) {
      throw new Error(`Module "${descriptor.id}" staging marker mismatch`)
    }
  }
}

async function verifyStagingClosure(
  adapter: DataAdapter,
  stagingDir: string,
  manifest: ModuleArtifactManifest,
  files: readonly ModuleArtifactFile[],
  descriptor: ModuleArtifactDescriptor,
): Promise<void> {
  const expected = new Set([
    'module.json',
    ...files.map((file) => file.path),
    ...manifest.variants.map((variant) =>
      moduleReadyMarkerFileName(variant.platform, descriptor.manifest.sha256),
    ),
  ])
  const actual = await listRelativeFiles(adapter, stagingDir)
  if (
    actual.length !== expected.size ||
    actual.some((path) => !expected.has(path))
  ) {
    throw new Error(`Module "${descriptor.id}" staging file closure mismatch`)
  }
}

async function listRelativeFiles(
  adapter: DataAdapter,
  root: string,
): Promise<readonly string[]> {
  const pending = [root]
  const files: string[] = []
  while (pending.length > 0) {
    const folder = pending.pop()!
    const listing = await adapter.list(folder)
    for (const path of listing.files) files.push(path.slice(root.length + 1))
    pending.push(...listing.folders)
  }
  return files.sort()
}

async function renameWithReadback(
  adapter: DataAdapter,
  from: string,
  to: string,
  label: string,
): Promise<boolean> {
  try {
    await adapter.rename(from, to)
    return true
  } catch (error) {
    const [fromExists, toExists] = await Promise.all([
      adapter.exists(from),
      adapter.exists(to),
    ])
    if (!fromExists && toExists) return true
    if (fromExists && !toExists) throw error
    throw new Error(
      `${label} left directory ownership uncertain: ${describeError(error)}`,
    )
  }
}

async function rollbackPromotion(
  adapter: DataAdapter,
  targetDir: string,
  backupDir: string,
): Promise<void> {
  if (!(await adapter.exists(backupDir))) {
    throw new Error('Module artifact repair backup is unavailable for rollback')
  }
  if (await adapter.exists(targetDir)) await adapter.rmdir(targetDir, true)
  await renameWithReadback(
    adapter,
    backupDir,
    targetDir,
    'Module artifact repair rollback',
  )
}

function moduleLockKey(pluginDir: string, moduleId: string): string {
  return normalizePath(`${pluginDir}/modules/${moduleId}`)
}

function nextTransactionId(): string {
  transactionSequence = (transactionSequence + 1) % Number.MAX_SAFE_INTEGER
  return transactionSequence.toString(36)
}

function createReadyMarkerBytes(
  descriptor: ModuleArtifactDescriptor,
  platform: 'desktop' | 'mobile',
): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      schemaVersion: 1,
      id: descriptor.id,
      version: descriptor.version,
      platform,
      manifestSha256: descriptor.manifest.sha256,
    })}\n`,
  )
}

function snapshotDescriptor(
  descriptor: ModuleArtifactDescriptor,
): ModuleArtifactDescriptor {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError('Module artifact descriptor must be an object')
  }
  assertModuleId(descriptor.id, 'Module id')
  assertModulePathSegment(descriptor.version, 'Module version')
  if (
    !isModuleHostApiRange(descriptor.hostApi) ||
    (descriptor.platform !== 'desktop' && descriptor.platform !== 'mobile') ||
    !parseModuleReleaseUrl(descriptor.manifestUrl)
  ) {
    throw new Error('Module artifact descriptor is invalid')
  }
  const dataSchemas = snapshotDataSchemas(descriptor.dataSchemas)
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
    hostApi: descriptor.hostApi,
    dataSchemas,
    platform: descriptor.platform,
    manifestUrl: descriptor.manifestUrl,
    manifest: Object.freeze({ byteSize, sha256: sha256.toLowerCase() }),
  })
}

function snapshotDataSchemas(
  schemas: ModuleArtifactDescriptor['dataSchemas'],
): ModuleArtifactDescriptor['dataSchemas'] {
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) {
    throw new Error('Module artifact descriptor dataSchemas is invalid')
  }
  const result = Object.create(null) as Record<
    string,
    { readMin: number; readMax: number; write: number }
  >
  for (const [namespace, schema] of Object.entries(schemas)) {
    if (
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(namespace) ||
      !schema ||
      typeof schema !== 'object' ||
      Object.keys(schema).length !== 3 ||
      !Number.isSafeInteger(schema.readMin) ||
      schema.readMin < 0 ||
      !Number.isSafeInteger(schema.readMax) ||
      schema.readMax < schema.readMin ||
      !Number.isSafeInteger(schema.write) ||
      schema.write < schema.readMin ||
      schema.write > schema.readMax
    ) {
      throw new Error('Module artifact descriptor dataSchemas is invalid')
    }
    result[namespace] = Object.freeze({
      readMin: schema.readMin,
      readMax: schema.readMax,
      write: schema.write,
    })
  }
  return Object.freeze(result)
}

function manifestMatchesDescriptor(
  manifest: ModuleArtifactManifest,
  descriptor: ModuleArtifactDescriptor,
): boolean {
  const actualSchemas = Object.entries(manifest.dataSchemas)
  return (
    manifest.id === descriptor.id &&
    manifest.version === descriptor.version &&
    manifest.hostApi === descriptor.hostApi &&
    actualSchemas.length === Object.keys(descriptor.dataSchemas).length &&
    actualSchemas.every(([namespace, schema]) => {
      const expected = descriptor.dataSchemas[namespace]
      return (
        expected?.readMin === schema.readMin &&
        expected.readMax === schema.readMax &&
        expected.write === schema.write
      )
    })
  )
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
