import {
  createDevModuleCatalogOverlay,
  createMergedModuleCatalogSource,
} from './devModuleCatalogSource'
import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type { OfficialModuleCatalogV1 } from './officialModuleCatalog'
import { OfficialModuleCatalogSource } from './officialModuleCatalogSource'
import type { ModuleCatalogResolutionSource } from './productionModuleServices'
import type { ModuleCatalogEntry } from './types'

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value))

function fakeSource(
  overrides: Partial<ModuleCatalogResolutionSource> & {
    load: ModuleCatalogResolutionSource['load']
  },
): ModuleCatalogResolutionSource {
  return {
    getResolvedVersion: () => undefined,
    getResolvedArtifactDescriptor: () => undefined,
    ...overrides,
  }
}

const descriptor = (id: string, version: string): ModuleArtifactDescriptor => ({
  id,
  version,
  hostApi: '^1.6.0',
  dataSchemas: {},
  platform: 'desktop',
  manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-${id}-v${version}/module.json`,
  manifest: { byteSize: 10, sha256: 'a'.repeat(64) },
})

// Real published releases use the `<id>/v<version>` tag (percent-encoded),
// which is what makes them eligible for the Cloudflare Pages mirror — unlike
// the `module-<id>-v<version>` preview tag `module:build` bakes into
// modules/bundled.json for local/dev-only builds.
const officialDescriptor = (
  id: string,
  version: string,
): ModuleArtifactDescriptor => ({
  id,
  version,
  hostApi: '^1.6.0',
  dataSchemas: {},
  platform: 'desktop',
  manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${id}%2Fv${version}/module.json`,
  manifest: { byteSize: 10, sha256: 'a'.repeat(64) },
})

