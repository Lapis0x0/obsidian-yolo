import type { YoloVaultIndexEntry } from '../yoloRuntime.types'
import type { WebApiClient } from './WebApiClient'

type VaultListResponse = {
  files: string[]
  folders: string[]
}

function normalizeVaultPath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '') || '/'
}

function toBaseEntry(
  kind: 'file' | 'folder',
  path: string,
): YoloVaultIndexEntry | null {
  const normalizedPath = normalizeVaultPath(path)
  if (normalizedPath === '/') {
    return kind === 'folder'
      ? null
      : {
          kind,
          path: normalizedPath,
          name: '/',
          basename: '/',
          extension: '',
        }
  }

  const name = normalizedPath.split('/').pop() ?? normalizedPath
  const dotIndex = name.lastIndexOf('.')

  return {
    kind,
    path: normalizedPath,
    name,
    basename: kind === 'file' && dotIndex > 0 ? name.slice(0, dotIndex) : name,
    extension: kind === 'file' && dotIndex >= 0 ? name.slice(dotIndex + 1) : '',
  }
}

function sanitizeIndex(index: YoloVaultIndexEntry[]): YoloVaultIndexEntry[] {
  const entries = new Map<string, YoloVaultIndexEntry>()

  for (const entry of index) {
    const normalizedPath = normalizeVaultPath(entry.path)
    if (entry.kind === 'folder' && normalizedPath === '/') {
      continue
    }

    const normalizedEntry = {
      ...entry,
      path: normalizedPath,
    }
    entries.set(`${entry.kind}:${normalizedPath}`, normalizedEntry)
  }

  return Array.from(entries.values()).sort((a, b) => a.path.localeCompare(b.path))
}

async function crawlVaultIndex(
  api: WebApiClient,
  seedPaths: string[],
): Promise<YoloVaultIndexEntry[]> {
  const queue = [...seedPaths]
  const visited = new Set<string>()
  const entries: YoloVaultIndexEntry[] = []

  while (queue.length > 0) {
    const currentPath = queue.shift()
    if (!currentPath) {
      continue
    }

    const normalizedPath = normalizeVaultPath(currentPath)
    if (visited.has(normalizedPath)) {
      continue
    }
    visited.add(normalizedPath)

    let listing: VaultListResponse
    try {
      listing = await api.getJson<VaultListResponse>(
        `/api/vault/list?path=${encodeURIComponent(currentPath)}`,
      )
    } catch {
      continue
    }

    for (const folderPath of listing.folders) {
      const folderEntry = toBaseEntry('folder', folderPath)
      if (folderEntry) {
        entries.push(folderEntry)
        queue.push(folderEntry.path)
      }
    }

    for (const filePath of listing.files) {
      const fileEntry = toBaseEntry('file', filePath)
      if (fileEntry) {
        entries.push(fileEntry)
      }
    }
  }

  return sanitizeIndex(entries)
}

export async function fetchInitialVaultIndex(
  api: WebApiClient,
): Promise<YoloVaultIndexEntry[]> {
  const index = sanitizeIndex(
    await api.getJson<YoloVaultIndexEntry[]>('/api/vault/index'),
  )

  if (index.some((entry) => entry.kind === 'file')) {
    return index
  }

  const seedPaths = [
    '/',
    ...index
      .filter((entry) => entry.kind === 'folder')
      .map((entry) => entry.path),
  ]

  const crawledIndex = await crawlVaultIndex(api, seedPaths)
  return sanitizeIndex([...index, ...crawledIndex])
}
