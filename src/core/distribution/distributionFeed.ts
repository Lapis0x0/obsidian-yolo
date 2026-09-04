import * as nacl from 'tweetnacl'

import {
  type ModuleCatalogLocalizations,
  parseModuleCatalogLocalizations,
} from '../modules/moduleCatalogPresentation'
import { parseModuleReleaseUrl } from '../modules/moduleReleaseUrl'
import {
  OfficialModuleCatalogV1,
  OfficialModuleDataSchema,
  OfficialModulePlatform,
  isModuleHostApiRange,
} from '../modules/officialModuleCatalog'

export const DISTRIBUTION_FEED_KEY_ID = 'yolo-distribution-2026-01'
export const DISTRIBUTION_FEED_PUBLIC_KEY_BASE64 =
  'OlJZ3QTj9VGJkiblO6PEDorsvjR12cUH7br7AU0B3Gk='
export const DISTRIBUTION_FEED_MAX_BYTES = 1_000_000
const SHA256 = /^[a-f0-9]{64}$/
const CORE_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2,3}$/
const MODULE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SCHEMA_NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const DANGEROUS_NAMESPACES = new Set(['__proto__', 'prototype', 'constructor'])

export type DistributionReleaseNotes = Readonly<{ en: string; zh: string }>

export type DistributionAsset = Readonly<{
  name: string
  mirrorPath: string
  canonicalUrl: string
  byteSize: number
  sha256: string
}>

export type DistributionReleaseNoteAsset = Readonly<{
  name: 'release-note.md'
  canonicalUrl: string
  byteSize: number
  sha256: string
}>

export type DistributionCore = Readonly<{
  version: string
  minAppVersion: string
  releaseUrl: string
  releaseNotes: DistributionReleaseNotes
  assets: Readonly<{
    mainJs: DistributionAsset
    manifestJson: DistributionAsset
    stylesCss: DistributionAsset
  }>
}>

export type DistributionModule = Readonly<{
  id: string
  icon: string
  localizations: ModuleCatalogLocalizations
  version: string
  hostApi: string
  platforms: readonly OfficialModulePlatform[]
  dataSchemas: Readonly<Record<string, OfficialModuleDataSchema>>
  releaseUrl: string
  releaseNotes: DistributionReleaseNotes
  releaseNote: DistributionReleaseNoteAsset
  manifest: DistributionAsset
}>

export type DistributionFeedV1 = Readonly<{
  schemaVersion: 1
  revision: number
  keyId: string
  core: DistributionCore
  modules: readonly DistributionModule[]
}>

export function verifyAndParseDistributionFeed(
  rawFeed: string | Uint8Array,
  signatureBase64: string,
  options: Readonly<{ publicKeyBase64?: string }> = {},
): DistributionFeedV1 {
  const bytes = decodeFeedBytes(rawFeed)
  const signature = decodeBase64(signatureBase64, nacl.sign.signatureLength)
  const publicKey = decodeBase64(
    options.publicKeyBase64 ?? DISTRIBUTION_FEED_PUBLIC_KEY_BASE64,
    nacl.sign.publicKeyLength,
  )
  if (!nacl.sign.detached.verify(bytes, signature, publicKey)) {
    throw new Error('Distribution Feed signature is invalid')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    )
  } catch {
    throw new Error('Distribution Feed is not valid UTF-8 JSON')
  }
  return parseFeed(decoded)
}

/**
 * Reshapes the verified Feed into the catalog shape the module manager reads.
 *
 * There is no second parse here: the Feed is signature-verified and `parseFeed`
 * already enforces every invariant the resolver depends on. Re-serializing this
 * object only to run it back through an adversarial-input parser validated
 * nothing the publisher's key had not already vouched for.
 */
export function projectDistributionFeedCatalog(
  feed: DistributionFeedV1,
): OfficialModuleCatalogV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    modules: Object.freeze(
      feed.modules.map((module) =>
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
              manifestUrl: module.manifest.canonicalUrl,
              manifest: Object.freeze({
                byteSize: module.manifest.byteSize,
                sha256: module.manifest.sha256,
              }),
              releaseNotes: Object.freeze({
                url: module.releaseNote.canonicalUrl,
                byteSize: module.releaseNote.byteSize,
                sha256: module.releaseNote.sha256,
              }),
            }),
          ]),
        }),
      ),
    ),
  })
}

