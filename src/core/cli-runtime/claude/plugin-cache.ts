import {
  App,
  type DataAdapter,
  FileSystemAdapter,
  Platform,
  normalizePath,
} from 'obsidian'

import { getYoloBaseDir } from '../../paths/yoloPaths'
import {
  type LiteSkillPackageSource,
  getLiteSkillPackageSource,
} from '../../skills/liteSkills'
import { validateSkillName } from '../../skills/skillValidation'

import type { ClaudePluginPathInput, ClaudePluginPathProvider } from './types'

const CACHE_RELATIVE_DIR = '.derived/claude-plugins'
const CACHE_ENTRY_MARKER = '.yolo-derived-plugin.json'
const CACHE_ENTRY_VERSION = 1
const HASH_PATTERN = /^[a-f0-9]{64}$/

export type ClaudePluginCacheSettings = {
  yolo?: {
    baseDir?: string
  }
}

type MaterializedResource = {
  path: string
  bytes: ArrayBuffer
}

type ClaudeLocalPluginCacheOptions = {
  app: App
  getSettings: () => ClaudePluginCacheSettings | null | undefined
  getSkillPackageSource?: typeof getLiteSkillPackageSource
}

const encodeUtf8 = (value: string): ArrayBuffer =>
  new TextEncoder().encode(value).buffer

const cloneArrayBuffer = (value: ArrayBuffer): ArrayBuffer =>
  value.slice(0, value.byteLength)

const ensureDirectory = async (
  adapter: DataAdapter,
  directory: string,
): Promise<void> => {
  const normalized = normalizePath(directory)
  if (await adapter.exists(normalized)) {
    const stat = await adapter.stat(normalized)
    if (stat?.type !== 'folder') {
      throw new Error(
        `Claude plugin cache path is not a directory: ${normalized}`,
      )
    }
    return
  }

  const slashIndex = normalized.lastIndexOf('/')
  if (slashIndex > 0) {
    await ensureDirectory(adapter, normalized.slice(0, slashIndex))
  }
  try {
    await adapter.mkdir(normalized)
  } catch (error) {
    if (!(await adapter.exists(normalized))) {
      throw error
    }
  }
}

const ensureParentDirectory = async (
  adapter: DataAdapter,
  path: string,
): Promise<void> => {
  const slashIndex = path.lastIndexOf('/')
  if (slashIndex > 0) {
    await ensureDirectory(adapter, path.slice(0, slashIndex))
  }
}

const removeDirectory = async (
  adapter: DataAdapter,
  directory: string,
): Promise<void> => {
  if (!(await adapter.exists(directory))) return
  const listing = await adapter.list(directory)
  for (const file of listing.files) {
    await adapter.remove(file)
  }
  for (const folder of listing.folders) {
    await removeDirectory(adapter, folder)
  }
  await adapter.rmdir(directory, false)
}

const assertSafeResourcePath = (relativePath: string): string => {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new Error(`Unsafe Claude skill resource path: ${relativePath}`)
  }

  const segments = relativePath.split(/[\\/]/)
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\0'),
    )
  ) {
    throw new Error(`Unsafe Claude skill resource path: ${relativePath}`)
  }

  return segments.join('/')
}

const assertNoPathCollisions = (paths: string[]): void => {
  const normalized = paths.map((path) => path.toLowerCase())
  const unique = new Set(normalized)
  if (unique.size !== normalized.length) {
    throw new Error(`Claude skill resource path collision: ${paths.join(', ')}`)
  }
  for (const path of unique) {
    const segments = path.split('/')
    for (let end = 1; end < segments.length; end += 1) {
      if (!unique.has(segments.slice(0, end).join('/'))) continue
      throw new Error(
        `Claude skill resource path collision: ${paths.join(', ')}`,
      )
    }
  }
}

const hashResources = async (
  resources: MaterializedResource[],
): Promise<string> => {
  // eslint-disable-next-line import/no-nodejs-modules -- called only after desktop filesystem capability validation
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  hash.update(
    JSON.stringify({
      version: CACHE_ENTRY_VERSION,
      resources: resources.map((resource) => ({
        path: resource.path,
        byteLength: resource.bytes.byteLength,
      })),
    }),
  )
  for (const resource of resources) {
    hash.update(new Uint8Array(resource.bytes))
  }
  return hash.digest('hex')
}

