import { type DataAdapter, type ListedFiles, normalizePath } from 'obsidian'

import { parseModuleReleaseUrl } from './moduleReleaseUrl'

export type ModuleStoreOptions = {
  adapter: DataAdapter
  manifest: Readonly<{ id: string; dir?: string }>
  configDir: string
}

export class ModuleArtifactMissingError extends Error {
  constructor(readonly path: string) {
    super(`Module artifact is missing: ${path}`)
    this.name = 'ModuleArtifactMissingError'
  }
}

export type ModuleArtifactManifest = Readonly<{
  schemaVersion: 1
  id: string
  version: string
  hostApi: string
  dataSchemas: ModuleArtifactDataSchemas
  variants: readonly ModuleArtifactVariant[]
}>

export type ModuleArtifactPlatform = 'desktop' | 'mobile'

export type ModuleArtifactDataSchema = Readonly<{
  readMin: number
  readMax: number
  write: number
}>

export type ModuleArtifactDataSchemas = Readonly<
  Record<string, ModuleArtifactDataSchema>
>

export type ModuleArtifactVariant = Readonly<{
  platform: ModuleArtifactPlatform
  entry: string
  files: readonly ModuleArtifactFile[]
}>

export type ModuleArtifactFile = Readonly<{
  role: 'entry' | 'style' | 'worker' | 'wasm' | 'model' | 'data'
  name: string
  path: string
  byteSize: number
  sha256: string
  url: string
  storage: 'module' | 'device'
}>

export const MAX_MODULE_ARTIFACT_FILE_BYTES = 64 * 1024 * 1024
export const MAX_MODULE_ARTIFACT_TOTAL_BYTES = 128 * 1024 * 1024
export const MAX_MODULE_MANIFEST_BYTES = 1024 * 1024
const MAX_MODULE_VERSION_TREE_ENTRIES = 256
const MAX_MODULE_VERSION_TREE_DEPTH = 16
const MAX_MODULE_ARTIFACT_FILES = 64
const MAX_MODULE_SCHEMA_NAMESPACES = 32
const MAX_SEMVER_RANGE_LENGTH = 512
const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SCHEMA_NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const DANGEROUS_NAMESPACES = new Set(['__proto__', 'prototype', 'constructor'])
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parseModuleArtifactManifest(
  value: unknown,
): ModuleArtifactManifest {
  const manifest = asPlainObject(value, 'Module artifact manifest')
  assertExactKeys(
    manifest,
    ['schemaVersion', 'id', 'version', 'hostApi', 'dataSchemas', 'variants'],
    'Module artifact manifest',
  )
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.id !== 'string' ||
    typeof manifest.version !== 'string' ||
    !isModuleHostApiRange(manifest.hostApi) ||
    !Array.isArray(manifest.variants) ||
    manifest.variants.length === 0 ||
    manifest.variants.length > 2
  ) {
    throw new Error('Module artifact manifest is invalid')
  }
  assertModuleId(manifest.id, 'Module id')
  assertModulePathSegment(manifest.version, 'Module version')
  if (!SEMVER.test(manifest.version)) {
    throw new Error('Module version must be semantic')
  }
  const dataSchemas = parseModuleArtifactDataSchemas(manifest.dataSchemas)
  const platforms = new Set<ModuleArtifactPlatform>()
  const variants = manifest.variants.map((value, index) => {
    const variant = asPlainObject(value, `Module artifact variant ${index}`)
    assertExactKeys(
      variant,
      ['platform', 'entry', 'files'],
      `Module artifact variant ${index}`,
    )
    if (
      (variant.platform !== 'desktop' && variant.platform !== 'mobile') ||
      typeof variant.entry !== 'string' ||
      !Array.isArray(variant.files) ||
      variant.files.length === 0 ||
      variant.files.length > MAX_MODULE_ARTIFACT_FILES
    ) {
      throw new Error(`Module artifact variant ${index} is invalid`)
    }
    if (platforms.has(variant.platform)) {
      throw new Error(`Duplicate module platform variant "${variant.platform}"`)
    }
    platforms.add(variant.platform)
    assertCanonicalManifestPath(variant.entry)
    const entry = normalizeModuleArtifactFilePath(variant.entry)
    const files = parseVariantFiles(variant.files)
    const entryFiles = files.filter((file) => file.role === 'entry')
    if (entryFiles.length !== 1) {
      throw new Error('Module artifact variant must declare one entry file')
    }
    if (entryFiles[0].path !== entry) {
      throw new Error(
        'Module artifact entry does not match its file declaration',
      )
    }
    return Object.freeze({
      platform: variant.platform,
      entry,
      files,
    })
  })
  return Object.freeze({
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.version,
    hostApi: manifest.hostApi,
    dataSchemas,
    variants: Object.freeze(variants),
  })
}

