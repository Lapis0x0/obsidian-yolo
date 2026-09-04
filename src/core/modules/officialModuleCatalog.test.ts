import {
  type OfficialModuleCatalogVersion,
  type OfficialModulePlatform,
  compareOfficialModuleVersions,
  getOfficialModuleVersionCompatibilityIssues,
  isHostApiCompatible,
  isModuleHostApiRange,
} from './officialModuleCatalog'

function candidate(
  overrides: Partial<OfficialModuleCatalogVersion> = {},
): OfficialModuleCatalogVersion {
  return {
    version: '1.0.0',
    hostApi: '>=1.2.0 <2.0.0',
    platforms: ['desktop'],
    dataSchemas: { learning: { readMin: 1, readMax: 3, write: 3 } },
    manifestUrl:
      'https://github.com/yolo-official/learning/releases/download/v1.0.0/module.json',
    manifest: { byteSize: 123, sha256: 'a'.repeat(64) },
    ...overrides,
  }
}

describe('official module compatibility', () => {
  it('accepts one manifest that declares both desktop and mobile', () => {
    const both = candidate({ platforms: ['mobile', 'desktop'] })
    for (const platform of ['desktop', 'mobile'] as const) {
      expect(
        getOfficialModuleVersionCompatibilityIssues(both, {
          hostApi: '1.3.0',
          platform,
        }),
      ).toEqual([])
    }
  })

  it('reports the platform and Host API issues of one candidate', () => {
    expect(
      getOfficialModuleVersionCompatibilityIssues(
        candidate({ platforms: ['mobile'] }),
        { hostApi: '1.3.0', platform: 'desktop' },
      ),
    ).toEqual(['platform'])

    expect(
      getOfficialModuleVersionCompatibilityIssues(
        candidate({ hostApi: '^1.2.0' }),
        { hostApi: '2.0.0', platform: 'desktop' },
      ),
    ).toEqual(['host-api'])
  })

  it('rejects an invalid platform or Host API from the composition root', () => {
    expect(() =>
      getOfficialModuleVersionCompatibilityIssues(candidate(), {
        hostApi: '1.3.0',
        platform: 'watch' as OfficialModulePlatform,
      }),
    ).toThrow()
    expect(() =>
      getOfficialModuleVersionCompatibilityIssues(candidate(), {
        hostApi: 'not-a-version',
        platform: 'desktop',
      }),
    ).toThrow()
  })

  it('does not satisfy a stable range with a prerelease Host API', () => {
    expect(isHostApiCompatible('1.3.0-beta.2', '>=1.2.0 <2.0.0')).toBe(false)
    expect(isHostApiCompatible('1.3.0-beta.2', '>=1.3.0-beta.1 <2.0.0')).toBe(
      true,
    )
    expect(isHostApiCompatible('1.3.0', '>=1.2.0 <2.0.0')).toBe(true)
  })

  it('rejects an unparseable running Host API and an unsatisfiable range', () => {
    expect(() => isHostApiCompatible('not-a-version', '*')).toThrow(
      'Host API version is invalid',
    )
    expect(isHostApiCompatible('1.3.0', 'nonsense range')).toBe(false)
  })
})

describe('module Host API ranges', () => {
  it('accepts the range shapes the Feed is allowed to publish', () => {
    for (const range of ['*', '^1.2.0', '>=1.2.0 <2.0.0', '1.2.0 || 1.3.0']) {
      expect(isModuleHostApiRange(range)).toBe(true)
    }
  })

  it('rejects unparseable ranges and ranges built to be expensive', () => {
    expect(isModuleHostApiRange('')).toBe(false)
    expect(isModuleHostApiRange('nonsense range')).toBe(false)
    expect(isModuleHostApiRange(1)).toBe(false)
    expect(
      isModuleHostApiRange(
        Array.from({ length: 9 }, (_unused, index) => `1.${index}.0`).join(
          ' || ',
        ),
      ),
    ).toBe(false)
    expect(
      isModuleHostApiRange(
        Array.from({ length: 17 }, () => '>=1.0.0').join(' '),
      ),
    ).toBe(false)
  })
})

describe('official module version ordering', () => {
  it('orders huge SemVer components without losing precision', () => {
    expect(
      compareOfficialModuleVersions(
        '9007199254740993.0.0',
        '9007199254740992.999999999999999999999.0',
      ),
    ).toBeGreaterThan(0)
    expect(compareOfficialModuleVersions('1.0.0', '1.0.0')).toBe(0)
    expect(() => compareOfficialModuleVersions('1.0.0', 'v1')).toThrow()
  })
})