const getManifest = (hash: string): string =>
  `${JSON.stringify(
    {
      name: `yolo-enabled-skills-${hash.slice(0, 12)}`,
      version: '1.0.0',
      description: 'Derived YOLO skills enabled for this Assistant.',
    },
    null,
    2,
  )}\n`

const getMarker = (hash: string): string =>
  `${JSON.stringify({ version: CACHE_ENTRY_VERSION, contentHash: hash })}\n`

const isOwnedCacheEntry = async (
  adapter: DataAdapter,
  directory: string,
  expectedHash: string,
): Promise<boolean> => {
  const markerPath = normalizePath(`${directory}/${CACHE_ENTRY_MARKER}`)
  if (!(await adapter.exists(markerPath))) return false
  try {
    const marker = JSON.parse(await adapter.read(markerPath)) as {
      version?: unknown
      contentHash?: unknown
    }
    return (
      marker.version === CACHE_ENTRY_VERSION &&
      marker.contentHash === expectedHash
    )
  } catch {
    return false
  }
}

/**
 * Materializes the Assistant's enabled YOLO skills as one derived local Claude
 * plugin. Source packages remain the single truth; this cache is content
 * addressed and rebuilt whenever their exact bytes change.
 */
export class ClaudeLocalPluginCache {
  private readonly app: App
  private readonly getSettings: ClaudeLocalPluginCacheOptions['getSettings']
  private readonly getSkillPackageSource: typeof getLiteSkillPackageSource
  private readonly protectedHashes = new Map<string, Set<string>>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: ClaudeLocalPluginCacheOptions) {
    this.app = options.app
    this.getSettings = options.getSettings
    this.getSkillPackageSource =
      options.getSkillPackageSource ?? getLiteSkillPackageSource
  }

  readonly resolvePluginPaths: ClaudePluginPathProvider = (input) =>
    this.serialize(() => this.resolvePluginPathsUnlocked(input))

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async resolvePluginPathsUnlocked(
    input: ClaudePluginPathInput,
  ): Promise<string[]> {
    if (!Platform.isDesktop) {
      throw new Error('Claude local plugin cache is only available on desktop')
    }
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error(
        'Claude local plugin cache requires a desktop filesystem vault',
      )
    }

    const enabledNames = [...new Set(input.enabledSkillNames)].sort()
    if (enabledNames.length === 0) return []

    const settings = this.getSettings() ?? undefined
    const sources: LiteSkillPackageSource[] = []
    const missingNames: string[] = []
    for (const name of enabledNames) {
      if (name !== name.trim() || validateSkillName(name).length > 0) {
        throw new Error(`Invalid enabled YOLO skill name: ${name}`)
      }
      const source = await this.getSkillPackageSource({
        app: this.app,
        name,
        settings,
      })
      if (!source) {
        missingNames.push(name)
        continue
      }
      if (source.entry.name !== name) {
        throw new Error(
          `YOLO skill name collision: requested "${name}", resolved "${source.entry.name}"`,
        )
      }
      sources.push(source)
    }
    if (missingNames.length > 0) {
      throw new Error(
        `Enabled YOLO skills are missing: ${missingNames.join(', ')}`,
      )
    }

    const resources: MaterializedResource[] = []
    for (const source of sources) {
      for (const resource of source.resources) {
        const relativePath = assertSafeResourcePath(resource.relativePath)
        const targetPath = `skills/${source.entry.name}/${relativePath}`
        resources.push({
          path: targetPath,
          bytes:
            resource.kind === 'builtin'
              ? encodeUtf8(resource.content)
              : cloneArrayBuffer(await adapter.readBinary(resource.path)),
        })
      }
    }
    resources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    assertNoPathCollisions(resources.map((resource) => resource.path))

    const hash = await hashResources(resources)
    const cacheRoot = normalizePath(
      `${getYoloBaseDir(settings)}/${CACHE_RELATIVE_DIR}`,
    )
    const targetDir = normalizePath(`${cacheRoot}/${hash}`)
    const stagingDir = normalizePath(`${cacheRoot}/.staging-${hash}`)

    // Validate the host root and the derived vault path before the first
    // cache write. A public cache instance must remain safe even when it is
    // used without the higher-level runtime coordinator.
    await this.toAbsolutePath(adapter, cacheRoot)
    await ensureDirectory(adapter, cacheRoot)
    if (await adapter.exists(targetDir)) {
      if (!(await isOwnedCacheEntry(adapter, targetDir, hash))) {
        throw new Error(
          `Claude plugin cache entry is not owned by YOLO: ${targetDir}`,
        )
      }
    } else {
      if (await adapter.exists(stagingDir)) {
        if (!(await isOwnedCacheEntry(adapter, stagingDir, hash))) {
          throw new Error(
            `Claude plugin staging directory is not owned by YOLO: ${stagingDir}`,
          )
        }
        await removeDirectory(adapter, stagingDir)
      }
      await ensureDirectory(adapter, stagingDir)
      try {
        // Establish ownership before any other materialization write so only
        // directories bearing this exact hash may ever be cleaned recursively.
        await adapter.write(
          normalizePath(`${stagingDir}/${CACHE_ENTRY_MARKER}`),
          getMarker(hash),
        )
        for (const resource of resources) {
          const targetPath = normalizePath(`${stagingDir}/${resource.path}`)
          await ensureParentDirectory(adapter, targetPath)
          await adapter.writeBinary(targetPath, resource.bytes)
        }
        const manifestPath = normalizePath(
          `${stagingDir}/.claude-plugin/plugin.json`,
        )
        await ensureParentDirectory(adapter, manifestPath)
        await adapter.write(manifestPath, getManifest(hash))
        await adapter.rename(stagingDir, targetDir)
      } finally {
        if (await isOwnedCacheEntry(adapter, stagingDir, hash)) {
          await removeDirectory(adapter, stagingDir)
        }
      }
    }

    this.protectHash(cacheRoot, hash)
    await this.cleanupOldEntries(adapter, cacheRoot)
    return [await this.toAbsolutePath(adapter, targetDir)]
  }

  private protectHash(cacheRoot: string, hash: string): void {
    const hashes = this.protectedHashes.get(cacheRoot) ?? new Set<string>()
    hashes.add(hash)
    this.protectedHashes.set(cacheRoot, hashes)
  }

  private async cleanupOldEntries(
    adapter: DataAdapter,
    cacheRoot: string,
  ): Promise<void> {
    const protectedHashes = this.protectedHashes.get(cacheRoot) ?? new Set()
    const listing = await adapter.list(cacheRoot)
    for (const folder of listing.folders) {
      const name = folder.slice(folder.lastIndexOf('/') + 1)
      if (name.startsWith('.staging-')) {
        const stagingHash = name.slice('.staging-'.length)
        if (
          HASH_PATTERN.test(stagingHash) &&
          (await isOwnedCacheEntry(adapter, folder, stagingHash))
        ) {
          await removeDirectory(adapter, folder)
        }
        continue
      }
      if (
        !protectedHashes.has(name) &&
        HASH_PATTERN.test(name) &&
        (await isOwnedCacheEntry(adapter, folder, name))
      ) {
        await removeDirectory(adapter, folder)
      }
    }
  }

  private async toAbsolutePath(
    adapter: FileSystemAdapter,
    vaultRelativePath: string,
  ): Promise<string> {
    // eslint-disable-next-line import/no-nodejs-modules -- called only after desktop filesystem capability validation
    const path = await import('node:path')
    const vaultRoot = adapter.getBasePath()
    if (!path.isAbsolute(vaultRoot)) {
      throw new Error('Desktop vault filesystem path must be absolute')
    }
    const absolutePath = path.resolve(vaultRoot, vaultRelativePath)
    const relative = path.relative(vaultRoot, absolutePath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Claude plugin cache escaped the vault filesystem root')
    }
    return absolutePath
  }
}
