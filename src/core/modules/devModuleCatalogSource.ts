import { type DataAdapter, normalizePath } from 'obsidian'

import {
  type BundledModuleIndex,
  parseBundledModuleIndex,
} from './bundledModuleRegistry'
import type { ModuleArtifactInstallerOptions } from './moduleArtifactInstaller'
import type { ModuleCatalogLocaleSource } from './moduleCatalogPresentation'
import { compareModuleVersions } from './moduleManager'
import { parseModuleReleaseUrl } from './moduleReleaseUrl'
import type { ModuleArtifactPlatform } from './moduleStore'
import { resolveOfficialModuleArtifactSources } from './officialModuleArtifactSources'
import type { OfficialModuleCatalogV1 } from './officialModuleCatalog'
import {
  OfficialModuleCatalogSource,
  type OfficialModuleCompatibilityProvider,
} from './officialModuleCatalogSource'
import {
  type ModuleCatalogResolutionSource,
  assertCompatibilityPlatform,
} from './productionModuleServices'
import type { ModuleCatalogEntry } from './types'

export type MergedModuleCatalogSourceOptions = Readonly<{
  /** Wins ties and every module the overlay does not resolve a newer candidate for. */
  primary: ModuleCatalogResolutionSource
  /** Wins only for modules where it resolves a strictly newer version than primary. */
  overlay: ModuleCatalogResolutionSource
}>

/**
 * Merges two catalog sources into one, picking per module id whichever side
 * resolves the higher installable version. Ties and modules the overlay does
 * not resolve stay with the primary source.
 */
export function createMergedModuleCatalogSource(
  options: MergedModuleCatalogSourceOptions,
): ModuleCatalogResolutionSource {
  const winners = new Map<string, 'primary' | 'overlay'>()

  const merge = (
    primaryEntries: ReadonlyArray<ModuleCatalogEntry>,
    overlayEntries: ReadonlyArray<ModuleCatalogEntry>,
  ): ReadonlyArray<ModuleCatalogEntry> => {
    const byId = new Map<string, ModuleCatalogEntry>()
    const nextWinners = new Map<string, 'primary' | 'overlay'>()
    for (const entry of primaryEntries) {
      byId.set(entry.id, entry)
      nextWinners.set(entry.id, 'primary')
    }
    for (const entry of overlayEntries) {
      if (!byId.has(entry.id)) {
        byId.set(entry.id, entry)
        nextWinners.set(entry.id, 'overlay')
        continue
      }
      const overlayResolved = options.overlay.getResolvedVersion(entry.id)
      const primaryResolved = options.primary.getResolvedVersion(entry.id)
      if (
        overlayResolved &&
        (!primaryResolved ||
          compareModuleVersions(
            overlayResolved.version,
            primaryResolved.version,
          ) > 0)
      ) {
        byId.set(entry.id, entry)
        nextWinners.set(entry.id, 'overlay')
      }
    }
    winners.clear()
    for (const [id, winner] of nextWinners) winners.set(id, winner)
    return Object.freeze([...byId.values()])
  }

  return Object.freeze({
    async load() {
      const [primaryEntries, overlayEntries] = await Promise.all([
        options.primary.load(),
        options.overlay.load(),
      ])
      return merge(primaryEntries, overlayEntries)
    },
    async loadFresh() {
      const [primaryEntries, overlayEntries] = await Promise.all([
        options.primary.loadFresh
          ? options.primary.loadFresh()
          : options.primary.load(),
        options.overlay.load(),
      ])
      return merge(primaryEntries, overlayEntries)
    },
    getResolvedVersion(moduleId) {
      const winner = winners.get(moduleId)
      return winner === 'overlay'
        ? options.overlay.getResolvedVersion(moduleId)
        : options.primary.getResolvedVersion(moduleId)
    },
    getResolvedArtifactDescriptor(moduleId, expectedVersion, platform) {
      const winner = winners.get(moduleId)
      return winner === 'overlay'
        ? options.overlay.getResolvedArtifactDescriptor(
            moduleId,
            expectedVersion,
            platform,
          )
        : options.primary.getResolvedArtifactDescriptor(
            moduleId,
            expectedVersion,
            platform,
          )
    },
  })
}

export type DevModuleCatalogOverlayOptions = Readonly<{
  readBundledIndexBytes(): Promise<Uint8Array>
  adapter: Pick<DataAdapter, 'readBinary'>
  pluginDir: string
  platform: ModuleArtifactPlatform
  locale: ModuleCatalogLocaleSource
  getCompatibility: OfficialModuleCompatibilityProvider
  /** The unmodified production official catalog source. */
  official: ModuleCatalogResolutionSource
  /** The unmodified production artifact downloader, used for non-bundled candidates. */
  fallbackDownload: ModuleArtifactInstallerOptions['download']
}>

