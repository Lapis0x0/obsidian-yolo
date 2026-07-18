import type {
  OfficialModuleCatalogModule,
  OfficialModuleCompatibility,
  OfficialModulePlatform,
} from './officialModuleCatalog'

export const YOLO_HOST_API_VERSION = '1.1.0'
export const OFFICIAL_MODULE_SETTINGS_DATA_NAMESPACE = 'settings'
const SUPPORTED_DATA_NAMESPACES = Object.freeze([
  OFFICIAL_MODULE_SETTINGS_DATA_NAMESPACE,
])

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export type OfficialModuleCompatibilityDeviceState = Readonly<{
  moduleId: string
  platform: OfficialModulePlatform
  activeVersion: string | null
}>

export type OfficialModuleCompatibilityProviderOptions = Readonly<{
  platform: OfficialModulePlatform
  readDeviceState(
    moduleId: string,
  ):
    | OfficialModuleCompatibilityDeviceState
    | null
    | Promise<OfficialModuleCompatibilityDeviceState | null>
  /** Returns the current config envelope schema. Callers represent absence as 0. */
  readSettingsSchemaVersion(moduleId: string): number | Promise<number>
}>

/** Builds compatibility from host-owned state without loading module code. */
export function createOfficialModuleCompatibilityProvider(
  options: OfficialModuleCompatibilityProviderOptions,
): (
  module: OfficialModuleCatalogModule,
) => Promise<OfficialModuleCompatibility> {
  assertOptions(options)

  return async (module) => {
    const namespaces = collectNamespaces(module)
    const state = parseDeviceState(
      await options.readDeviceState(module.id),
      module.id,
      options.platform,
    )
    const dataSchemas = Object.create(null) as Record<string, number>
    if (namespaces.includes(OFFICIAL_MODULE_SETTINGS_DATA_NAMESPACE)) {
      const schemaVersion = await options.readSettingsSchemaVersion(module.id)
      if (!isSchemaVersion(schemaVersion)) {
        throw new TypeError(
          `Settings schema version for official module "${module.id}" is invalid`,
        )
      }
      dataSchemas[OFFICIAL_MODULE_SETTINGS_DATA_NAMESPACE] = schemaVersion
    }

    return Object.freeze({
      hostApi: YOLO_HOST_API_VERSION,
      platform: options.platform,
      dataSchemas: Object.freeze(dataSchemas),
      supportedDataNamespaces: SUPPORTED_DATA_NAMESPACES,
      ...(state !== null && state.activeVersion !== null
        ? { activeVersion: state.activeVersion }
        : {}),
    })
  }
}

function assertOptions(
  options: OfficialModuleCompatibilityProviderOptions,
): void {
  if (
    !options ||
    (options.platform !== 'desktop' && options.platform !== 'mobile') ||
    typeof options.readDeviceState !== 'function' ||
    typeof options.readSettingsSchemaVersion !== 'function'
  ) {
    throw new TypeError(
      'Official module compatibility provider options are invalid',
    )
  }
}

function collectNamespaces(module: OfficialModuleCatalogModule): string[] {
  const namespaces = new Set<string>()
  for (const version of module.versions) {
    for (const namespace of Object.keys(version.dataSchemas)) {
      namespaces.add(namespace)
    }
  }
  return [...namespaces].sort()
}

function parseDeviceState(
  value: unknown,
  moduleId: string,
  platform: OfficialModulePlatform,
): OfficialModuleCompatibilityDeviceState | null {
  if (value === null) return null
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new TypeError(
      `Device state for official module "${moduleId}" is invalid`,
    )
  }

  const state = value as Record<string, unknown>
  const stateModuleId = readDataProperty(state, 'moduleId')
  const statePlatform = readDataProperty(state, 'platform')
  const activeVersion = readDataProperty(state, 'activeVersion')
  if (
    stateModuleId !== moduleId ||
    statePlatform !== platform ||
    (activeVersion !== null &&
      (typeof activeVersion !== 'string' || !SEMVER.test(activeVersion)))
  ) {
    throw new TypeError(
      `Device state for official module "${moduleId}" is invalid`,
    )
  }
  return {
    moduleId,
    platform,
    activeVersion,
  }
}

function readDataProperty(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`Device state property "${name}" is invalid`)
  }
  return descriptor.value
}

function isSchemaVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