export function selectModuleManifestVariant(
  manifest: ModuleArtifactManifest,
  platform: ModuleArtifactPlatform,
): ModuleArtifactVariant {
  if (platform !== 'desktop' && platform !== 'mobile') {
    throw new Error('Module artifact platform is invalid')
  }
  const variant = manifest.variants.find(
    (candidate) => candidate.platform === platform,
  )
  if (!variant) {
    throw new Error(
      `Module "${manifest.id}" has no artifact variant for ${platform}`,
    )
  }
  return variant
}

export function collectModuleManifestFiles(
  manifest: ModuleArtifactManifest,
): readonly ModuleArtifactFile[] {
  const filesByPath = new Map<string, ModuleArtifactFile>()
  const directoryPaths = new Set<string>()
  let totalByteSize = 0
  for (const variant of manifest.variants) {
    for (const file of variant.files) {
      if (file.storage === 'device') {
        throw new Error(
          `Device-stored module artifact "${file.path}" is unsupported`,
        )
      }
      const key = canonicalArtifactPath(file.path)
      const existing = filesByPath.get(key)
      if (existing) {
        if (!sameArtifactFile(existing, file)) {
          throw new Error(
            `Conflicting module artifact file path "${file.path}" across platform variants`,
          )
        }
        continue
      }
      filesByPath.set(key, file)
      totalByteSize += file.byteSize
      if (totalByteSize > MAX_MODULE_ARTIFACT_TOTAL_BYTES) {
        throw new Error('Module artifact files exceed the total size limit')
      }
      const parts = key.split('/')
      for (let index = 1; index < parts.length; index += 1) {
        directoryPaths.add(parts.slice(0, index).join('/'))
      }
      if (
        filesByPath.size + directoryPaths.size + 1 + manifest.variants.length >
        MAX_MODULE_VERSION_TREE_ENTRIES
      ) {
        throw new Error('Module artifact file tree exceeds the entry limit')
      }
    }
  }
  for (const path of filesByPath.keys()) {
    if (directoryPaths.has(path)) {
      throw new Error(`Module artifact file path "${path}" aliases a directory`)
    }
  }
  return Object.freeze([...filesByPath.values()])
}

function sameArtifactFile(
  left: ModuleArtifactFile,
  right: ModuleArtifactFile,
): boolean {
  return (
    left.role === right.role &&
    left.name === right.name &&
    left.path === right.path &&
    left.byteSize === right.byteSize &&
    left.sha256 === right.sha256 &&
    left.url === right.url &&
    left.storage === right.storage
  )
}

