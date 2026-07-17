import { type DataAdapter, normalizePath } from 'obsidian'

export type ModuleStoreOptions = {
  adapter: DataAdapter
  manifest: Readonly<{ id: string; dir?: string }>
  configDir: string
}

export type ModuleArtifactManifest = Readonly<{
  schemaVersion: 1
  id: string
  version: string
  hostApi: 1
  entry: Readonly<{
    path: string
    byteSize: number
    sha256: string
  }>
  files: readonly ModuleArtifactFile[]
}>

export type ModuleArtifactFile = Readonly<{
  role: 'entry' | 'style' | 'worker' | 'wasm' | 'data'
  path: string
  byteSize: number
  sha256: string
}>

export type ModuleReadyMarker = Readonly<{
  schemaVersion: 1
  id: string
  version: string
  manifestSha256: string
}>

export const MAX_MODULE_ARTIFACT_FILE_BYTES = 64 * 1024 * 1024
export const MAX_MODULE_ARTIFACT_TOTAL_BYTES = 128 * 1024 * 1024
export const MAX_MODULE_MANIFEST_BYTES = 1024 * 1024
const MAX_MODULE_VERSION_TREE_ENTRIES = 256
const MAX_MODULE_VERSION_TREE_DEPTH = 16

export function parseModuleArtifactManifest(
  value: unknown,
): ModuleArtifactManifest {
  const manifest = value as Partial<ModuleArtifactManifest> | null
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.id !== 'string' ||
    !manifest.id ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    manifest.hostApi !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > 64
  ) {
    throw new Error('Module artifact manifest is invalid')
  }
  assertModuleId(manifest.id, 'Module id')
  assertModulePathSegment(manifest.version, 'Module version')
  const paths = new Set<string>()
  const directoryPaths = new Set<string>()
  let totalByteSize = 0
  const files = manifest.files.map((value) => {
    const file = value as Partial<ModuleArtifactFile> | null
    if (
      !file ||
      (file.role !== 'entry' &&
        file.role !== 'style' &&
        file.role !== 'worker' &&
        file.role !== 'wasm' &&
        file.role !== 'data') ||
      typeof file.path !== 'string' ||
      !Number.isSafeInteger(file.byteSize) ||
      (file.byteSize ?? -1) < 0 ||
      (file.byteSize ?? 0) > MAX_MODULE_ARTIFACT_FILE_BYTES ||
      typeof file.sha256 !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error('Module artifact file is invalid')
    }
    const path = normalizeModuleArtifactFilePath(file.path)
    const canonicalPath = path.toLowerCase()
    if (canonicalPath === 'module.json' || canonicalPath === 'ready.json') {
      throw new Error(`Module artifact file path "${path}" is reserved`)
    }
    if (paths.has(canonicalPath)) {
      throw new Error(`Duplicate module file path "${path}"`)
    }
    paths.add(canonicalPath)
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
      path,
      byteSize: file.byteSize as number,
      sha256: file.sha256.toLowerCase(),
    })
  })
  const entryFiles = files.filter((file) => file.role === 'entry')
  const declaredEntry = manifest.entry as
    | Partial<ModuleArtifactManifest['entry']>
    | undefined
  if (
    entryFiles.length !== 1 ||
    !declaredEntry ||
    typeof declaredEntry.path !== 'string'
  ) {
    throw new Error('Module artifact manifest must declare one entry file')
  }
  const entry = entryFiles[0]
  if (
    normalizeModuleArtifactFilePath(declaredEntry.path) !== entry.path ||
    declaredEntry.byteSize !== entry.byteSize ||
    declaredEntry.sha256?.toLowerCase() !== entry.sha256
  ) {
    throw new Error('Module artifact entry does not match its file declaration')
  }
  return Object.freeze({
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.version,
    hostApi: 1,
    entry: Object.freeze({
      path: entry.path,
      byteSize: entry.byteSize,
      sha256: entry.sha256,
    }),
    files: Object.freeze(files),
  })
}

export function parseModuleReadyMarker(value: unknown): ModuleReadyMarker {
  const marker = value as Partial<ModuleReadyMarker> | null
  if (
    !marker ||
    marker.schemaVersion !== 1 ||
    typeof marker.id !== 'string' ||
    typeof marker.version !== 'string' ||
    typeof marker.manifestSha256 !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(marker.manifestSha256)
  ) {
    throw new Error('Module ready marker is invalid')
  }
  assertModuleId(marker.id, 'Module id')
  assertModulePathSegment(marker.version, 'Module version')
  return Object.freeze({
    schemaVersion: 1,
    id: marker.id,
    version: marker.version,
    manifestSha256: marker.manifestSha256.toLowerCase(),
  })
}

function normalizePortablePath(path: string): string {
  return normalizePath(path.replace(/\\/g, '/'))
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
  if (value !== value.toLowerCase()) {
    throw new Error(`${label} must use lowercase characters`)
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
  readonly pluginDir: string

  constructor(private readonly options: ModuleStoreOptions) {
    this.pluginDir = resolveModulePluginDir(options.manifest, options.configDir)
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

  async readReadyMarkerBytes(
    moduleId: string,
    version: string,
  ): Promise<Uint8Array> {
    assertModuleId(moduleId, 'Module id')
    assertModulePathSegment(version, 'Module version')
    return await this.readBytes(
      `${this.pluginDir}/modules/${moduleId}/${version}/ready.json`,
    )
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
      const listing = await this.options.adapter.list(folder.path)
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

  private async readBytes(path: string): Promise<Uint8Array> {
    const bytes = await this.options.adapter.readBinary(
      normalizePortablePath(path),
    )
    return new Uint8Array(bytes)
  }
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
