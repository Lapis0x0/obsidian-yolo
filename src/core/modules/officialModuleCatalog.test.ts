import {
  type OfficialModuleCatalogParserOptions,
  findCompatibleUpdate,
  parseOfficialModuleCatalog,
  selectInitialCompatibleVersion,
} from './officialModuleCatalog'

const HASH = 'A'.repeat(64)
const OPTIONS: OfficialModuleCatalogParserOptions = {
  allowedRepositories: [{ owner: 'yolo-official', repo: 'learning' }],
}

function version(
  value: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: value,
    hostApi: '>=1.2.0 <2.0.0',
    platforms: ['desktop'],
    dataSchemas: {
      learning: { readMin: 1, readMax: 3, write: 3 },
    },
    manifestUrl: `https://github.com/yolo-official/learning/releases/download/v${value}/module.json`,
    manifest: { byteSize: 123, sha256: HASH },
    ...overrides,
  }
}

function catalog(modules: unknown[]): unknown {
  return { schemaVersion: 1, modules }
}

function parse(input: unknown, options = OPTIONS) {
  return parseOfficialModuleCatalog(JSON.stringify(input), options)
}

function moduleWithVersions(...versions: Record<string, unknown>[]) {
  return parse(catalog([{ id: 'learning', versions }])).modules[0]
}

