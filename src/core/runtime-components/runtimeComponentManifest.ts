import type { RuntimeComponentId } from './contracts'

export type RuntimeComponentPlatform = 'desktop' | 'mobile'

export type RuntimeComponentDescriptor = Readonly<{
  id: RuntimeComponentId
  platforms: readonly RuntimeComponentPlatform[]
  nameKey: string
  descriptionKey: string
  impactKey: string
  entry: string
  byteSize: number
  sha256: string
}>

export type RuntimeComponentRegistry = Readonly<{
  schemaVersion: 1
  components: readonly RuntimeComponentDescriptor[]
}>

const IDS = new Set<RuntimeComponentId>([
  'tokenizer',
  'pdf-engine',
  'pglite-engine',
  'bash-engine',
])
export const MAX_RUNTIME_COMPONENT_BYTES = 16 * 1024 * 1024

export function parseRuntimeComponentRegistry(
  value: unknown,
): RuntimeComponentRegistry {
  const registry = record(value, 'Runtime component registry')
  exactKeys(
    registry,
    ['schemaVersion', 'components'],
    'Runtime component registry',
  )
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.components)) {
    throw new Error('Runtime component registry is invalid')
  }
  const ids = new Set<string>()
  const components = registry.components.map((candidate, index) => {
    const descriptor = record(candidate, `Runtime component ${index}`)
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
      !/^[a-f0-9]{64}$/.test(descriptor.sha256)
    ) {
      throw new Error(`Runtime component ${index} is invalid`)
    }
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
    })
  })
  if (components.length !== IDS.size) {
    throw new Error('Runtime component registry is incomplete')
  }
  return Object.freeze({
    schemaVersion: 1,
    components: Object.freeze(components),
  })
}

export function runtimeComponentReleaseUrl(
  descriptor: RuntimeComponentDescriptor,
  bakedVersion: string,
): string {
  assertRuntimeComponentVersion(bakedVersion)
  return `https://raw.githubusercontent.com/Lapis0x0/obsidian-yolo/${bakedVersion}/${descriptor.entry}`
}

export function runtimeComponentMirrorUrl(
  descriptor: RuntimeComponentDescriptor,
  bakedVersion: string,
): string {
  assertRuntimeComponentVersion(bakedVersion)
  return `https://updates.yoloapp.dev/runtime-components/${bakedVersion}/${descriptor.id}/entry.js`
}

export function resolveRuntimeComponentArtifactSources(
  descriptor: RuntimeComponentDescriptor,
  bakedVersion: string,
): readonly string[] {
  return Object.freeze([
    runtimeComponentMirrorUrl(descriptor, bakedVersion),
    runtimeComponentReleaseUrl(descriptor, bakedVersion),
  ])
}

function assertRuntimeComponentVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error('Production runtime components require a numeric Git tag')
  }
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