function parseFeed(value: unknown): DistributionFeedV1 {
  const feed = record(value, 'Distribution Feed')
  requireKeys(feed, ['schemaVersion', 'revision', 'keyId', 'core', 'modules'])
  if (
    feed.schemaVersion !== 1 ||
    !Number.isSafeInteger(feed.revision) ||
    (feed.revision as number) <= 0 ||
    feed.keyId !== DISTRIBUTION_FEED_KEY_ID ||
    !Array.isArray(feed.modules)
  ) {
    throw new Error('Distribution Feed header is invalid')
  }
  const modules = feed.modules.map(parseModule)
  const ids = new Set(modules.map((module) => module.id))
  if (ids.size !== modules.length || modules.length > 100) {
    throw new Error('Distribution Feed modules are invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: feed.revision as number,
    keyId: feed.keyId,
    core: parseCore(feed.core),
    modules: Object.freeze(modules),
  })
}

function parseCore(value: unknown): DistributionCore {
  const core = record(value, 'Core distribution')
  requireKeys(core, [
    'version',
    'minAppVersion',
    'releaseUrl',
    'releaseNotes',
    'assets',
  ])
  if (
    typeof core.version !== 'string' ||
    !CORE_VERSION.test(core.version) ||
    typeof core.minAppVersion !== 'string' ||
    !core.minAppVersion ||
    !isReleasePage(core.releaseUrl, core.version)
  ) {
    throw new Error('Core distribution is invalid')
  }
  const assets = record(core.assets, 'Core assets')
  requireKeys(assets, ['mainJs', 'manifestJson', 'stylesCss'])
  return Object.freeze({
    version: core.version,
    minAppVersion: core.minAppVersion,
    releaseUrl: core.releaseUrl,
    releaseNotes: parseNotes(core.releaseNotes),
    assets: Object.freeze({
      mainJs: parseAsset(
        assets.mainJs,
        `core/${core.version}/main.js`,
        core.version,
      ),
      manifestJson: parseAsset(
        assets.manifestJson,
        `core/${core.version}/manifest.json`,
        core.version,
      ),
      stylesCss: parseAsset(
        assets.stylesCss,
        `core/${core.version}/styles.css`,
        core.version,
      ),
    }),
  })
}

function parseModule(value: unknown): DistributionModule {
  const module = record(value, 'Module distribution')
  requireKeys(module, [
    'id',
    'icon',
    'localizations',
    'version',
    'hostApi',
    'platforms',
    'dataSchemas',
    'releaseUrl',
    'releaseNotes',
    'releaseNote',
    'manifest',
  ])
  if (
    typeof module.id !== 'string' ||
    !MODULE_ID.test(module.id) ||
    typeof module.icon !== 'string' ||
    !module.icon ||
    typeof module.version !== 'string' ||
    !MODULE_VERSION.test(module.version) ||
    !isModuleHostApiRange(module.hostApi) ||
    !Array.isArray(module.platforms) ||
    module.platforms.length === 0 ||
    module.platforms.some(
      (platform) => platform !== 'desktop' && platform !== 'mobile',
    ) ||
    new Set(module.platforms).size !== module.platforms.length ||
    !isReleasePage(module.releaseUrl, `${module.id}/v${module.version}`)
  ) {
    throw new Error('Module distribution is invalid')
  }
  const localizations = parseModuleCatalogLocalizations(
    module.localizations,
    'Module localizations',
  )
  const schemas = record(module.dataSchemas, 'Module data schemas')
  const parsedSchemas = Object.create(null) as Record<
    string,
    OfficialModuleDataSchema
  >
  for (const [namespace, schemaValue] of Object.entries(schemas)) {
    if (
      !SCHEMA_NAMESPACE.test(namespace) ||
      DANGEROUS_NAMESPACES.has(namespace)
    ) {
      throw new Error('Module data schema namespace is invalid')
    }
    const schema = record(schemaValue, 'Module data schema')
    requireKeys(schema, ['readMin', 'readMax', 'write'])
    if (
      !isSchemaVersion(schema.readMin) ||
      !isSchemaVersion(schema.readMax) ||
      !isSchemaVersion(schema.write) ||
      schema.readMin > schema.readMax ||
      schema.write < schema.readMin ||
      schema.write > schema.readMax
    ) {
      throw new Error('Module data schema is invalid')
    }
    parsedSchemas[namespace] = Object.freeze({
      readMin: schema.readMin,
      readMax: schema.readMax,
      write: schema.write,
    })
  }
  if (Object.keys(parsedSchemas).length === 0) {
    throw new Error('Module data schemas are empty')
  }
  return Object.freeze({
    id: module.id,
    icon: module.icon,
    localizations,
    version: module.version,
    hostApi: module.hostApi,
    platforms: Object.freeze(
      [...module.platforms].sort(),
    ) as readonly OfficialModulePlatform[],
    dataSchemas: Object.freeze(parsedSchemas),
    releaseUrl: module.releaseUrl,
    releaseNotes: parseNotes(module.releaseNotes),
    releaseNote: parseReleaseNoteAsset(
      module.releaseNote,
      `${module.id}/v${module.version}`,
    ),
    manifest: parseAsset(
      module.manifest,
      `modules/${module.id}/${module.version}/module.json`,
      `${module.id}/v${module.version}`,
    ),
  })
}