describe('official module catalog V1', () => {
  it('parses raw text and bytes into frozen null-prototype output', () => {
    const input = catalog([
      {
        id: 'learning',
        name: 'Learning',
        description: 'Official learning module',
        versions: [version('1.0.0')],
      },
    ])
    const parsed = parseOfficialModuleCatalog(
      new TextEncoder().encode(JSON.stringify(input)),
      OPTIONS,
    )

    expect(parsed.modules[0]?.versions[0]?.manifest.sha256).toBe(
      HASH.toLowerCase(),
    )
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.getPrototypeOf(parsed)).toBeNull()
    expect(
      Object.getPrototypeOf(parsed.modules[0]?.versions[0]?.dataSchemas),
    ).toBeNull()
  })

  it.each([
    ['root', { schemaVersion: 1, modules: [], extra: true }],
    [
      'module',
      catalog([{ id: 'learning', versions: [version('1.0.0')], extra: true }]),
    ],
    [
      'version',
      catalog([
        { id: 'learning', versions: [version('1.0.0', { extra: true })] },
      ]),
    ],
    [
      'manifest',
      catalog([
        {
          id: 'learning',
          versions: [
            version('1.0.0', {
              manifest: { byteSize: 1, sha256: HASH, extra: true },
            }),
          ],
        },
      ]),
    ],
    [
      'schema declaration',
      catalog([
        {
          id: 'learning',
          versions: [
            version('1.0.0', {
              dataSchemas: {
                learning: { readMin: 1, readMax: 1, write: 1, extra: true },
              },
            }),
          ],
        },
      ]),
    ],
  ])('rejects an unknown critical field at %s', (_label, input) => {
    expect(() => parse(input)).toThrow(/unknown field/)
  })

  it.each([
    [
      'invalid module id',
      catalog([{ id: 'Learning!', versions: [version('1.0.0')] }]),
    ],
    [
      'invalid semver',
      catalog([{ id: 'learning', versions: [version('01.0.0')] }]),
    ],
    [
      'invalid range',
      catalog([
        {
          id: 'learning',
          versions: [version('1.0.0', { hostApi: 'not-a-range' })],
        },
      ]),
    ],
    [
      'invalid hash',
      catalog([
        {
          id: 'learning',
          versions: [
            version('1.0.0', { manifest: { byteSize: 1, sha256: 'bad' } }),
          ],
        },
      ]),
    ],
    [
      'empty schemas',
      catalog([
        { id: 'learning', versions: [version('1.0.0', { dataSchemas: {} })] },
      ]),
    ],
    [
      'invalid schema range',
      catalog([
        {
          id: 'learning',
          versions: [
            version('1.0.0', {
              dataSchemas: {
                learning: { readMin: 3, readMax: 2, write: 3 },
              },
            }),
          ],
        },
      ]),
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => parse(input)).toThrow()
  })

  it('enforces the caller-owned GitHub repository allowlist', () => {
    const attacker = catalog([
      {
        id: 'learning',
        versions: [
          version('1.0.0', {
            manifestUrl:
              'https://github.com/attacker/learning/releases/download/v1.0.0/module.json',
          }),
        ],
      },
    ])
    expect(() => parse(attacker)).toThrow()
    expect(() =>
      parseOfficialModuleCatalog(
        JSON.stringify({
          schemaVersion: 1,
          modules: [
            {
              id: 'learning',
              versions: [version('1.0.0')],
            },
          ],
          allowedRepositories: [{ owner: 'attacker', repo: 'learning' }],
        }),
        OPTIONS,
      ),
    ).toThrow(/unknown field/)
  })

  it('rejects non-release and HTTP URLs', () => {
    for (const manifestUrl of [
      'https://example.com/module.json',
      'http://github.com/yolo-official/learning/releases/download/v1/module.json',
    ]) {
      expect(() =>
        parse(
          catalog([
            {
              id: 'learning',
              versions: [version('1.0.0', { manifestUrl })],
            },
          ]),
        ),
      ).toThrow()
    }
  })

  it('rejects duplicate modules and build-metadata-equivalent versions', () => {
    expect(() =>
      parse(
        catalog([
          { id: 'learning', versions: [version('1.0.0')] },
          { id: 'learning', versions: [version('2.0.0')] },
        ]),
      ),
    ).toThrow(/Duplicate official module id/)
    expect(() =>
      parse(
        catalog([
          {
            id: 'learning',
            versions: [version('1.0.0+one'), version('1.0.0+two')],
          },
        ]),
      ),
    ).toThrow(/Duplicate equivalent versions/)
  })

  it('sorts huge SemVer components safely and deterministically', () => {
    const module = moduleWithVersions(
      version('9007199254740993.0.0'),
      version('9007199254740992.999999999999999999999.0'),
      version('2.0.0'),
    )
    expect(module.versions.map(({ version }) => version)).toEqual([
      '9007199254740993.0.0',
      '9007199254740992.999999999999999999999.0',
      '2.0.0',
    ])
  })

  it('enforces raw, string, range, collection, and manifest limits', () => {
    expect(() => parseOfficialModuleCatalog({} as never, OPTIONS)).toThrow(
      /raw UTF-8/,
    )
    expect(() =>
      parse(catalog([]), {
        ...OPTIONS,
        limits: { maxBytes: 10 },
      }),
    ).toThrow(/byte limit/)
    expect(() =>
      parse(
        catalog([
          { id: 'learning', name: 'long', versions: [version('1.0.0')] },
        ]),
        {
          ...OPTIONS,
          limits: { maxStringBytes: 3 },
        },
      ),
    ).toThrow(/string exceeds/)
    expect(() =>
      parse(catalog([{ id: 'learning', versions: [version('1.0.0')] }]), {
        ...OPTIONS,
        limits: {
          maxModules: 1,
          maxVersionsPerModule: 1,
          maxNamespacesPerVersion: 1,
          maxManifestBytes: 100,
        },
      }),
    ).toThrow(/manifest is invalid/)
    expect(() =>
      parse(
        catalog([
          { id: 'learning', versions: [version('1.0.0')] },
          { id: 'search', versions: [version('1.0.0')] },
        ]),
        { ...OPTIONS, limits: { maxModules: 1 } },
      ),
    ).toThrow()
    expect(() =>
      parse(
        catalog([
          {
            id: 'learning',
            versions: [version('1.0.0'), version('2.0.0')],
          },
        ]),
        { ...OPTIONS, limits: { maxVersionsPerModule: 1 } },
      ),
    ).toThrow()
    expect(() =>
      parse(
        catalog([
          {
            id: 'learning',
            versions: [
              version('1.0.0', {
                dataSchemas: {
                  learning: { readMin: 0, readMax: 1, write: 1 },
                  search: { readMin: 0, readMax: 1, write: 1 },
                },
              }),
            ],
          },
        ]),
        { ...OPTIONS, limits: { maxNamespacesPerVersion: 1 } },
      ),
    ).toThrow()
    expect(() =>
      parse(
        catalog([
          {
            id: 'learning',
            versions: [version('1.0.0', { hostApi: '>=1.0.0 || >=2.0.0' })],
          },
        ]),
        {
          ...OPTIONS,
          limits: { maxRangeAlternatives: 1 },
        },
      ),
    ).toThrow()
    expect(() =>
      parse(
        catalog([
          {
            id: 'learning',
            versions: [version('1.0.0', { hostApi: '>=1.0.0 <2.0.0' })],
          },
        ]),
        { ...OPTIONS, limits: { maxComparatorsPerAlternative: 1 } },
      ),
    ).toThrow()
  })

  it('supports one manifest on desktop and mobile', () => {
    const module = moduleWithVersions(
      version('1.0.0', { platforms: ['mobile', 'desktop'] }),
    )
    for (const platform of ['desktop', 'mobile'] as const) {
      expect(
        selectInitialCompatibleVersion(module, {
          hostApi: '1.3.0',
          platform,
          dataSchemas: { learning: 2 },
        })?.version,
      ).toBe('1.0.0')
    }
  })

  it('selects the highest Host API, platform, and schema-compatible initial version', () => {
    const module = moduleWithVersions(
      version('1.0.0'),
      version('2.0.0', { hostApi: '^1.2.0' }),
      version('3.0.0', { platforms: ['mobile'] }),
      version('4.0.0', {
        dataSchemas: {
          learning: { readMin: 3, readMax: 4, write: 4 },
        },
      }),
    )
    expect(
      selectInitialCompatibleVersion(module, {
        hostApi: '1.4.0',
        platform: 'desktop',
        dataSchemas: { learning: 2 },
      })?.version,
    ).toBe('2.0.0')
  })

  it('never lets initial selection replace an active version', () => {
    const module = moduleWithVersions(version('1.0.0'), version('2.0.0'))
    expect(
      selectInitialCompatibleVersion(module, {
        hostApi: '1.3.0',
        platform: 'desktop',
        dataSchemas: { learning: 2 },
        activeVersion: '1.0.0',
      }),
    ).toBeNull()
  })

  it('finds only a compatible version above the active version', () => {
    const module = moduleWithVersions(
      version('1.0.0'),
      version('2.0.0'),
      version('3.0.0', { platforms: ['mobile'] }),
    )
    expect(
      findCompatibleUpdate(module, {
        hostApi: '1.3.0',
        platform: 'desktop',
        dataSchemas: { learning: 2 },
        activeVersion: '1.0.0',
      })?.version,
    ).toBe('2.0.0')
    expect(
      findCompatibleUpdate(module, {
        hostApi: '1.3.0',
        platform: 'desktop',
        dataSchemas: { learning: 2 },
        activeVersion: '2.0.0',
      }),
    ).toBeNull()
  })

  it('requires every current namespace to be readable and never writes below current', () => {
    const module = moduleWithVersions(
      version('1.0.0', {
        dataSchemas: {
          learning: { readMin: 1, readMax: 4, write: 1 },
        },
      }),
    )
    expect(
      selectInitialCompatibleVersion(module, {
        hostApi: '1.3.0',
        platform: 'desktop',
        dataSchemas: { learning: 2 },
      }),
    ).toBeNull()
    expect(
      selectInitialCompatibleVersion(module, {
        hostApi: '1.3.0',
        platform: 'desktop',
        dataSchemas: { learning: 1, orphaned: 1 },
      }),
    ).toBeNull()
  })

  it('allows a new namespace only when the candidate can read schema zero', () => {
    const incompatible = moduleWithVersions(
      version('1.0.0', {
        dataSchemas: {
          learning: { readMin: 1, readMax: 3, write: 3 },
          search: { readMin: 1, readMax: 1, write: 1 },
        },
      }),
    )
    const compatible = moduleWithVersions(
      version('1.0.0', {
        dataSchemas: {
          learning: { readMin: 1, readMax: 3, write: 3 },
          search: { readMin: 0, readMax: 1, write: 1 },
        },
      }),
    )
    const context = {
      hostApi: '1.3.0',
      platform: 'desktop' as const,
      dataSchemas: { learning: 2 },
    }
    expect(selectInitialCompatibleVersion(incompatible, context)).toBeNull()
    expect(selectInitialCompatibleVersion(compatible, context)?.version).toBe(
      '1.0.0',
    )
  })

  it('does not match prereleases from a stable range', () => {
    const stableRange = moduleWithVersions(version('1.3.0-beta.1'))
    const prereleaseRange = moduleWithVersions(
      version('1.3.0-beta.1', { hostApi: '>=1.3.0-beta.1 <2.0.0' }),
    )
    const context = {
      hostApi: '1.3.0-beta.2',
      platform: 'desktop' as const,
      dataSchemas: { learning: 2 },
    }
    expect(selectInitialCompatibleVersion(stableRange, context)).toBeNull()
    expect(
      selectInitialCompatibleVersion(prereleaseRange, context)?.version,
    ).toBe('1.3.0-beta.1')
  })

  it('rejects dangerous namespaces and prototype-shaped catalog fields', () => {
    for (const namespace of ['constructor', 'prototype', '__proto__']) {
      const schemas = JSON.parse(
        `{"${namespace}":{"readMin":0,"readMax":1,"write":1}}`,
      ) as unknown
      expect(() =>
        parse(
          catalog([
            {
              id: 'learning',
              versions: [version('1.0.0', { dataSchemas: schemas })],
            },
          ]),
        ),
      ).toThrow()
    }
  })
})