describe('createMergedModuleCatalogSource', () => {
  it('prefers the overlay when it resolves a strictly newer version', async () => {
    const primaryEntry: ModuleCatalogEntry = {
      id: 'learning',
      version: '0.1.4',
      name: 'Learning',
    }
    const overlayEntry: ModuleCatalogEntry = {
      id: 'learning',
      version: '0.1.5-dev.0',
      name: 'Learning (local build)',
    }
    const primary = fakeSource({ load: async () => [primaryEntry] })
    const overlay = fakeSource({
      load: async () => [overlayEntry],
      getResolvedVersion: (id) =>
        id === 'learning'
          ? {
              version: '0.1.5-dev.0',
              hostApi: '^1.6.0',
              platforms: ['desktop'],
              dataSchemas: {},
              manifestUrl: overlayEntry.id,
              manifest: { byteSize: 1, sha256: 'a'.repeat(64) },
            }
          : undefined,
      getResolvedArtifactDescriptor: (id, version) =>
        id === 'learning' && version === '0.1.5-dev.0'
          ? descriptor(id, version)
          : undefined,
    })

    const merged = createMergedModuleCatalogSource({ primary, overlay })
    await expect(merged.load()).resolves.toEqual([overlayEntry])
    expect(merged.getResolvedVersion('learning')?.version).toBe('0.1.5-dev.0')
    expect(
      merged.getResolvedArtifactDescriptor(
        'learning',
        '0.1.5-dev.0',
        'desktop',
      ),
    ).toEqual(descriptor('learning', '0.1.5-dev.0'))
  })

  it('keeps the primary when the overlay does not resolve an installable version', async () => {
    const primaryEntry: ModuleCatalogEntry = {
      id: 'learning',
      version: '0.1.4',
      name: 'Learning',
    }
    const overlayEntry: ModuleCatalogEntry = {
      id: 'learning',
      version: '0.1.3-dev.0',
      name: 'Learning (local build)',
      compatibilityIssues: [{ kind: 'host-api' }],
    }
    const primary = fakeSource({
      load: async () => [primaryEntry],
      getResolvedVersion: (id) =>
        id === 'learning'
          ? {
              version: '0.1.4',
              hostApi: '^1.6.0',
              platforms: ['desktop'],
              dataSchemas: {},
              manifestUrl: 'primary',
              manifest: { byteSize: 1, sha256: 'a'.repeat(64) },
            }
          : undefined,
    })
    const overlay = fakeSource({ load: async () => [overlayEntry] })

    const merged = createMergedModuleCatalogSource({ primary, overlay })
    await expect(merged.load()).resolves.toEqual([primaryEntry])
    expect(merged.getResolvedVersion('learning')?.version).toBe('0.1.4')
  })

  it('does not let a lower overlay version outrank a resolved primary candidate', async () => {
    const primaryEntry: ModuleCatalogEntry = {
      id: 'learning',
      version: '0.2.0',
      name: 'Learning',
    }
    const overlayEntry: ModuleCatalogEntry = {
      id: 'learning',
      version: '0.1.5-dev.0',
      name: 'Learning (local build)',
    }
    const primary = fakeSource({
      load: async () => [primaryEntry],
      getResolvedVersion: (id) =>
        id === 'learning'
          ? {
              version: '0.2.0',
              hostApi: '^1.6.0',
              platforms: ['desktop'],
              dataSchemas: {},
              manifestUrl: 'primary',
              manifest: { byteSize: 1, sha256: 'a'.repeat(64) },
            }
          : undefined,
    })
    const overlay = fakeSource({
      load: async () => [overlayEntry],
      getResolvedVersion: (id) =>
        id === 'learning'
          ? {
              version: '0.1.5-dev.0',
              hostApi: '^1.6.0',
              platforms: ['desktop'],
              dataSchemas: {},
              manifestUrl: 'overlay',
              manifest: { byteSize: 1, sha256: 'b'.repeat(64) },
            }
          : undefined,
    })

    const merged = createMergedModuleCatalogSource({ primary, overlay })
    await expect(merged.load()).resolves.toEqual([primaryEntry])
    expect(merged.getResolvedVersion('learning')?.version).toBe('0.2.0')
  })

  it('surfaces an overlay-only module the primary does not know about', async () => {
    const overlayEntry: ModuleCatalogEntry = {
      id: 'unreleased',
      version: '0.1.0-dev.0',
      name: 'Unreleased',
    }
    const primary = fakeSource({ load: async () => [] })
    const overlay = fakeSource({ load: async () => [overlayEntry] })

    const merged = createMergedModuleCatalogSource({ primary, overlay })
    await expect(merged.load()).resolves.toEqual([overlayEntry])
  })
})

class FakeAdapter {
  readonly reads: string[] = []
  readonly files = new Map<string, ArrayBuffer>()

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.reads.push(path)
    const value = this.files.get(path)
    if (!value) throw new Error(`Missing local artifact file: ${path}`)
    return value
  }
}