function parseVariantFiles(
  values: readonly unknown[],
): readonly ModuleArtifactFile[] {
  const paths = new Set<string>()
  const names = new Set<string>()
  const directoryPaths = new Set<string>()
  let totalByteSize = 0
  const files = values.map((value, index) => {
    const file = asPlainObject(value, `Module artifact file ${index}`)
    assertExactKeys(
      file,
      ['role', 'name', 'path', 'byteSize', 'sha256', 'url', 'storage'],
      `Module artifact file ${index}`,
    )
    if (
      (file.role !== 'entry' &&
        file.role !== 'style' &&
        file.role !== 'worker' &&
        file.role !== 'wasm' &&
        file.role !== 'model' &&
        file.role !== 'data') ||
      typeof file.name !== 'string' ||
      typeof file.path !== 'string' ||
      !Number.isSafeInteger(file.byteSize) ||
      (file.byteSize as number) < 0 ||
      (file.byteSize as number) > MAX_MODULE_ARTIFACT_FILE_BYTES ||
      typeof file.sha256 !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(file.sha256) ||
      typeof file.url !== 'string' ||
      (file.storage !== 'module' && file.storage !== 'device')
    ) {
      throw new Error('Module artifact file is invalid')
    }
    assertModulePathSegment(file.name, 'Module artifact file name')
    const releaseUrl = parseModuleReleaseUrl(file.url)
    if (!releaseUrl || releaseUrl.assetName !== file.name) {
      throw new Error('Module artifact file URL is invalid')
    }
    assertCanonicalManifestPath(file.path)
    const path = normalizeModuleArtifactFilePath(file.path)
    const canonicalPath = canonicalArtifactPath(path)
    const canonicalName = canonicalArtifactPath(file.name)
    if (canonicalPath === 'module.json') {
      throw new Error(`Module artifact file path "${path}" is reserved`)
    }
    if (paths.has(canonicalPath)) {
      throw new Error(`Duplicate module file path "${path}"`)
    }
    paths.add(canonicalPath)
    if (names.has(canonicalName)) {
      throw new Error(`Duplicate module file name "${file.name}"`)
    }
    names.add(canonicalName)
    const parts = canonicalPath.split('/')
    if (parts.length - 1 > MAX_MODULE_VERSION_TREE_DEPTH) {
      throw new Error('Module artifact file path exceeds the depth limit')
    }
    for (let index = 1; index < parts.length; index += 1) {
      directoryPaths.add(parts.slice(0, index).join('/'))
    }
    if (
      paths.size + directoryPaths.size + 2 >
      MAX_MODULE_VERSION_TREE_ENTRIES
    ) {
      throw new Error('Module artifact file tree exceeds the entry limit')
    }
    totalByteSize += file.byteSize as number
    if (totalByteSize > MAX_MODULE_ARTIFACT_TOTAL_BYTES) {
      throw new Error('Module artifact files exceed the total size limit')
    }
    return Object.freeze({
      role: file.role,
      name: file.name,
      path,
      byteSize: file.byteSize as number,
      sha256: file.sha256.toLowerCase(),
      url: file.url,
      storage: file.storage,
    })
  })
  for (const filePath of paths) {
    if (directoryPaths.has(filePath)) {
      throw new Error(
        `Module artifact file path "${filePath}" aliases a directory`,
      )
    }
  }
  return Object.freeze(files)
}

export function moduleArtifactReleaseParent(url: string): string | null {
  return parseModuleReleaseUrl(url)?.releaseParent ?? null
}

function parseModuleArtifactDataSchemas(
  value: unknown,
): ModuleArtifactDataSchemas {
  const schemas = asPlainObject(value, 'Module artifact dataSchemas')
  const entries = Object.entries(schemas)
  if (entries.length > MAX_MODULE_SCHEMA_NAMESPACES) {
    throw new Error('Module artifact dataSchemas is invalid')
  }
  const parsed = Object.create(null) as Record<string, ModuleArtifactDataSchema>
  for (const [namespace, value] of entries) {
    if (
      !SCHEMA_NAMESPACE.test(namespace) ||
      DANGEROUS_NAMESPACES.has(namespace)
    ) {
      throw new Error(`Module artifact data schema "${namespace}" is invalid`)
    }
    const schema = asPlainObject(
      value,
      `Module artifact data schema "${namespace}"`,
    )
    assertExactKeys(
      schema,
      ['readMin', 'readMax', 'write'],
      `Module artifact data schema "${namespace}"`,
    )
    if (
      !isSchemaVersion(schema.readMin) ||
      !isSchemaVersion(schema.readMax) ||
      !isSchemaVersion(schema.write) ||
      schema.readMin > schema.readMax ||
      schema.write < schema.readMin ||
      schema.write > schema.readMax
    ) {
      throw new Error(`Module artifact data schema "${namespace}" is invalid`)
    }
    parsed[namespace] = Object.freeze({
      readMin: schema.readMin,
      readMax: schema.readMax,
      write: schema.write,
    })
  }
  return Object.freeze(parsed)
}

