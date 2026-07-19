import type { OfficialModuleCatalogModule } from './officialModuleCatalog'
import {
  YOLO_HOST_API_VERSION,
  createOfficialModuleCompatibilityProvider,
} from './officialModuleCompatibilityProvider'

const catalogModule: OfficialModuleCatalogModule = {
  id: 'learning',
  versions: [],
}

describe('createOfficialModuleCompatibilityProvider', () => {
  it('returns only host, platform, and an optional active version', async () => {
    const provider = createOfficialModuleCompatibilityProvider({
      platform: 'desktop',
      readDeviceState: async (moduleId) => ({
        moduleId,
        platform: 'desktop',
        activeVersion: '1.2.3',
      }),
    })

    await expect(provider(catalogModule)).resolves.toEqual({
      hostApi: YOLO_HOST_API_VERSION,
      platform: 'desktop',
      activeVersion: '1.2.3',
    })
  })

  it('omits an absent active version', async () => {
    const provider = createOfficialModuleCompatibilityProvider({
      platform: 'mobile',
      readDeviceState: async () => null,
    })

    await expect(provider(catalogModule)).resolves.toEqual({
      hostApi: YOLO_HOST_API_VERSION,
      platform: 'mobile',
    })
  })

  it.each([
    ['non-object state', 'bad'],
    [
      'wrong id',
      { moduleId: 'other', platform: 'desktop', activeVersion: null },
    ],
    [
      'wrong platform',
      { moduleId: 'learning', platform: 'mobile', activeVersion: null },
    ],
    [
      'invalid version',
      { moduleId: 'learning', platform: 'desktop', activeVersion: 'latest' },
    ],
  ])('rejects malformed device state: %s', async (_label, state) => {
    const provider = createOfficialModuleCompatibilityProvider({
      platform: 'desktop',
      readDeviceState: async () => state as never,
    })
    await expect(provider(catalogModule)).rejects.toThrow(
      /Device state .* is invalid/,
    )
  })

  it.each([
    null,
    {},
    { platform: 'web', readDeviceState: () => null },
    { platform: 'desktop', readDeviceState: null },
  ])('rejects invalid options %#', (value) => {
    expect(() =>
      createOfficialModuleCompatibilityProvider(value as never),
    ).toThrow('Official module compatibility provider options are invalid')
  })
})