export type DevModuleCatalogOverlay = Readonly<{
  catalogSource: ModuleCatalogResolutionSource
  artifactDownloader: ModuleArtifactInstallerOptions['download']
  resolveDownloadSources: NonNullable<
    ModuleArtifactInstallerOptions['resolveDownloadSources']
  >
}>

/**
 * Development-only local install channel: layers locally built module
 * artifacts (`modules/bundled.json`, produced by `npm run module:build`) on
 * top of the unmodified official catalog and never fetches their bytes over
 * the network. Artifact files for a bundled candidate are read from
 * `${pluginDir}/modules/<id>/<version>/<file>` — the same directory the
 * installer itself writes a downloaded artifact to (and, in the normal `npm
 * run dev` workflow, the same directory `scripts/sync-dev-artifacts.mjs`
 * eagerly copies freshly built module versions into).
 *
 * Relies on first-party module artifacts always being flat (no nested asset
 * paths) — true of every module `scripts/build-first-party-modules.mjs` can
 * currently produce — so a release asset's file name doubles as its
 * installed relative path.
 */
export function createDevModuleCatalogOverlay(
  options: DevModuleCatalogOverlayOptions,
): DevModuleCatalogOverlay {
  let indexPromise: Promise<BundledModuleIndex> | null = null
  let cachedIndex: BundledModuleIndex | null = null
  const loadIndex = (): Promise<BundledModuleIndex> => {
    indexPromise ??= options
      .readBundledIndexBytes()
      .then((bytes) =>
        parseBundledModuleIndex(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        ),
      )
      .then((index) => {
        cachedIndex = index
        return index
      })
    return indexPromise
  }

  const overlaySource = new OfficialModuleCatalogSource({
    client: {
      load: async () => toOfficialCatalog(await loadIndex()),
      loadFresh: async () => toOfficialCatalog(await loadIndex()),
    },
    locale: options.locale,
    getCompatibility: assertCompatibilityPlatform(
      options.getCompatibility,
      options.platform,
    ),
  })

  const catalogSource = createMergedModuleCatalogSource({
    primary: options.official,
    overlay: overlaySource,
  })

  const findBundledDescriptor = (id: string, version: string) =>
    cachedIndex?.modules.find(
      (module) => module.id === id && module.version === version,
    )

  const resolveDownloadSources: DevModuleCatalogOverlay['resolveDownloadSources'] =
    (request) => {
      const bundled = findBundledDescriptor(
        request.descriptor.id,
        request.descriptor.version,
      )
      // Never offer the Cloudflare Pages mirror for a version that was never
      // published there — only the canonical GitHub Release URL is a valid
      // (if locally intercepted) source for a bundled candidate.
      if (bundled) return Object.freeze([request.canonicalUrl])
      return resolveOfficialModuleArtifactSources(request)
    }

  const artifactDownloader: DevModuleCatalogOverlay['artifactDownloader'] =
    async (request) => {
      const parsed = parseModuleReleaseUrl(request.url)
      const bundled = parsed
        ? cachedIndex?.modules.find(
            (module) => `module-${module.id}-v${module.version}` === parsed.tag,
          )
        : undefined
      if (parsed && bundled) {
        const path = normalizePath(
          `${options.pluginDir}/modules/${bundled.id}/${bundled.version}/${parsed.assetName}`,
        )
        return new Uint8Array(await options.adapter.readBinary(path))
      }
      return options.fallbackDownload(request)
    }

  return Object.freeze({
    catalogSource,
    artifactDownloader,
    resolveDownloadSources,
  })
}

function toOfficialCatalog(index: BundledModuleIndex): OfficialModuleCatalogV1 {
  return Object.freeze({
    schemaVersion: 1,
    modules: Object.freeze(
      index.modules.map((module) =>
        Object.freeze({
          id: module.id,
          icon: module.icon,
          localizations: module.localizations,
          versions: Object.freeze([
            Object.freeze({
              version: module.version,
              hostApi: module.hostApi,
              platforms: module.platforms,
              dataSchemas: module.dataSchemas,
              manifestUrl: module.manifestUrl,
              manifest: module.manifest,
            }),
          ]),
        }),
      ),
    ),
  }) as OfficialModuleCatalogV1
}