function normalizePortablePath(path: string): string {
  return normalizePath(path.replace(/\\/g, '/'))
}

function asPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new Error(`${label} must contain only own data fields`)
    }
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value)
  const unknown = keys.find((key) => !allowed.includes(key))
  const missing = allowed.find((key) => !keys.includes(key))
  if (unknown) throw new Error(`${label} has unknown field "${unknown}"`)
  if (missing) throw new Error(`${label} is missing field "${missing}"`)
}

function canonicalArtifactPath(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function assertCanonicalManifestPath(value: string): void {
  if (value.includes('\\') || value.normalize('NFKC') !== value) {
    throw new Error('Module artifact file path must be canonical')
  }
}

function isSchemaVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function isModuleHostApiRange(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_SEMVER_RANGE_LENGTH ||
    value.trim() !== value
  ) {
    return false
  }
  const alternatives = value.split('||')
  if (alternatives.length > 8) return false
  return alternatives.every((alternative) => {
    const text = alternative.trim()
    if (!text) return false
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text)
    if (hyphen) return SEMVER.test(hyphen[1]) && SEMVER.test(hyphen[2])
    const tokens = text.split(/\s+/)
    return (
      tokens.length <= 16 &&
      tokens.every((token) => {
        if (token === '*' || /^[xX]$/.test(token)) return true
        const shorthand = /^[~^](.+)$/.exec(token)
        if (shorthand) return SEMVER.test(shorthand[1])
        if (
          /^(0|[1-9]\d*)\.(?:[xX*]|0|[1-9]\d*)(?:\.(?:[xX*]|0|[1-9]\d*))?$/.test(
            token,
          ) &&
          (/[xX*]/.test(token) || token.split('.').length === 2)
        ) {
          return true
        }
        const comparator = /^(?:<=|>=|<|>|=)?(.+)$/.exec(token)
        return Boolean(comparator && SEMVER.test(comparator[1]))
      })
    )
  })
}

export function assertModulePathSegment(value: string, label: string): void {
  const baseName = value.split('.')[0]?.toUpperCase()
  if (
    !value ||
    value.normalize('NFC') !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) ||
    value === '.' ||
    value === '..' ||
    value.endsWith('.') ||
    baseName === 'CON' ||
    baseName === 'PRN' ||
    baseName === 'AUX' ||
    baseName === 'NUL' ||
    /^COM[1-9]$/.test(baseName ?? '') ||
    /^LPT[1-9]$/.test(baseName ?? '')
  ) {
    throw new Error(`${label} must be a non-empty path segment`)
  }
}

export function assertModuleId(value: string, label: string): void {
  assertModulePathSegment(value, label)
  if (!MODULE_ID.test(value)) {
    throw new Error(`${label} must use a safe lowercase module id`)
  }
}

export function normalizeModuleArtifactFilePath(value: string): string {
  const portable = value.replace(/\\/g, '/')
  if (
    !portable ||
    portable.startsWith('/') ||
    /^[a-zA-Z]:\//.test(portable) ||
    portable.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Module file path must be a relative file path')
  }
  const parts = portable.split('/')
  for (const part of parts) assertModulePathSegment(part, 'Module file path')
  return normalizePortablePath(parts.join('/'))
}

export function resolveModulePluginDir(
  manifest: Readonly<{ id: string; dir?: string }>,
  configDir: string,
): string {
  assertModulePathSegment(manifest.id, 'Plugin id')
  const manifestDir = manifest.dir?.trim()
  if (manifestDir) return normalizePortablePath(manifestDir)
  return normalizePortablePath(`${configDir}/plugins/${manifest.id}`)
}

