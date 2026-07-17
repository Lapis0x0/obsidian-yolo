import { type DataAdapter, normalizePath } from 'obsidian'

export type ModuleStoreOptions = {
  adapter: DataAdapter
  manifest: Readonly<{ id: string; dir?: string }>
  configDir: string
}

export type ModuleArtifactManifest = Readonly<{
  id: string
  version: string
  entry: Readonly<{
    path: string
    byteSize: number
    sha256: string
  }>
}>

export function parseModuleArtifactManifest(
  value: unknown,
): ModuleArtifactManifest {
  const manifest = value as Partial<ModuleArtifactManifest> | null
  const entry = manifest?.entry as
    | Partial<ModuleArtifactManifest['entry']>
    | undefined
  if (
    !manifest ||
    typeof manifest.id !== 'string' ||
    !manifest.id ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    !entry ||
    typeof entry.path !== 'string' ||
    !entry.path ||
    !Number.isSafeInteger(entry.byteSize) ||
    (entry.byteSize ?? -1) < 0 ||
    typeof entry.sha256 !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(entry.sha256)
  ) {
    throw new Error('Module artifact manifest is invalid')
  }
  return manifest as ModuleArtifactManifest
}

function normalizePortablePath(path: string): string {
  return normalizePath(path.replace(/\\/g, '/'))
}

function assertPathSegment(value: string, label: string): void {
  if (!value || value === '.' || value === '..' || /[\\/]/.test(value)) {
    throw new Error(`${label} must be a non-empty path segment`)
  }
}

function assertRelativeFilePath(value: string): string {
  const portable = value.replace(/\\/g, '/')
  if (
    !portable ||
    portable.startsWith('/') ||
    /^[a-zA-Z]:\//.test(portable) ||
    portable.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Module entry path must be a relative file path')
  }
  return normalizePortablePath(portable)
}

export function resolveModulePluginDir(
  manifest: Readonly<{ id: string; dir?: string }>,
  configDir: string,
): string {
  assertPathSegment(manifest.id, 'Plugin id')
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
    assertPathSegment(moduleId, 'Module id')
    assertPathSegment(version, 'Module version')
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
    assertPathSegment(moduleId, 'Module id')
    assertPathSegment(version, 'Module version')
    const relativePath = assertRelativeFilePath(entryPath)
    return await this.readBytes(
      `${this.pluginDir}/modules/${moduleId}/${version}/${relativePath}`,
    )
  }

  private async readBytes(path: string): Promise<Uint8Array> {
    const bytes = await this.options.adapter.readBinary(
      normalizePortablePath(path),
    )
    return new Uint8Array(bytes)
  }
}
