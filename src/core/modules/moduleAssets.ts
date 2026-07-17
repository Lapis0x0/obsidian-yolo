import type { ModuleLifecycleScope } from './lifecycleScope'
import type { VerifiedModuleArtifact } from './moduleArtifactVerifier'
import { verifyModuleBytes } from './moduleIntegrity'
import {
  type ModuleArtifactFile,
  type ModuleStore,
  assertModuleId,
  normalizeModuleArtifactFilePath,
} from './moduleStore'

export type ModuleAssetRole = Extract<
  ModuleArtifactFile['role'],
  'style' | 'worker' | 'wasm'
>

export type ModuleAssetsV1 = Readonly<{
  readText(path: string): Promise<string>
  readArrayBuffer(path: string): Promise<ArrayBuffer>
  createBlobUrl(path: string): Promise<string>
}>

export type ModuleAssetsCapabilityActivationV1 = Readonly<{
  api: ModuleAssetsV1
  activate(): void
}>

export type ModuleAssetsCapabilityProviderOptions = Readonly<{
  store: Pick<ModuleStore, 'readEntryBytes'>
  getVerifiedArtifact(
    moduleId: string,
  ):
    | VerifiedModuleArtifact
    | null
    | undefined
    | Promise<VerifiedModuleArtifact | null | undefined>
  urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
}>

type ResolvedAsset = Readonly<{
  moduleId: string
  version: string
  file: ModuleArtifactFile & { role: ModuleAssetRole }
}>

const ASSET_ROLES = new Set<ModuleArtifactFile['role']>([
  'style',
  'worker',
  'wasm',
])

/** Exposes only non-executable-entry assets from the verified active artifact. */
export class ModuleAssetsCapabilityProvider {
  private readonly subtleCrypto: Pick<SubtleCrypto, 'digest'>

  constructor(private readonly options: ModuleAssetsCapabilityProviderOptions) {
    const subtleCrypto = options.subtleCrypto ?? globalThis.crypto?.subtle
    if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
    this.subtleCrypto = subtleCrypto
  }

  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleAssetsCapabilityActivationV1 {
    assertModuleId(moduleId, 'Module id')
    let active = true
    let activationComplete = false
    const blobUrls = new Set<string>()

    lifecycle.add(() => {
      active = false
      activationComplete = false
      const errors: unknown[] = []
      for (const url of blobUrls) {
        blobUrls.delete(url)
        try {
          this.getUrlApi().revokeObjectURL(url)
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new ModuleAssetsCleanupError(errors)
    })

    const inactiveError = (): Error =>
      new Error(`Module "${moduleId}" is no longer active`)
    const assertActive = (): void => {
      if (!active) throw inactiveError()
      if (!activationComplete) {
        throw new Error(`Module "${moduleId}" assets are not active`)
      }
    }
    const resolveAsset = async (path: string): Promise<ResolvedAsset> => {
      assertActive()
      const normalizedPath = normalizeAssetRequestPath(path)
      const artifact = await this.options.getVerifiedArtifact(moduleId)
      assertActive()
      if (!artifact) {
        throw new Error(`Module "${moduleId}" has no installed artifact`)
      }
      const { manifest } = artifact
      if (manifest.id !== moduleId) {
        throw new Error(
          `Module "${moduleId}" installed artifact identity mismatch`,
        )
      }
      const canonicalPath = canonicalize(normalizedPath)
      const file = manifest.files.find(
        (candidate) => canonicalize(candidate.path) === canonicalPath,
      )
      if (!file || !isAssetFile(file)) {
        throw new Error(
          `Module "${moduleId}" asset "${normalizedPath}" is not declared as style, worker, or wasm`,
        )
      }
      return Object.freeze({ moduleId, version: manifest.version, file })
    }
    const read = async (
      path: string,
    ): Promise<ResolvedAsset & { bytes: Uint8Array }> => {
      const asset = await resolveAsset(path)
      const bytes = await this.options.store.readEntryBytes(
        asset.moduleId,
        asset.version,
        asset.file.path,
      )
      await verifyModuleBytes(
        bytes,
        asset.file,
        `Module "${asset.moduleId}" asset "${asset.file.path}"`,
        this.subtleCrypto,
      )
      assertActive()
      return { ...asset, bytes }
    }

    const api: ModuleAssetsV1 = Object.freeze({
      readText: async (path) => {
        const asset = await read(path)
        if (asset.file.role === 'wasm') {
          throw new Error('Wasm module assets cannot be read as text')
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes)
      },
      readArrayBuffer: async (path) => {
        const { bytes } = await read(path)
        return copyArrayBuffer(bytes)
      },
      createBlobUrl: async (path) => {
        const asset = await read(path)
        const urlApi = this.getUrlApi()
        const url = urlApi.createObjectURL(
          new Blob([copyArrayBuffer(asset.bytes)], {
            type: mimeTypeFor(asset.file.role),
          }),
        )
        if (!active) {
          urlApi.revokeObjectURL(url)
          throw inactiveError()
        }
        blobUrls.add(url)
        return url
      },
    })

    return Object.freeze({
      api,
      activate: () => {
        if (!active) throw inactiveError()
        activationComplete = true
      },
    })
  }

  private getUrlApi(): Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> {
    const urlApi = this.options.urlApi ?? globalThis.URL
    if (
      !urlApi ||
      typeof urlApi.createObjectURL !== 'function' ||
      typeof urlApi.revokeObjectURL !== 'function'
    ) {
      throw new Error('Blob URLs are unavailable')
    }
    return urlApi
  }
}

export class ModuleAssetsCleanupError extends Error {
  constructor(readonly errors: unknown[]) {
    super('Module asset cleanup reported errors')
    this.name = 'ModuleAssetsCleanupError'
  }
}

function normalizeAssetRequestPath(path: string): string {
  if (typeof path !== 'string') {
    throw new TypeError('Module asset path must be a string')
  }
  const normalized = normalizeModuleArtifactFilePath(path)
  const canonicalPath = canonicalize(normalized)
  if (canonicalPath === 'module.json' || canonicalPath === 'ready.json') {
    throw new Error('Module artifact metadata is not available as an asset')
  }
  return normalized
}

function canonicalize(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

function isAssetFile(
  file: ModuleArtifactFile,
): file is ModuleArtifactFile & { role: ModuleAssetRole } {
  return ASSET_ROLES.has(file.role)
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  )
}

function mimeTypeFor(role: ModuleAssetRole): string {
  if (role === 'style') return 'text/css;charset=utf-8'
  if (role === 'worker') return 'text/javascript;charset=utf-8'
  return 'application/wasm'
}
