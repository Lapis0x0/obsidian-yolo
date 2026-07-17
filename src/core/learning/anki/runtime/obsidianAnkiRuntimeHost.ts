import { type DataAdapter, normalizePath, requestUrl } from 'obsidian'

import type {
  AnkiRuntimeHost,
  AnkiRuntimeStorage,
} from './AnkiRuntimeHost'

type ObsidianAnkiRuntimeHostOptions = {
  adapter: DataAdapter
  manifest: Readonly<{ id: string; dir?: string }>
  configDir: string
}

const runtimeLocks = new WeakMap<DataAdapter, Map<string, Promise<void>>>()

const normalizePortablePath = (path: string): string =>
  normalizePath(path.replace(/\\/g, '/'))

const assertRelativePath = (
  path: string,
  label: string,
  allowRoot = false,
): string => {
  const portable = path.replace(/\\/g, '/')
  if (allowRoot && !portable) return portable
  if (
    !portable ||
    portable.startsWith('/') ||
    /^[a-zA-Z]:/.test(portable) ||
    portable.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`${label} must be a safe vault-relative path`)
  }
  return portable
}

const assertPluginId = (pluginId: string): void => {
  if (!pluginId || pluginId === '.' || pluginId === '..' || /[\\/]/.test(pluginId)) {
    throw new Error('Plugin id must be a non-empty path segment')
  }
}

export const resolveAnkiRuntimeRoot = (
  manifest: Readonly<{ id: string; dir?: string }>,
  configDir: string,
): string => {
  assertPluginId(manifest.id)
  const manifestDir = manifest.dir?.trim()
  const pluginDir = manifestDir
    ? assertRelativePath(manifestDir, 'Plugin directory')
    : `${assertRelativePath(configDir, 'Config directory')}/plugins/${manifest.id}`
  return normalizePortablePath(`${pluginDir}/runtime/anki-sqlite`)
}

const runRootExclusive = async <T>(
  adapter: DataAdapter,
  root: string,
  operation: () => Promise<T>,
): Promise<T> => {
  let locks = runtimeLocks.get(adapter)
  if (!locks) {
    locks = new Map()
    runtimeLocks.set(adapter, locks)
  }
  const previous = locks.get(root) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(root, current)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(root) === current) locks.delete(root)
  }
}

export const createObsidianAnkiRuntimeHost = ({
  adapter,
  manifest,
  configDir,
}: ObsidianAnkiRuntimeHostOptions): AnkiRuntimeHost => {
  const root = resolveAnkiRuntimeRoot(manifest, configDir)
  const resolve = (relativePath: string): string => {
    const safePath = assertRelativePath(
      relativePath,
      'Anki runtime storage path',
      true,
    )
    return safePath ? normalizePortablePath(`${root}/${safePath}`) : root
  }

  const storage: AnkiRuntimeStorage = {
    exists: async (path) => await adapter.exists(resolve(path)),
    stat: async (path) => {
      const stat = await adapter.stat(resolve(path))
      return stat ? { type: stat.type, size: stat.size } : null
    },
    list: async (path) => {
      const listing = await adapter.list(resolve(path))
      return {
        files: listing.files.map((entry) => entry.slice(root.length + 1)),
        folders: listing.folders.map((entry) => entry.slice(root.length + 1)),
      }
    },
    mkdir: async (path) => {
      const resolved = resolve(path)
      try {
        await adapter.mkdir(resolved)
      } catch (error) {
        if (!(await adapter.exists(resolved))) throw error
      }
    },
    remove: async (path) => {
      const resolved = resolve(path)
      if (!(await adapter.exists(resolved))) return
      const stat = await adapter.stat(resolved)
      if (stat?.type === 'folder') await adapter.rmdir(resolved, true)
      else await adapter.remove(resolved)
    },
    rename: async (fromPath, toPath) =>
      await adapter.rename(resolve(fromPath), resolve(toPath)),
    readText: async (path) => await adapter.read(resolve(path)),
    readBinary: async (path) => await adapter.readBinary(resolve(path)),
    writeText: async (path, content) =>
      await adapter.write(resolve(path), content),
    writeBinary: async (path, content) =>
      await adapter.writeBinary(resolve(path), content),
  }

  return {
    storage,
    downloadArrayBuffer: async (url) => {
      const response = await requestUrl({ url, method: 'GET', throw: false })
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Runtime download failed: HTTP ${response.status}`)
      }
      return response.arrayBuffer.slice(0)
    },
    runExclusive: (operation) => runRootExclusive(adapter, root, operation),
  }
}
