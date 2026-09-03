import type { RuntimeComponentId } from './contracts'

export type RuntimeComponentPlatform = 'desktop' | 'mobile'

/**
 * A file the component needs alongside `entry.js` (WASM binaries, etc.) that
 * isn't executable JS and isn't loaded via `<script>`. `path` is always
 * `runtime-components/<id>/dist/assets/<name>` — the one fixed location the
 * build script writes to, mirroring how `entry` has exactly one valid value
 * per component. The host installs it next to `entry.js` and hands its bytes
 * to the component only through an injected callback (see
 * `readRuntimeComponentAsset`); the component never reads it directly.
 */
export type RuntimeComponentAssetDescriptor = Readonly<{
  name: string
  path: string
  byteSize: number
  sha256: string
}>

export type RuntimeComponentDescriptor = Readonly<{
  id: RuntimeComponentId
  platforms: readonly RuntimeComponentPlatform[]
  nameKey: string
  descriptionKey: string
  impactKey: string
  entry: string
  byteSize: number
  sha256: string
  /** Absent (or empty) for components with no attached assets. */
  assets?: readonly RuntimeComponentAssetDescriptor[]
}>

export type RuntimeComponentRegistry = Readonly<{
  schemaVersion: 2
  components: readonly RuntimeComponentDescriptor[]
}>

const IDS = new Set<RuntimeComponentId>([
  'tokenizer',
  'pdf-engine',
  'bash-engine',
  'embedding-engine',
])
export const MAX_RUNTIME_COMPONENT_BYTES = 16 * 1024 * 1024
/** WASM assets (e.g. ONNX Runtime) run much larger than a component's own entry.js. */
export const MAX_RUNTIME_COMPONENT_ASSET_BYTES = 64 * 1024 * 1024
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const SHA256_PATTERN = /^[a-f0-9]{64}$/