function officialCatalogWithActiveVersion(
  activeVersion: string,
): OfficialModuleCatalogSource {
  const catalog: OfficialModuleCatalogV1 = {
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
        versions: [
          {
            version: activeVersion,
            hostApi: '^1.6.0',
            platforms: ['desktop', 'mobile'],
            dataSchemas: {},
            manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v${activeVersion}/module.json`,
            manifest: { byteSize: 10, sha256: 'a'.repeat(64) },
          },
        ],
      },
    ],
  }
  return new OfficialModuleCatalogSource({
    client: { load: async () => catalog, loadFresh: async () => catalog },
    locale: 'en',
    getCompatibility: async () => ({
      hostApi: '1.6.0',
      platform: 'desktop' as const,
      activeVersion,
    }),
  })
}

const bundledIndex = {
  schemaVersion: 1,
  modules: [
    {
      id: 'learning',
      version: '0.1.5-dev.0',
      icon: 'graduation-cap',
      localizations: {
        en: { name: 'Learning (local build)', description: 'Local build' },
        zh: { name: '学习（本地构建）', description: '本地构建' },
        it: { name: 'Apprendimento (locale)', description: 'Build locale' },
      },
      hostApi: '^1.6.0',
      dataSchemas: {},
      platforms: ['desktop', 'mobile'],
      manifestUrl:
        'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v0.1.5-dev.0/module.json',
      manifest: { byteSize: 42, sha256: 'b'.repeat(64) },
    },
  ],
}

describe('createDevModuleCatalogOverlay', () => {
  it('surfaces a locally built candidate newer than the active official release, resolved from local bytes only', async () => {
    const adapter = new FakeAdapter()
    const moduleDir = '/plugins/yolo/modules/learning/0.1.5-dev.0'
    adapter.files.set(
      `${moduleDir}/module.json`,
      encode({ id: 'learning', version: '0.1.5-dev.0' }).buffer,
    )
    const fallbackDownload = jest.fn(async () => {
      throw new Error('fallback must not be used for a bundled candidate')
    })

    const overlay = createDevModuleCatalogOverlay({
      readBundledIndexBytes: async () => encode(bundledIndex),
      adapter,
      pluginDir: '/plugins/yolo',
      platform: 'desktop',
      locale: 'en',
      getCompatibility: async () => ({
        hostApi: '1.6.0',
        platform: 'desktop' as const,
        activeVersion: '0.1.4',
      }),
      official: officialCatalogWithActiveVersion('0.1.4'),
      fallbackDownload,
    })

    await expect(overlay.catalogSource.load()).resolves.toEqual([
      expect.objectContaining({ id: 'learning', version: '0.1.5-dev.0' }),
    ])
    const resolvedDescriptor =
      overlay.catalogSource.getResolvedArtifactDescriptor(
        'learning',
        '0.1.5-dev.0',
        'desktop',
      )
    expect(resolvedDescriptor).toMatchObject({
      id: 'learning',
      version: '0.1.5-dev.0',
    })

    const sources = overlay.resolveDownloadSources({
      descriptor: resolvedDescriptor!,
      canonicalUrl: resolvedDescriptor!.manifestUrl,
      path: 'module.json',
    })
    // No Cloudflare Pages mirror for a version never published there.
    expect(sources).toEqual([resolvedDescriptor!.manifestUrl])

    const bytes = await overlay.artifactDownloader({
      kind: 'manifest',
      url: resolvedDescriptor!.manifestUrl,
      byteSize: resolvedDescriptor!.manifest.byteSize,
    })
    expect(new TextDecoder().decode(bytes)).toBe(
      JSON.stringify({ id: 'learning', version: '0.1.5-dev.0' }),
    )
    expect(adapter.reads).toEqual([`${moduleDir}/module.json`])
    expect(fallbackDownload).not.toHaveBeenCalled()
  })

  it('leaves an already-current official module and network downloads untouched', async () => {
    const adapter = new FakeAdapter()
    const fallbackDownload = jest.fn(async () => new Uint8Array([1, 2, 3]))

    const overlay = createDevModuleCatalogOverlay({
      readBundledIndexBytes: async () => encode(bundledIndex),
      adapter,
      pluginDir: '/plugins/yolo',
      platform: 'desktop',
      locale: 'en',
      getCompatibility: async () => ({
        hostApi: '1.6.0',
        platform: 'desktop' as const,
        activeVersion: '0.1.5-dev.0',
      }),
      // Official is already at (or ahead of) the bundled preview version.
      official: officialCatalogWithActiveVersion('0.1.5-dev.0'),
      fallbackDownload,
    })

    await overlay.catalogSource.load()
    expect(overlay.catalogSource.getResolvedVersion('learning')).toBeUndefined()

    const nonBundled = officialDescriptor('other-module', '2.0.0')
    const sources = overlay.resolveDownloadSources({
      descriptor: nonBundled,
      canonicalUrl: nonBundled.manifestUrl,
      path: 'module.json',
    })
    // Real official releases keep going through the Cloudflare Pages mirror.
    expect(sources).toContain(nonBundled.manifestUrl)
    expect(sources.length).toBeGreaterThan(1)

    const bytes = await overlay.artifactDownloader({
      kind: 'manifest',
      url: nonBundled.manifestUrl,
      byteSize: nonBundled.manifest.byteSize,
    })
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(fallbackDownload).toHaveBeenCalledTimes(1)
    expect(adapter.reads).toEqual([])
  })
})
