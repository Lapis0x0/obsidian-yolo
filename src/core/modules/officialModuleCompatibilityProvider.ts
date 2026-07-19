import type {
  OfficialModuleCatalogModule,
  OfficialModuleCompatibility,
  OfficialModulePlatform,
} from './officialModuleCatalog'

export const YOLO_HOST_API_VERSION = '1.1.0'
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
}>

/** Compatibility is limited to the Host API, platform, and update ordering. */
export function createOfficialModuleCompatibilityProvider(
  options: OfficialModuleCompatibilityProviderOptions,
): (
  module: OfficialModuleCatalogModule,
) => Promise<OfficialModuleCompatibility> {
  if (
    !options ||
    (options.platform !== 'desktop' && options.platform !== 'mobile') ||
    typeof options.readDeviceState !== 'function'
  ) {
    throw new TypeError(
      'Official module compatibility provider options are invalid',
    )
  }

  return async (module) => {
    const state = parseDeviceState(
      await options.readDeviceState(module.id),
      module.id,
      options.platform,
    )
    return Object.freeze({
      hostApi: YOLO_HOST_API_VERSION,
      platform: options.platform,
      ...(state?.activeVersion ? { activeVersion: state.activeVersion } : {}),
    })
  }
}

function parseDeviceState(
  value: unknown,
  moduleId: string,
  platform: OfficialModulePlatform,
): OfficialModuleCompatibilityDeviceState | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      `Device state for official module "${moduleId}" is invalid`,
    )
  }
  const state = value as Record<string, unknown>
  const activeVersion = state.activeVersion
  if (
    state.moduleId !== moduleId ||
    state.platform !== platform ||
    (activeVersion !== null &&
      (typeof activeVersion !== 'string' || !SEMVER.test(activeVersion)))
  ) {
    throw new TypeError(
      `Device state for official module "${moduleId}" is invalid`,
    )
  }
  return { moduleId, platform, activeVersion }
}