function parseAsset(
  value: unknown,
  expectedMirrorPath: string,
  expectedTag: string,
): DistributionAsset {
  const asset = record(value, 'Distribution asset')
  requireKeys(asset, [
    'name',
    'mirrorPath',
    'canonicalUrl',
    'byteSize',
    'sha256',
  ])
  if (
    typeof asset.name !== 'string' ||
    !asset.name ||
    asset.mirrorPath !== expectedMirrorPath ||
    !isCanonicalReleaseDownload(asset.canonicalUrl, asset.name, expectedTag) ||
    !Number.isSafeInteger(asset.byteSize) ||
    (asset.byteSize as number) <= 0 ||
    typeof asset.sha256 !== 'string' ||
    !SHA256.test(asset.sha256)
  ) {
    throw new Error('Distribution asset is invalid')
  }
  return Object.freeze({
    name: asset.name,
    mirrorPath: asset.mirrorPath,
    canonicalUrl: asset.canonicalUrl,
    byteSize: asset.byteSize as number,
    sha256: asset.sha256,
  })
}

function parseReleaseNoteAsset(
  value: unknown,
  expectedTag: string,
): DistributionReleaseNoteAsset {
  const asset = record(value, 'Release note asset')
  requireKeys(asset, ['name', 'canonicalUrl', 'byteSize', 'sha256'])
  if (
    asset.name !== 'release-note.md' ||
    !isCanonicalReleaseDownload(asset.canonicalUrl, asset.name, expectedTag) ||
    !Number.isSafeInteger(asset.byteSize) ||
    (asset.byteSize as number) <= 0 ||
    (asset.byteSize as number) > 64 * 1024 ||
    typeof asset.sha256 !== 'string' ||
    !SHA256.test(asset.sha256)
  ) {
    throw new Error('Release note asset is invalid')
  }
  return Object.freeze({
    name: 'release-note.md',
    canonicalUrl: asset.canonicalUrl,
    byteSize: asset.byteSize as number,
    sha256: asset.sha256,
  })
}

function parseNotes(value: unknown): DistributionReleaseNotes {
  const notes = record(value, 'Distribution release notes')
  requireKeys(notes, ['en', 'zh'])
  if (
    typeof notes.en !== 'string' ||
    !notes.en ||
    typeof notes.zh !== 'string' ||
    !notes.zh ||
    new TextEncoder().encode(notes.en).byteLength > 64 * 1024 ||
    new TextEncoder().encode(notes.zh).byteLength > 64 * 1024
  ) {
    throw new Error('Distribution release notes are invalid')
  }
  return Object.freeze({ en: notes.en, zh: notes.zh })
}

function decodeFeedBytes(raw: string | Uint8Array): Uint8Array {
  const bytes =
    typeof raw === 'string' ? new TextEncoder().encode(raw) : raw.slice()
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > DISTRIBUTION_FEED_MAX_BYTES
  ) {
    throw new Error('Distribution Feed exceeds the byte limit')
  }
  return bytes
}

function decodeBase64(value: string, expectedLength: number): Uint8Array {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())
  ) {
    throw new Error('Distribution signature encoding is invalid')
  }
  const binary = globalThis.atob(value.trim())
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (bytes.byteLength !== expectedLength) {
    throw new Error('Distribution signature length is invalid')
  }
  return bytes
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Requires every declared field and ignores any other.
 *
 * The Feed is Ed25519-signed by the release pipeline, so an unknown field can
 * only be one this publisher added. Rejecting it would mean every already
 * shipped client stops parsing the Feed the moment a newer field appears —
 * update checks would return null with no online path back, since the client
 * that must be replaced is the one refusing the Feed that describes its
 * replacement. Forward compatibility therefore has to be the default, and a
 * change that older clients must *not* apply gets a new `schemaVersion`.
 */
function requireKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  const missing = keys.find(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  )
  if (missing !== undefined) {
    throw new Error(`Distribution object is missing field "${missing}"`)
  }
}

function isSchemaVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isReleasePage(value: unknown, tag: string): value is string {
  return (
    value === `https://github.com/Lapis0x0/obsidian-yolo/releases/tag/${tag}` ||
    value ===
      `https://github.com/Lapis0x0/obsidian-yolo/releases/tag/${encodeURIComponent(tag)}`
  )
}

function isCanonicalReleaseDownload(
  value: unknown,
  name: unknown,
  tag: string,
): value is string {
  if (typeof name !== 'string') return false
  const release = parseModuleReleaseUrl(value)
  return Boolean(
    release &&
      release.repositoryKey === 'lapis0x0/obsidian-yolo' &&
      release.tag === tag &&
      release.assetName === name,
  )
}
