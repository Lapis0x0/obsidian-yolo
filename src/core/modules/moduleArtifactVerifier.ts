import { verifyModuleBytes } from './moduleIntegrity'
import {
  type ModuleArtifactManifest,
  type ModuleStore,
  parseModuleArtifactManifest,
  parseModuleReadyMarker,
} from './moduleStore'

export type ModuleArtifactDescriptor = Readonly<{
  id: string
  version: string
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
  entryBytes: Uint8Array
}>

export async function verifyInstalledModuleArtifact(
  store: ModuleArtifactReadStore,
  descriptor: ModuleArtifactDescriptor,
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
): Promise<VerifiedModuleArtifact> {
  const markerBytes = await store.readReadyMarkerBytes(
    descriptor.id,
    descriptor.version,
  )
  const marker = parseModuleReadyMarker(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(markerBytes)),
  )
  if (
    marker.id !== descriptor.id ||
    marker.version !== descriptor.version ||
    marker.manifestSha256 !== descriptor.manifest.sha256
  ) {
    throw new Error(`Module "${descriptor.id}" ready marker mismatch`)
  }

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
    manifest.version !== descriptor.version
  ) {
    throw new Error(`Module "${descriptor.id}" manifest identity mismatch`)
  }

  let entryBytes: Uint8Array | null = null
  for (const file of manifest.files) {
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
    if (file.role === 'entry') entryBytes = bytes
  }
  if (!entryBytes) throw new Error(`Module "${manifest.id}" entry is missing`)
  const expectedPaths = new Set(
    [
      'module.json',
      'ready.json',
      ...manifest.files.map((file) => file.path),
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
  return Object.freeze({ manifest, entryBytes })
}

function canonicalPath(path: string): string {
  return path.normalize('NFC').toLowerCase()
}
