/**
 * Release-protocol rules shared by the first-party module build and by every
 * release validator.
 *
 * A module artifact file declares two independent names:
 *
 * - `path` is where the Host installs the file inside
 *   `<plugin>/modules/<id>/<version>/`. It may be nested, because some
 *   artifacts are inherently trees (a skill package ships as
 *   `skills/<skill>/SKILL.md` plus its references).
 * - `name` is the GitHub Release asset name. A Release has exactly one flat
 *   asset namespace per tag, so a nested `path` has to be folded into a flat
 *   `name` before it can be uploaded.
 *
 * The fold joins the path segments with `__`. A segment may not contain `__`
 * and may not end with `_`; together with the Host's segment rule (a segment
 * always starts with an alphanumeric, so it can never *begin* with `_`) every
 * `__` in a folded name is unambiguously a separator, which makes the fold
 * injective — two different paths can never fold to the same name. A flat
 * `path` folds to itself, so single-segment artifacts keep `name === path`
 * byte-for-byte.
 *
 * Injectivity is not the whole story: two paths may still collide on a
 * case-insensitive file system, or against the flat closure of Release-level
 * assets. `assertReleaseAssetUniqueness` is the single mechanism that rejects
 * those, and both release validators re-run it on the manifest they verify
 * instead of trusting the build.
 */

/** Mirrors `assertModulePathSegment` in `src/core/modules/moduleStore.ts`. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const RESERVED_DEVICE_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/

/** Mirrors the Host's `MAX_MODULE_VERSION_TREE_DEPTH` of 16 nested levels. */
export const MAX_ARTIFACT_PATH_SEGMENTS = 17

/** Mirrors the asset-name cap in `parseModuleReleaseUrl`. */
export const MAX_RELEASE_ASSET_NAME_LENGTH = 255

export const RELEASE_ASSET_SEPARATOR = '__'

/** Release-level assets that own these names in the flat Release namespace. */
export const RESERVED_RELEASE_ASSET_NAMES = new Set([
  'module.json',
  'module-config.json',
  'release-note.md',
])

/**
 * A segment is safe only if it is also usable *as it stands* inside the
 * download URL, because the Host reads the asset name straight out of that URL
 * (`parseModuleReleaseUrl`) and neither decodes it nor accepts a `%`. Every
 * segment of a path ends up in the folded asset name, so both extra rules are
 * checked here rather than only on the fold:
 *
 * - `encodeURIComponent(value) === value` rejects anything the URL builders
 *   would rewrite. Of the characters `SEGMENT` admits that is exactly `+`,
 *   which would ship as `%2B` in the URL and no longer match `name`.
 * - the 255-character cap is the Host's, applied to the folded name.
 *
 * Keeping the release side no looser than the Host is what stops a manifest
 * from passing the build and both validators only to be rejected at install.
 */
export function isSafeArtifactSegment(value) {
  if (
    typeof value !== 'string' ||
    !SEGMENT.test(value) ||
    value.length > MAX_RELEASE_ASSET_NAME_LENGTH ||
    value.normalize('NFC') !== value ||
    value.normalize('NFKC') !== value ||
    encodeURIComponent(value) !== value ||
    value.endsWith('.')
  ) {
    return false
  }
  return !RESERVED_DEVICE_NAMES.test(value.split('.')[0].toUpperCase())
}

export function isSafeArtifactPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\')) return false
  const segments = value.split('/')
  return (
    segments.length <= MAX_ARTIFACT_PATH_SEGMENTS &&
    segments.every(isSafeArtifactSegment)
  )
}

export function assertSafeArtifactPath(value, label) {
  if (!isSafeArtifactPath(value)) {
    throw new Error(
      `${label} must be a safe relative artifact path: ${JSON.stringify(value)}`,
    )
  }
}

/**
 * Folds an installed artifact `path` into its flat Release asset `name`.
 * Throws for any path the fold cannot represent unambiguously.
 */
export function deriveReleaseAssetName(value, label = 'Module artifact path') {
  assertSafeArtifactPath(value, label)
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment.includes(RELEASE_ASSET_SEPARATOR) || segment.endsWith('_')) {
      throw new Error(
        `${label} segment must not contain "${RELEASE_ASSET_SEPARATOR}" or end with "_": ${JSON.stringify(value)}`,
      )
    }
  }
  const name = segments.join(RELEASE_ASSET_SEPARATOR)
  if (!isSafeArtifactSegment(name)) {
    throw new Error(
      `${label} does not fold into a safe Release asset name: ${JSON.stringify(value)}`,
    )
  }
  return name
}

/** Mirrors `canonicalArtifactPath` in `src/core/modules/moduleStore.ts`. */
export function canonicalArtifactKey(value) {
  return value.normalize('NFKC').toLowerCase()
}

/**
 * Rejects any artifact set whose files would collide once installed or once
 * uploaded: duplicate (case-insensitively equal) paths or names, a path that
 * aliases one of its own directories, and the Release-level reserved names.
 */
export function assertReleaseAssetUniqueness(files, label) {
  const paths = new Set()
  const names = new Set()
  const directories = new Set()
  for (const file of files) {
    const canonicalPath = canonicalArtifactKey(file.path)
    const canonicalName = canonicalArtifactKey(file.name)
    if (
      canonicalPath === 'module.json' ||
      RESERVED_RELEASE_ASSET_NAMES.has(canonicalName)
    ) {
      throw new Error(`${label} artifact file is reserved: ${file.path}`)
    }
    if (paths.has(canonicalPath)) {
      throw new Error(`${label} has a duplicate artifact path: ${file.path}`)
    }
    if (names.has(canonicalName)) {
      throw new Error(`${label} has a duplicate asset name: ${file.name}`)
    }
    paths.add(canonicalPath)
    names.add(canonicalName)
    const segments = canonicalPath.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'))
    }
  }
  for (const canonicalPath of paths) {
    if (directories.has(canonicalPath)) {
      throw new Error(
        `${label} artifact path aliases a directory: ${canonicalPath}`,
      )
    }
  }
}
