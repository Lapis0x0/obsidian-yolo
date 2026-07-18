import type {
  OfficialModuleCatalogModule,
  OfficialModuleCatalogVersion,
} from './officialModuleCatalog'
import {
  OFFICIAL_MODULE_SETTINGS_DATA_NAMESPACE,
  type OfficialModuleCompatibilityProviderOptions,
  YOLO_HOST_API_VERSION,
  createOfficialModuleCompatibilityProvider,
} from './officialModuleCompatibilityProvider'

function catalogVersion(
  dataSchemas: OfficialModuleCatalogVersion['dataSchemas'],
): OfficialModuleCatalogVersion {
  return {
    version: '1.0.0',
    hostApi: '^1.0.0',
    platforms: ['desktop'],
    dataSchemas,
    manifestUrl:
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/v1.0.0/learning.json',
    manifest: { byteSize: 1, sha256: 'a'.repeat(64) },
  }
}

function catalogModule(
  ...schemas: OfficialModuleCatalogVersion['dataSchemas'][]
): OfficialModuleCatalogModule {
  return {
    id: 'learning',
    versions: schemas.map(catalogVersion),
  }
}

function options(
  overrides: Partial<OfficialModuleCompatibilityProviderOptions> = {},
): OfficialModuleCompatibilityProviderOptions {
  return {
    platform: 'desktop',
    readDeviceState: async (moduleId) => ({
      moduleId,
      platform: 'desktop',
      activeVersion: null,
    }),
    readSettingsSchemaVersion: async () => 3,
    ...overrides,
  }
}

const SETTINGS = {
  settings: { readMin: 0, readMax: 3, write: 3 },
} as const

describe('createOfficialModuleCompatibilityProvider', () => {
  it('represents an uninstalled module with caller-supplied settings schema 0', async () => {
    const readDeviceState = jest.fn(async () => null)
    const readSettingsSchemaVersion = jest.fn(async () => 0)
    const provider = createOfficialModuleCompatibilityProvider(
      options({ readDeviceState, readSettingsSchemaVersion }),
    )

    await expect(provider(catalogModule(SETTINGS))).resolves.toEqual({
      hostApi: '1.0.0',
      platform: 'desktop',
      dataSchemas: { settings: 0 },
      supportedDataNamespaces: ['settings'],
    })
    expect(readDeviceState).toHaveBeenCalledWith('learning')
    expect(readSettingsSchemaVersion).toHaveBeenCalledWith('learning')
  })

  it('includes the active version from matching device state', async () => {
    const provider = createOfficialModuleCompatibilityProvider(
      options({
        platform: 'mobile',
        readDeviceState: async (moduleId) => ({
          moduleId,
          platform: 'mobile',
          activeVersion: '2.1.0-beta.1',
        }),
      }),
    )

    await expect(provider(catalogModule(SETTINGS))).resolves.toMatchObject({
      platform: 'mobile',
      activeVersion: '2.1.0-beta.1',
    })
  })

  it('reports only known persisted schemas while declaring supported namespaces', async () => {
    const readDeviceState = jest.fn(async () => null)
    const readSettingsSchemaVersion = jest.fn(async () => 0)
    const provider = createOfficialModuleCompatibilityProvider(
      options({ readDeviceState, readSettingsSchemaVersion }),
    )
    const module = catalogModule(
      { zeta: { readMin: 0, readMax: 1, write: 1 }, ...SETTINGS },
      { alpha: { readMin: 0, readMax: 1, write: 1 } },
    )

    await expect(provider(module)).resolves.toMatchObject({
      dataSchemas: { settings: 0 },
      supportedDataNamespaces: ['settings'],
    })
    expect(readDeviceState).toHaveBeenCalledTimes(1)
    expect(readSettingsSchemaVersion).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['non-object state', 'bad'],
    [
      'wrong module id',
      { moduleId: 'other', platform: 'desktop', activeVersion: null },
    ],
    [
      'wrong platform',
      { moduleId: 'learning', platform: 'mobile', activeVersion: null },
    ],
    [
      'invalid active version',
      { moduleId: 'learning', platform: 'desktop', activeVersion: 'latest' },
    ],
  ])('rejects malformed reader output: %s', async (_label, state) => {
    const provider = createOfficialModuleCompatibilityProvider(
      options({ readDeviceState: async () => state as never }),
    )

    await expect(provider(catalogModule(SETTINGS))).rejects.toThrow(
      /Device state .* is invalid/,
    )
  })

  it.each([-1, 1.5, Number.NaN, '1'])(
    'rejects malformed settings schema output %p',
    async (schemaVersion) => {
      const provider = createOfficialModuleCompatibilityProvider(
        options({
          readSettingsSchemaVersion: async () => schemaVersion as never,
        }),
      )

      await expect(provider(catalogModule(SETTINGS))).rejects.toThrow(
        'Settings schema version for official module "learning" is invalid',
      )
    },
  )

  it('returns deterministic deeply frozen compatibility data', async () => {
    const provider = createOfficialModuleCompatibilityProvider(options())
    const module = catalogModule(SETTINGS, SETTINGS)

    const first = await provider(module)
    const second = await provider(module)

    expect(first).toEqual(second)
    expect(Object.keys(first.dataSchemas)).toEqual([
      OFFICIAL_MODULE_SETTINGS_DATA_NAMESPACE,
    ])
    expect(first.hostApi).toBe(YOLO_HOST_API_VERSION)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.dataSchemas)).toBe(true)
    expect(Object.isFrozen(first.supportedDataNamespaces)).toBe(true)
  })

  it.each([
    null,
    {},
    {
      platform: 'web',
      readDeviceState: () => null,
      readSettingsSchemaVersion: (): number => 0,
    },
    {
      platform: 'desktop',
      readDeviceState: null,
      readSettingsSchemaVersion: (): number => 0,
    },
    {
      platform: 'desktop',
      readDeviceState: () => null,
      readSettingsSchemaVersion: null,
    },
  ])('rejects invalid options %#', (value) => {
    expect(() =>
      createOfficialModuleCompatibilityProvider(value as never),
    ).toThrow('Official module compatibility provider options are invalid')
  })
})
