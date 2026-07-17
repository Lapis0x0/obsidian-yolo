import { verifyModuleBytes } from './moduleIntegrity'
import {
  type ModuleArtifactDataSchemas,
  type ModuleArtifactFile,
  type ModuleArtifactManifest,
  type ModuleArtifactPlatform,
  type ModuleArtifactVariant,
  type ModuleStore,
  collectModuleManifestFiles,
  moduleArtifactReleaseParent,
  moduleReadyMarkerFileName,
  parseModuleArtifactManifest,
  parseModuleReadyMarker,
  selectModuleManifestVariant,
} from './moduleStore'

export type ModuleArtifactDescriptor = Readonly<{
  id: string
  version: string
  hostApi: string
  dataSchemas: ModuleArtifactDataSchemas
  platform: ModuleArtifactPlatform
  manifestUrl: string
  manifest: Readonly<{
    byteSize: number
    sha256: string
  }>
}>

export type ModuleArtifactReadStore = Pick<
  ModuleStore,
  | 'readReadyMarkerBytes'
  | 'readManifestBytes'
  | 'readEntryBytes'
  | 'listVersionFiles'
>

export type VerifiedModuleArtifact = Readonly<{
  manifest: ModuleArtifactManifest
  variant: ModuleArtifactVariant
  entryBytes: Uint8Array
}>

export async function verifyInstalledModuleArtifact(
  store: ModuleArtifactReadStore,
  descriptor: ModuleArtifactDescriptor,
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
): Promise<VerifiedModuleArtifact> {
  const manifestBytes = await store.readManifestBytes(
    descriptor.id,
    descriptor.version,
  )
  await verifyModuleBytes(
    manifestBytes,
    descriptor.manifest,
    `Module "${descriptor.id}" manifest`,
    subtleCrypto,
  )
  const manifest = parseModuleArtifactManifest(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
  )
  if (
    manifest.id !== descriptor.id ||
    manifest.version !== descriptor.version ||
    manifest.hostApi !== descriptor.hostApi ||
    !equalDataSchemas(manifest.dataSchemas, descriptor.dataSchemas)
  ) {
    throw new Error(`Module "${descriptor.id}" manifest descriptor mismatch`)
  }
  const variant = selectModuleManifestVariant(manifest, descriptor.platform)
  const files = collectInstallableModuleFiles(manifest, descriptor.manifestUrl)

  for (const markerVariant of manifest.variants) {
    const markerBytes = await store.readReadyMarkerBytes(
      descriptor.id,
      descriptor.version,
      markerVariant.platform,
      descriptor.manifest.sha256,
    )
    const marker = parseModuleReadyMarker(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(markerBytes)),
    )
    if (
      marker.id !== descriptor.id ||
      marker.version !== descriptor.version ||
      marker.platform !== markerVariant.platform ||
      marker.manifestSha256 !== descriptor.manifest.sha256
    ) {
      throw new Error(`Module "${descriptor.id}" ready marker mismatch`)
    }
  }

  let entryBytes: Uint8Array | null = null
  for (const file of files) {
    const bytes = await store.readEntryBytes(
      manifest.id,
      manifest.version,
      file.path,
    )
    await verifyModuleBytes(
      bytes,
      file,
      `Module "${manifest.id}" file "${file.path}"`,
      subtleCrypto,
    )
    if (canonicalPath(file.path) === canonicalPath(variant.entry)) {
      entryBytes = bytes
    }
  }
  if (!entryBytes) throw new Error(`Module "${manifest.id}" entry is missing`)
  const expectedPaths = new Set(
    [
      'module.json',
      ...manifest.variants.map((candidate) =>
        moduleReadyMarkerFileName(
          candidate.platform,
          descriptor.manifest.sha256,
        ),
      ),
      ...files.map((file) => file.path),
    ].map(canonicalPath),
  )
  const actualPaths = await store.listVersionFiles(
    manifest.id,
    manifest.version,
  )
  if (
    actualPaths.length !== expectedPaths.size ||
    actualPaths.some((path) => !expectedPaths.has(canonicalPath(path)))
  ) {
    throw new Error(`Module "${manifest.id}" file closure mismatch`)
  }
  return Object.freeze({ manifest, variant, entryBytes })
}

export function collectInstallableModuleFiles(
  manifest: ModuleArtifactManifest,
  manifestUrl: string,
): readonly ModuleArtifactFile[] {
  const releaseParent = moduleArtifactReleaseParent(manifestUrl)
  if (!releaseParent) {
    throw new Error('Module manifest URL is not a GitHub Release URL')
  }
  const files = collectModuleManifestFiles(manifest)
  for (const file of files) {
    if (moduleArtifactReleaseParent(file.url) !== releaseParent) {
      throw new Error(
        `Module artifact file "${file.path}" does not belong to the manifest GitHub Release`,
      )
    }
  }
  return files
}

function canonicalPath(path: string): string {
  return path.normalize('NFKC').toLowerCase()
}

function equalDataSchemas(
  left: ModuleArtifactDataSchemas,
  right: ModuleArtifactDataSchemas,
): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([namespace, schema]) => {
      const expected = right[namespace]
      return (
        expected?.readMin === schema.readMin &&
        expected.readMax === schema.readMax &&
        expected.write === schema.write
      )
    })
  )
}