function parseAssets(
  value: unknown,
  componentId: string,
  label: string,
): readonly RuntimeComponentAssetDescriptor[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} has an invalid assets list`)
  }
  const names = new Set<string>()
  const assets = value.map((candidate, index) => {
    const asset = record(candidate, `${label} asset ${index}`)
    exactKeys(
      asset,
      ['name', 'path', 'byteSize', 'sha256'],
      `${label} asset ${index}`,
    )
    if (
      typeof asset.name !== 'string' ||
      !ASSET_NAME_PATTERN.test(asset.name) ||
      names.has(asset.name) ||
      asset.path !==
        `runtime-components/${componentId}/dist/assets/${asset.name}` ||
      !Number.isSafeInteger(asset.byteSize) ||
      (asset.byteSize as number) <= 0 ||
      (asset.byteSize as number) > MAX_RUNTIME_COMPONENT_ASSET_BYTES ||
      typeof asset.sha256 !== 'string' ||
      !SHA256_PATTERN.test(asset.sha256)
    ) {
      throw new Error(`${label} asset ${index} is invalid`)
    }
    names.add(asset.name)
    return Object.freeze({
      name: asset.name,
      path: asset.path,
      byteSize: asset.byteSize as number,
      sha256: asset.sha256,
    })
  })
  return Object.freeze(assets)
}

/**
 * Parses a runtime component registry — schema v1 (no `assets`, the shape
 * every registry had before this component's `assets` extension) or v2 —
 * normalizing either into the current `RuntimeComponentRegistry` shape.
 * Deliberately does NOT require every currently-known component id to be
 * present: this function's job is "is this a well-formed registry", not "is
 * this *the* current baked registry" — see
 * `assertCompleteRuntimeComponentRegistry` for the latter, which is what
 * `bakedRuntimeComponentRegistry.ts` actually needs (the host only ever
 * loads its own freshly-built registry, always complete and always v2).
 * Kept separate so a well-formed *historical* registry — schema v1, or a v2
 * registry from a tag that only had some of today's components — parses
 * successfully too.
 */
export function parseRuntimeComponentRegistry(
  value: unknown,
): RuntimeComponentRegistry {
  const registry = record(value, 'Runtime component registry')
  exactKeys(
    registry,
    ['schemaVersion', 'components'],
    'Runtime component registry',
  )
  if (
    (registry.schemaVersion !== 1 && registry.schemaVersion !== 2) ||
    !Array.isArray(registry.components)
  ) {
    throw new Error('Runtime component registry is invalid')
  }
  const ids = new Set<string>()
  const components = registry.components.map((candidate, index) => {
    const descriptor = record(candidate, `Runtime component ${index}`)
    const keys = Object.keys(descriptor)
    const hasAssets = keys.includes('assets')
    if (registry.schemaVersion === 1 && hasAssets) {
      throw new Error(
        `Runtime component ${index} declares assets under schema v1`,
      )
    }
    exactKeys(
      descriptor,
      [
        'id',
        'platforms',
        'nameKey',
        'descriptionKey',
        'impactKey',
        'entry',
        'byteSize',
        'sha256',
        ...(hasAssets ? (['assets'] as const) : []),
      ],
      `Runtime component ${index}`,
    )
    if (
      typeof descriptor.id !== 'string' ||
      !IDS.has(descriptor.id as RuntimeComponentId) ||
      ids.has(descriptor.id) ||
      !Array.isArray(descriptor.platforms) ||
      descriptor.platforms.length === 0 ||
      descriptor.platforms.some(
        (platform) => platform !== 'desktop' && platform !== 'mobile',
      ) ||
      new Set(descriptor.platforms).size !== descriptor.platforms.length ||
      typeof descriptor.nameKey !== 'string' ||
      typeof descriptor.descriptionKey !== 'string' ||
      typeof descriptor.impactKey !== 'string' ||
      descriptor.entry !==
        `runtime-components/${descriptor.id}/dist/entry.js` ||
      !Number.isSafeInteger(descriptor.byteSize) ||
      (descriptor.byteSize as number) <= 0 ||
      (descriptor.byteSize as number) > MAX_RUNTIME_COMPONENT_BYTES ||
      typeof descriptor.sha256 !== 'string' ||
      !SHA256_PATTERN.test(descriptor.sha256)
    ) {
      throw new Error(`Runtime component ${index} is invalid`)
    }
    const assets = parseAssets(
      descriptor.assets,
      descriptor.id,
      `Runtime component ${index}`,
    )
    ids.add(descriptor.id)
    return Object.freeze({
      id: descriptor.id as RuntimeComponentId,
      platforms: Object.freeze([
        ...descriptor.platforms,
      ] as RuntimeComponentPlatform[]),
      nameKey: descriptor.nameKey,
      descriptionKey: descriptor.descriptionKey,
      impactKey: descriptor.impactKey,
      entry: descriptor.entry,
      byteSize: descriptor.byteSize as number,
      sha256: descriptor.sha256,
      ...(assets ? { assets } : {}),
    })
  })
  return Object.freeze({
    schemaVersion: 2,
    components: Object.freeze(components),
  })
}

/**
 * Asserts `registry` is the CURRENT baked registry: exactly one descriptor
 * per id in `IDS`, no more, no fewer. Only `bakedRuntimeComponentRegistry.ts`
 * needs this — the host always ships a freshly-built registry that must
 * cover every component it knows about — so it's split out from the generic
 * `parseRuntimeComponentRegistry` above, which also has to accept a
 * historical registry (schema v1, or a v2 tag predating a newer component)
 * that legitimately lists fewer ids.
 */
export function assertCompleteRuntimeComponentRegistry(
  registry: RuntimeComponentRegistry,
): void {
  if (registry.components.length !== IDS.size) {
    throw new Error('Runtime component registry is incomplete')
  }
}

/**
 * Every runtime component artifact — each component's `entry.js` and every
 * declared asset — is attached to one permanent, append-only Release,
 * `runtime-assets`, under a content-addressed name. Nothing here is
 * versioned by Core, and that is the point: `dist/` is gitignored (see
 * `.gitignore`), so there is nothing to fetch from a tagged Git ref, and
 * naming the bytes after the Core version that happened to ship them made
 * every Core release store another byte-identical copy (the embedding
 * engine's WASM alone is ~13 MB) forever, since nothing prunes superseded
 * versions.
 *
 * The URL never has to be trusted: the registry baked into this build
 * declares each artifact's byteSize and sha256, and `RuntimeComponentInstaller`
 * verifies the downloaded bytes against them before anything is promoted
 * out of staging. The hash is the contract; the URL only answers "where".
 *
 * Mirrors `RUNTIME_ASSET_TAG` / `runtimeAssetReleaseName` in
 * `scripts/runtimeComponentReleaseAssets.mjs` (which owns the upload side
 * and can't be imported here — it would pull build tooling into the host
 * bundle). The two are cross-checked by a consistency test in
 * `scripts/runtimeComponentReleaseAssets.test.mjs`.
 */
const RUNTIME_ASSET_TAG = 'runtime-assets'

function runtimeAssetReleaseUrl(sha256: string, name: string): string {
  return `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${RUNTIME_ASSET_TAG}/${sha256}-${name}`
}

export function runtimeComponentReleaseUrl(
  descriptor: RuntimeComponentDescriptor,
): string {
  return runtimeAssetReleaseUrl(descriptor.sha256, 'entry.js')
}

/**
 * The mirror is content-addressed for the same reason the Release
 * attachment above is, and lands on the identical `{sha256}/{name}` shape —
 * one artifact, one set of bytes, two interchangeable places to get them.
 */
export function runtimeComponentMirrorUrl(
  descriptor: RuntimeComponentDescriptor,
): string {
  return `https://updates.yoloapp.dev/runtime-components/sha256/${descriptor.sha256}/entry.js`
}

export function resolveRuntimeComponentArtifactSources(
  descriptor: RuntimeComponentDescriptor,
): readonly string[] {
  return Object.freeze([
    runtimeComponentMirrorUrl(descriptor),
    runtimeComponentReleaseUrl(descriptor),
  ])
}

export function runtimeComponentAssetReleaseUrl(
  asset: RuntimeComponentAssetDescriptor,
): string {
  return runtimeAssetReleaseUrl(asset.sha256, asset.name)
}

export function runtimeComponentAssetMirrorUrl(
  asset: RuntimeComponentAssetDescriptor,
): string {
  return `https://updates.yoloapp.dev/runtime-components/sha256/${asset.sha256}/${asset.name}`
}

export function resolveRuntimeComponentAssetSources(
  asset: RuntimeComponentAssetDescriptor,
): readonly string[] {
  return Object.freeze([
    runtimeComponentAssetMirrorUrl(asset),
    runtimeComponentAssetReleaseUrl(asset),
  ])
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value)
  const unknown = keys.find((key) => !expected.includes(key))
  const missing = expected.find((key) => !keys.includes(key))
  if (unknown) throw new Error(`${label} has unknown field ${unknown}`)
  if (missing) throw new Error(`${label} is missing field ${missing}`)
}