/** Reads already-installed module artifacts through Obsidian's adapter. */
export class ModuleStore {
  readonly adapter: DataAdapter
  readonly pluginDir: string
  private readonly removalPathOptions: Pick<
    ModuleStoreOptions,
    'manifest' | 'configDir'
  >

  constructor(private readonly options: ModuleStoreOptions) {
    this.adapter = options.adapter
    this.pluginDir = resolveModulePluginDir(options.manifest, options.configDir)
    this.removalPathOptions = Object.freeze({
      configDir: options.configDir,
      manifest: Object.freeze({
        id: options.manifest.id,
        ...(options.manifest.dir === undefined
          ? {}
          : { dir: options.manifest.dir }),
      }),
    })
  }

  async readManifestBytes(
    moduleId: string,
    version: string,
  ): Promise<Uint8Array> {
    assertModuleId(moduleId, 'Module id')
    assertModulePathSegment(version, 'Module version')
    return await this.readBytes(
      `${this.pluginDir}/modules/${moduleId}/${version}/module.json`,
    )
  }

  async readBundledIndexBytes(): Promise<Uint8Array> {
    return await this.readBytes(`${this.pluginDir}/modules/bundled.json`)
  }

  async readEntryBytes(
    moduleId: string,
    version: string,
    entryPath: string,
  ): Promise<Uint8Array> {
    assertModuleId(moduleId, 'Module id')
    assertModulePathSegment(version, 'Module version')
    const relativePath = normalizeModuleArtifactFilePath(entryPath)
    return await this.readBytes(
      `${this.pluginDir}/modules/${moduleId}/${version}/${relativePath}`,
    )
  }

  async listVersionFiles(
    moduleId: string,
    version: string,
  ): Promise<readonly string[]> {
    assertModuleId(moduleId, 'Module id')
    assertModulePathSegment(version, 'Module version')
    const root = normalizePortablePath(
      `${this.pluginDir}/modules/${moduleId}/${version}`,
    )
    const pending = [{ path: root, depth: 0 }]
    const visited = new Set([root.toLowerCase()])
    const files: string[] = []
    let entryCount = 0
    while (pending.length > 0) {
      const folder = pending.pop()!
      const listing = await this.listFolder(folder.path)
      for (const file of listing.files) {
        const normalized = normalizePortablePath(file)
        files.push(relativeVersionPath(root, normalized))
        entryCount += 1
        assertVersionTreeEntryLimit(entryCount)
      }
      for (const child of listing.folders) {
        const normalized = normalizePortablePath(child)
        relativeVersionPath(root, normalized)
        const canonical = normalized.toLowerCase()
        if (visited.has(canonical)) {
          throw new Error('Module version directory contains a traversal cycle')
        }
        if (folder.depth >= MAX_MODULE_VERSION_TREE_DEPTH) {
          throw new Error('Module version directory exceeds the depth limit')
        }
        visited.add(canonical)
        pending.push({ path: normalized, depth: folder.depth + 1 })
        entryCount += 1
        assertVersionTreeEntryLimit(entryCount)
      }
    }
    return Object.freeze(files.sort())
  }

