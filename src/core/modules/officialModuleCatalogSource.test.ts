import {
  type OfficialModuleCatalogV1,
  parseOfficialModuleCatalog,
} from './officialModuleCatalog'
import {
  OfficialModuleCatalogSource,
  type OfficialModuleCompatibilityProvider,
} from './officialModuleCatalogSource'

const HASH = 'a'.repeat(64)
const REPOSITORIES = [{ owner: 'Lapis0x0', repo: 'obsidian-yolo' }]

type ModuleInput = Readonly<{
  id: string
  icon?: string
  name?: string
  description?: string
  versions: readonly string[]
  platform?: 'desktop' | 'mobile'
  hostApiByVersion?: Readonly<Record<string, string>>
}>

function parsedCatalog(
  modules: readonly ModuleInput[],
): OfficialModuleCatalogV1 {
  return parseOfficialModuleCatalog(
    JSON.stringify({
      schemaVersion: 1,
      modules: modules.map((module) => ({
        id: module.id,
        ...(module.icon ? { icon: module.icon } : {}),
        localizations: {
          en: {
            name: module.name ?? module.id,
            description: module.description ?? `${module.id} description`,
          },
          zh: {
            name: `ZH ${module.name ?? module.id}`,
            description: `ZH ${module.description ?? `${module.id} description`}`,
          },
          it: {
            name: `IT ${module.name ?? module.id}`,
            description: `IT ${module.description ?? `${module.id} description`}`,
          },
        },
        versions: module.versions.map((version) => ({
          version,
          hostApi: module.hostApiByVersion?.[version] ?? '>=1.0.0 <2.0.0',
          platforms: [module.platform ?? 'desktop'],
          dataSchemas: { core: { readMin: 0, readMax: 2, write: 2 } },
          manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/v${version}/${module.id}.json`,
          manifest: { byteSize: 10, sha256: HASH },
        })),
      })),
    }),
    { allowedRepositories: REPOSITORIES },
  )
}

function compatibility(
  activeVersion?: string,
): ReturnType<OfficialModuleCompatibilityProvider> {
  return {
    hostApi: '1.5.0',
    platform: 'desktop',
    ...(activeVersion !== undefined ? { activeVersion } : {}),
  }
}

function source(
  catalog: OfficialModuleCatalogV1,
  getCompatibility: OfficialModuleCompatibilityProvider = () => compatibility(),
) {
  const client = { load: jest.fn(async () => catalog) }
  return {
    client,
    source: new OfficialModuleCatalogSource({
      client,
      getCompatibility,
      locale: 'en',
    }),
  }
}

describe('OfficialModuleCatalogSource', () => {
  it('selects the highest compatible initial version and retains its installer lookup', async () => {
    const catalog = parsedCatalog([
      {
        id: 'learning',
        icon: 'graduation-cap',
        name: 'Learning',
        description: 'Spaced repetition',
        versions: ['1.0.0', '1.2.0', '1.1.0'],
      },
    ])
    const fixture = source(catalog)

    await expect(fixture.source.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '1.2.0',
        icon: 'graduation-cap',
        name: 'Learning',
        description: 'Spaced repetition',
      },
    ])
    expect(fixture.client.load).toHaveBeenCalledTimes(1)
    expect(fixture.source.getResolvedVersion('learning')).toBe(
      catalog.modules[0].versions[0],
    )
    expect(
      fixture.source.getResolvedArtifactDescriptor(
        'learning',
        '1.2.0',
        'desktop',
      ),
    ).toEqual({
      id: 'learning',
      version: '1.2.0',
      hostApi: '>=1.0.0 <2.0.0',
      dataSchemas: { core: { readMin: 0, readMax: 2, write: 2 } },
      platform: 'desktop',
      manifestUrl:
        'https://github.com/Lapis0x0/obsidian-yolo/releases/download/v1.2.0/learning.json',
      manifest: { byteSize: 10, sha256: HASH },
    })
  })

  it('reads the current locale for every load', async () => {
    let locale: 'en' | 'zh' = 'en'
    const client = {
      load: jest.fn(async () =>
        parsedCatalog([
          { id: 'learning', name: 'Learning', versions: ['1.0.0'] },
        ]),
      ),
    }
    const catalogSource = new OfficialModuleCatalogSource({
      client,
      getCompatibility: () => compatibility(),
      locale: () => locale,
    })

    expect((await catalogSource.load())[0]?.name).toBe('Learning')
    locale = 'zh'
    expect((await catalogSource.load())[0]?.name).toBe('ZH Learning')
  })

  it('binds installer lookup to the displayed version and selected platform', async () => {
    const fixture = source(
      parsedCatalog([{ id: 'learning', versions: ['1.0.0'] }]),
    )
    await fixture.source.load()

    expect(() =>
      fixture.source.getResolvedArtifactDescriptor(
        'learning',
        '0.9.0',
        'desktop',
      ),
    ).toThrow('candidate changed')
    expect(() =>
      fixture.source.getResolvedArtifactDescriptor(
        'learning',
        '1.0.0',
        'mobile',
      ),
    ).toThrow('does not support mobile')
    expect(
      fixture.source.getResolvedArtifactDescriptor(
        'missing',
        '1.0.0',
        'desktop',
      ),
    ).toBeUndefined()
  })

  it('selects only a version newer than the active version for updates', async () => {
    const catalog = parsedCatalog([
      { id: 'learning', versions: ['1.0.0', '1.1.0', '2.0.0'] },
    ])
    const fixture = source(catalog, () => compatibility('1.0.0'))

    await expect(fixture.source.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '2.0.0',
        name: 'learning',
        description: 'learning description',
      },
    ])
    expect(fixture.source.getResolvedVersion('learning')?.version).toBe('2.0.0')
  })

  it('projects structured incompatibility issues for unavailable modules', async () => {
    const fixture = source(
      parsedCatalog([
        { id: 'mobile-only', versions: ['1.0.0'], platform: 'mobile' },
      ]),
    )

    await expect(fixture.source.load()).resolves.toEqual([
      {
        id: 'mobile-only',
        version: '',
        name: 'mobile-only',
        description: 'mobile-only description',
        compatibilityIssues: [{ kind: 'platform' }],
      },
    ])
    expect(fixture.source.getResolvedVersion('mobile-only')).toBeUndefined()
  })

  it('keeps active metadata at the unchanged version when no update exists', async () => {
    const fixture = source(
      parsedCatalog([
        {
          id: 'learning',
          name: 'Learning',
          description: 'Official metadata',
          versions: ['1.0.0'],
        },
      ]),
      () => compatibility('1.0.0'),
    )

    await expect(fixture.source.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '1.0.0',
        name: 'Learning',
        description: 'Official metadata',
      },
    ])
    expect(fixture.source.getResolvedVersion('learning')).toBeUndefined()
  })

  it('does not mark a compatible active version incompatible because a newer version is unsupported', async () => {
    const fixture = source(
      parsedCatalog([
        {
          id: 'learning',
          versions: ['1.0.0', '2.0.0'],
          hostApiByVersion: { '2.0.0': '>=2.0.0 <3.0.0' },
        },
      ]),
      () => compatibility('1.0.0'),
    )

    await expect(fixture.source.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '1.0.0',
        name: 'learning',
        description: 'learning description',
      },
    ])
    expect(fixture.source.getResolvedVersion('learning')).toBeUndefined()
  })

  it('projects incompatibility of the active version without borrowing issues from other versions', async () => {
    const fixture = source(
      parsedCatalog([
        {
          id: 'learning',
          versions: ['1.0.0', '2.0.0'],
          hostApiByVersion: {
            '1.0.0': '>=2.0.0 <3.0.0',
            '2.0.0': '>=3.0.0 <4.0.0',
          },
        },
      ]),
      () => compatibility('1.0.0'),
    )

    await expect(fixture.source.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '1.0.0',
        name: 'learning',
        description: 'learning description',
        compatibilityIssues: [{ kind: 'host-api' }],
      },
    ])
  })

  it('fails the full load when a compatibility callback fails', async () => {
    const callback = jest.fn<
      ReturnType<OfficialModuleCompatibilityProvider>,
      Parameters<OfficialModuleCompatibilityProvider>
    >((module) => {
      if (module.id === 'broken') throw new Error('state unavailable')
      return compatibility()
    })
    const fixture = source(
      parsedCatalog([
        { id: 'working', versions: ['1.0.0'] },
        { id: 'broken', versions: ['1.0.0'] },
      ]),
      callback,
    )

    await expect(fixture.source.load()).rejects.toThrow(
      'Could not resolve compatibility for official module "broken": state unavailable',
    )
    expect(fixture.source.getResolvedVersions()).toEqual({})
  })

  it('replaces the resolved snapshot only after an entirely successful load', async () => {
    const catalog = parsedCatalog([
      { id: 'alpha', versions: ['1.0.0'] },
      { id: 'beta', versions: ['1.0.0'] },
    ])
    let fail = false
    const fixture = source(catalog, (module) => {
      if (fail && module.id === 'beta') throw new Error('failed refresh')
      return compatibility()
    })

    await fixture.source.load()
    const prior = fixture.source.getResolvedVersions()
    fail = true
    await expect(fixture.source.load()).rejects.toThrow('failed refresh')

    expect(fixture.source.getResolvedVersions()).toBe(prior)
    expect(Object.keys(prior)).toEqual(['alpha', 'beta'])
  })

  it('loads once concurrently and resolves modules in deterministic id order', async () => {
    const catalog = parsedCatalog([
      { id: 'zeta', versions: ['1.0.0'] },
      { id: 'alpha', versions: ['1.0.0'] },
    ])
    const visited: string[] = []
    const fixture = source(catalog, (module) => {
      visited.push(module.id)
      return compatibility()
    })

    const first = fixture.source.load()
    const second = fixture.source.load()
    expect(second).toBe(first)
    await expect(first).resolves.toEqual([
      {
        id: 'alpha',
        version: '1.0.0',
        name: 'alpha',
        description: 'alpha description',
      },
      {
        id: 'zeta',
        version: '1.0.0',
        name: 'zeta',
        description: 'zeta description',
      },
    ])
    expect(fixture.client.load).toHaveBeenCalledTimes(1)
    expect(visited).toEqual(['alpha', 'zeta'])
  })

  it('inherits duplicate module and version rejection from catalog parsing', () => {
    const validModule = parsedCatalog([{ id: 'same', versions: ['1.0.0'] }])
      .modules[0]
    const duplicateModule = JSON.stringify({
      schemaVersion: 1,
      modules: [validModule, validModule],
    })

    expect(() =>
      parseOfficialModuleCatalog(duplicateModule, {
        allowedRepositories: REPOSITORIES,
      }),
    ).toThrow()

    expect(() =>
      parsedCatalog([{ id: 'same', versions: ['1.0.0', '1.0.0+build'] }]),
    ).toThrow('Duplicate equivalent versions')
  })

  it('rejects malformed active state instead of treating it as uninstalled', async () => {
    const fixture = source(
      parsedCatalog([{ id: 'learning', versions: ['1.0.0'] }]),
      () => compatibility(''),
    )

    await expect(fixture.source.load()).rejects.toThrow(
      'Active module version is required when finding an update',
    )
    expect(fixture.source.getResolvedVersion('learning')).toBeUndefined()
  })

  it('freezes catalog entries, arrays, and resolved-version snapshots', async () => {
    const fixture = source(
      parsedCatalog([{ id: 'learning', versions: ['1.0.0'] }]),
    )
    const entries = await fixture.source.load()
    const resolved = fixture.source.getResolvedVersions()

    expect(Object.isFrozen(entries)).toBe(true)
    expect(Object.isFrozen(entries[0])).toBe(true)
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.learning)).toBe(true)
    expect(() => {
      ;(entries as unknown as { id: string }[]).push({ id: 'unsafe' })
    }).toThrow()
    expect(() => {
      ;(resolved as Record<string, unknown>).unsafe = {}
    }).toThrow()
  })
})
