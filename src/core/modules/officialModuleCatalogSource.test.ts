import type { OfficialModuleCatalogV1 } from './officialModuleCatalog'
import { OfficialModuleCatalogSource } from './officialModuleCatalogSource'

const version = (
  value: string,
  hostApi = '^1.4.0',
  platforms: readonly ('desktop' | 'mobile')[] = ['desktop', 'mobile'],
) => ({
  version: value,
  hostApi,
  platforms,
  dataSchemas: { settings: { readMin: 0, readMax: 1, write: 1 } },
  manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv${value}/module.json`,
  manifest: { byteSize: 10, sha256: 'a'.repeat(64) },
})

const catalog = (
  versions: ReturnType<typeof version>[],
): OfficialModuleCatalogV1 =>
  ({
    schemaVersion: 1,
    modules: [
      {
        id: 'learning',
        icon: 'graduation-cap',
        localizations: {
          en: { name: 'Learning', description: 'Spaced repetition' },
          zh: { name: '学习', description: '间隔重复' },
          it: { name: 'Apprendimento', description: 'Ripetizione' },
        },
        versions,
      },
    ],
  }) as OfficialModuleCatalogV1

function source(
  initial: OfficialModuleCatalogV1,
  activeVersion?: string,
  fresh = initial,
) {
  const client = {
    load: jest.fn(async () => initial),
    loadFresh: jest.fn(async () => fresh),
  }
  return {
    client,
    source: new OfficialModuleCatalogSource({
      client,
      locale: 'en',
      getCompatibility: async () => ({
        hostApi: '1.4.0',
        platform: 'desktop' as const,
        ...(activeVersion !== undefined ? { activeVersion } : {}),
      }),
    }),
  }
}

describe('OfficialModuleCatalogSource latest-only policy', () => {
  it('offers the latest compatible module and retains its descriptor', async () => {
    const fixture = source(catalog([version('1.2.0')]))
    await expect(fixture.source.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '1.2.0',
        icon: 'graduation-cap',
        name: 'Learning',
        description: 'Spaced repetition',
      },
    ])
    expect(
      fixture.source.getResolvedArtifactDescriptor(
        'learning',
        '1.2.0',
        'desktop',
      )?.version,
    ).toBe('1.2.0')
  })

  it('offers latest when it is newer than an active installation', async () => {
    const fixture = source(catalog([version('1.2.0')]), '1.1.0')
    await expect(fixture.source.load()).resolves.toMatchObject([
      { id: 'learning', version: '1.2.0' },
    ])
  })

  it('does not backtrack to an older compatible version', async () => {
    const fixture = source(
      catalog([version('2.0.0', '^2.0.0'), version('1.2.0')]),
    )
    await expect(fixture.source.load()).resolves.toMatchObject([
      {
        id: 'learning',
        version: '',
        compatibilityIssues: [{ kind: 'host-api' }],
      },
    ])
    expect(fixture.source.getResolvedVersion('learning')).toBeUndefined()
  })

  it('replaces the snapshot only after a fresh Feed succeeds', async () => {
    const fixture = source(
      catalog([version('1.1.0')]),
      undefined,
      catalog([version('1.2.0')]),
    )
    expect((await fixture.source.load())[0]?.version).toBe('1.1.0')
    expect((await fixture.source.loadFresh())[0]?.version).toBe('1.2.0')
    expect((await fixture.source.load())[0]?.version).toBe('1.2.0')
  })

  it('does not expose an install candidate when latest is platform-incompatible', async () => {
    const fixture = source(catalog([version('1.2.0', '^1.4.0', ['mobile'])]))
    await expect(fixture.source.load()).resolves.toMatchObject([
      { version: '', compatibilityIssues: [{ kind: 'platform' }] },
    ])
  })
})