  /** Removes one immutable, redownloadable version tree and verifies absence. */
  async removeVersionArtifacts(
    moduleId: string,
    version: string,
  ): Promise<void> {
    assertModuleId(moduleId, 'Module id')
    assertModulePathSegment(version, 'Module version')
    const destructivePluginDir = resolveDestructiveModulePluginDir(
      this.removalPathOptions,
    )
    const adapter = this.adapter
    if (
      typeof adapter.stat !== 'function' ||
      typeof adapter.rmdir !== 'function'
    ) {
      throw new Error(
        'Module adapter cannot safely remove artifact directories',
      )
    }
    const root = normalizePortablePath(
      `${destructivePluginDir}/modules/${moduleId}/${version}`,
    )
    const expectedRoot = `${destructivePluginDir}/modules/${moduleId}/${version}`
    if (root !== expectedRoot) {
      throw new Error('Module artifact removal root is not canonical')
    }
    const before = await adapter.stat(root)
    if (before === null) return
    if (before.type !== 'folder') {
      throw new Error('Module version artifact root is not a folder')
    }
    try {
      await adapter.rmdir(root, true)
    } catch (error) {
      // A failed adapter call may still have completed. Never recreate artifacts.
      try {
        if ((await adapter.stat(root)) === null) return
      } catch {
        // Preserve the original removal error when absence cannot be proven.
      }
      throw error
    }
    if ((await adapter.stat(root)) !== null) {
      throw new Error('Module version artifacts remain after removal')
    }
  }

  private async readBytes(path: string): Promise<Uint8Array> {
    const normalized = normalizePortablePath(path)
    try {
      const bytes = await this.options.adapter.readBinary(normalized)
      return new Uint8Array(bytes)
    } catch (error) {
      return await this.throwIfMissing(normalized, error)
    }
  }

  private async listFolder(path: string): Promise<ListedFiles> {
    try {
      return await this.options.adapter.list(path)
    } catch (error) {
      return await this.throwIfMissing(path, error)
    }
  }

  private async throwIfMissing(
    path: string,
    original: unknown,
  ): Promise<never> {
    try {
      if ((await this.options.adapter.stat(path)) === null) {
        throw new ModuleArtifactMissingError(path)
      }
    } catch (error) {
      if (error instanceof ModuleArtifactMissingError) throw error
      // Preserve the original read/list failure when absence cannot be proven.
    }
    throw original
  }
}

function resolveDestructiveModulePluginDir(
  options: Pick<ModuleStoreOptions, 'manifest' | 'configDir'>,
): string {
  assertModuleId(options.manifest.id, 'Plugin id')
  const configDir = options.configDir
  if (
    typeof configDir !== 'string' ||
    configDir !== configDir.trim() ||
    configDir.normalize('NFKC') !== configDir ||
    configDir.includes('/') ||
    configDir.includes('\\') ||
    /^[A-Za-z]:/.test(configDir)
  ) {
    throw new Error('Module artifact removal config directory is unsafe')
  }
  const configSegment = configDir.startsWith('.')
    ? configDir.slice(1)
    : configDir
  try {
    assertModulePathSegment(configSegment, 'Config directory')
  } catch {
    throw new Error('Module artifact removal config directory is unsafe')
  }
  const pluginsRoot = `${configDir}/plugins`
  const pluginDir = options.manifest.dir ?? `${pluginsRoot}/${options.manifest.id}`
  const pluginDirPrefix = `${pluginsRoot}/`
  if (
    pluginDir.normalize('NFKC') !== pluginDir ||
    normalizePortablePath(pluginDir) !== pluginDir ||
    !pluginDir.startsWith(pluginDirPrefix)
  ) {
    throw new Error(
      'Module artifact removal manifest directory is outside the expected plugins root',
    )
  }
  try {
    assertModulePathSegment(
      pluginDir.slice(pluginDirPrefix.length),
      'Plugin directory',
    )
  } catch {
    throw new Error(
      'Module artifact removal manifest directory is outside the expected plugins root',
    )
  }
  return pluginDir
}

function relativeVersionPath(root: string, path: string): string {
  const prefix = `${root}/`
  if (!path.startsWith(prefix)) {
    throw new Error(
      'Module adapter returned a path outside the version directory',
    )
  }
  const relative = path.slice(prefix.length)
  if (!relative)
    throw new Error('Module adapter returned an empty relative path')
  return relative
}

function assertVersionTreeEntryLimit(entryCount: number): void {
  if (entryCount > MAX_MODULE_VERSION_TREE_ENTRIES) {
    throw new Error('Module version directory exceeds the entry limit')
  }
}
