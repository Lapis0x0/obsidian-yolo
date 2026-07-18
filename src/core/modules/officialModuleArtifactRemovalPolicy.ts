import {
  type ModuleArtifactDescriptor,
  collectInstallableModuleFiles,
} from './moduleArtifactVerifier'
import { verifyModuleBytes } from './moduleIntegrity'
import {
  moduleReadyMarkerFileName,
  parseModuleArtifactManifest,
  parseModuleReadyMarker,
  selectModuleManifestVariant,
} from './moduleStore'
import {
  type OfficialModuleArtifactRequest,
  createOfficialModuleArtifactDownloader,
} from './officialModuleArtifactDownloader'
import type { OfficialModulePlatform } from './officialModuleCatalog'
import type { OfficialModuleCatalogClient } from './officialModuleCatalogClient'

export type OfficialModuleArtifactRemovalCatalogLoader = Pick<
  OfficialModuleCatalogClient,
  'loadFresh'
>

export type OfficialModuleArtifactRemovalOptions = Readonly<{
  requestUrl?: OfficialModuleArtifactRequest
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
  timeoutMs?: number
  signal?: AbortSignal
}>

/**
 * Authorizes removal only after every exact version has been downloaded and
 * integrity-checked from the release described by a fresh trusted catalog.
 */
export async function authorizeOfficialModuleArtifactRemoval(
  catalogLoader: OfficialModuleArtifactRemovalCatalogLoader,
  moduleId: string,
  versions: readonly string[],
  platform: OfficialModulePlatform,
  options: OfficialModuleArtifactRemovalOptions = {},
): Promise<boolean> {
  if (
    !catalogLoader ||
    typeof catalogLoader.loadFresh !== 'function' ||
    typeof moduleId !== 'string' ||
    moduleId.length === 0 ||
    !Array.isArray(versions) ||
    versions.length === 0 ||
    versions.some((version) => typeof version !== 'string' || !version) ||
    new Set(versions).size !== versions.length ||
    (platform !== 'desktop' && platform !== 'mobile') ||
    !options ||
    typeof options !== 'object'
  ) {
    return false
  }

  try {
    const subtleCrypto = options.subtleCrypto ?? globalThis.crypto?.subtle
    if (!subtleCrypto) return false
    const download = createOfficialModuleArtifactDownloader({
      ...(options.requestUrl ? { requestUrl: options.requestUrl } : {}),
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    })
    const catalog = await catalogLoader.loadFresh()
    const module = catalog.modules.find(
      (candidate) => candidate.id === moduleId,
    )
    if (!module) return false

    const descriptors = versions.map((version) => {
      const candidate = module.versions.find(
        (catalogVersion) => catalogVersion.version === version,
      )
      return candidate?.platforms.includes(platform)
        ? ({
            id: moduleId,
            version: candidate.version,
            hostApi: candidate.hostApi,
            dataSchemas: candidate.dataSchemas,
            platform,
            manifestUrl: candidate.manifestUrl,
            manifest: candidate.manifest,
          } satisfies ModuleArtifactDescriptor)
        : null
    })
    if (descriptors.some((descriptor) => descriptor === null)) return false

    // Keep downloads sequential so a removal check never retains multiple
    // potentially large release assets at once.
    for (const descriptor of descriptors) {
      await verifyRemoteArtifact(
        descriptor as ModuleArtifactDescriptor,
        download,
        subtleCrypto,
        options.signal,
      )
    }
    return true
  } catch {
    return false
  }
}

async function verifyRemoteArtifact(
  descriptor: ModuleArtifactDescriptor,
  download: ReturnType<typeof createOfficialModuleArtifactDownloader>,
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
  signal?: AbortSignal,
): Promise<void> {
  const signalOption = signal ? { signal } : {}
  const manifestBytes = await download({
    kind: 'manifest',
    url: descriptor.manifestUrl,
    byteSize: descriptor.manifest.byteSize,
    ...signalOption,
  })
  await verifyModuleBytes(
    manifestBytes,
    descriptor.manifest,
    `Module "${descriptor.id}" manifest`,
    subtleCrypto,
  )
  const manifest = parseModuleArtifactManifest(decodeJson(manifestBytes))
  if (!manifestMatchesDescriptor(manifest, descriptor)) {
    throw new Error(`Module "${descriptor.id}" manifest descriptor mismatch`)
  }
  selectModuleManifestVariant(manifest, descriptor.platform)
  const files = collectInstallableModuleFiles(manifest, descriptor.manifestUrl)

  const markerName = moduleReadyMarkerFileName(
    descriptor.platform,
    descriptor.manifest.sha256,
  )
  const markerUrl = `${descriptor.manifestUrl.slice(0, descriptor.manifestUrl.lastIndexOf('/') + 1)}${markerName}`
  const expectedMarkerBytes = encodeReadyMarker(descriptor)
  const markerBytes = await download({
    kind: 'manifest',
    url: markerUrl,
    byteSize: expectedMarkerBytes.byteLength,
    ...signalOption,
  })
  const marker = parseModuleReadyMarker(decodeJson(markerBytes))
  if (
    marker.id !== descriptor.id ||
    marker.version !== descriptor.version ||
    marker.platform !== descriptor.platform ||
    marker.manifestSha256 !== descriptor.manifest.sha256
  ) {
    throw new Error(`Module "${descriptor.id}" ready marker mismatch`)
  }

  for (const file of files) {
    const bytes = await download({
      kind: 'artifact',
      url: file.url,
      byteSize: file.byteSize,
      ...signalOption,
    })
    await verifyModuleBytes(
      bytes,
      file,
      `Module "${descriptor.id}" file "${file.path}"`,
      subtleCrypto,
    )
  }
}

function encodeReadyMarker(descriptor: ModuleArtifactDescriptor): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      schemaVersion: 1,
      id: descriptor.id,
      version: descriptor.version,
      platform: descriptor.platform,
      manifestSha256: descriptor.manifest.sha256,
    })}\n`,
  )
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  ) as unknown
}

function manifestMatchesDescriptor(
  manifest: ReturnType<typeof parseModuleArtifactManifest>,
  descriptor: ModuleArtifactDescriptor,
): boolean {
  const schemas = Object.entries(manifest.dataSchemas)
  return (
    manifest.id === descriptor.id &&
    manifest.version === descriptor.version &&
    manifest.hostApi === descriptor.hostApi &&
    schemas.length === Object.keys(descriptor.dataSchemas).length &&
    schemas.every(([namespace, schema]) => {
      const expected = descriptor.dataSchemas[namespace]
      return (
        expected?.readMin === schema.readMin &&
        expected.readMax === schema.readMax &&
        expected.write === schema.write
      )
    })
  )
}
