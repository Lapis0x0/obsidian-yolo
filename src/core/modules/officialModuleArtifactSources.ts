import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import {
  isOfficialModuleReleaseUrl,
  parseModuleReleaseUrl,
} from './moduleReleaseUrl'
import {
  assertModuleId,
  assertModulePathSegment,
  normalizeModuleArtifactFilePath,
} from './moduleStore'

const PAGES_ROOT = 'https://updates.yoloapp.dev/modules/'

export type ModuleArtifactSourceRequest = Readonly<{
  descriptor: ModuleArtifactDescriptor
  canonicalUrl: string
  path: string
}>

/** Resolves ordered transport sources without changing the signed artifact identity. */
export function resolveOfficialModuleArtifactSources(
  request: ModuleArtifactSourceRequest,
): readonly string[] {
  const { descriptor, canonicalUrl } = request
  const release = parseModuleReleaseUrl(canonicalUrl)
  if (
    !release ||
    !isOfficialModuleReleaseUrl(canonicalUrl) ||
    release.tag !== `${descriptor.id}/v${descriptor.version}`
  ) {
    return Object.freeze([canonicalUrl])
  }
  assertModuleId(descriptor.id, 'Module id')
  assertModulePathSegment(descriptor.version, 'Module version')
  const path = normalizeModuleArtifactFilePath(request.path)
  const mirrorUrl = `${PAGES_ROOT}${[
    descriptor.id,
    descriptor.version,
    ...path.split('/'),
  ]
    .map(encodeURIComponent)
    .join('/')}`
  return Object.freeze([mirrorUrl, canonicalUrl])
}

export function isOfficialModuleArtifactSourceUrl(
  value: unknown,
): value is string {
  if (isOfficialModuleReleaseUrl(value)) return true
  if (typeof value !== 'string' || !value.startsWith(PAGES_ROOT)) return false
  const suffix = value.slice(PAGES_ROOT.length)
  const parts = suffix.split('/')
  if (parts.length < 3 || parts.some((part) => !part)) return false
  try {
    const decoded = parts.map((part) => decodeURIComponent(part))
    assertModuleId(decoded[0], 'Module id')
    assertModulePathSegment(decoded[1], 'Module version')
    const path = normalizeModuleArtifactFilePath(decoded.slice(2).join('/'))
    return (
      value ===
      `${PAGES_ROOT}${[decoded[0], decoded[1], ...path.split('/')]
        .map(encodeURIComponent)
        .join('/')}`
    )
  } catch {
    return false
  }
}
