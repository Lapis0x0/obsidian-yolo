import type {
  AnkiRuntimeStorageListing,
  AnkiRuntimeStoragePort,
} from '../../anki/runtime/ports'

import { encodeStorageSegment } from './paths'

type PrivateStorageScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']

const storageLocks = new WeakMap<
  PrivateStorageScope,
  Map<string, Promise<void>>
>()

const assertRelativePath = (path: string, allowRoot = false): string => {
  if (allowRoot && path === '') return path
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.normalize('NFC') !== path ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Anki private storage path must be canonical and relative')
  }
  return path
}

const ENCODED_SEGMENT_PREFIX = 'p'

const encodePrivateSegment = (segment: string): string =>
  `${ENCODED_SEGMENT_PREFIX}${encodeStorageSegment(segment)}`

const decodePrivateSegment = (segment: string): string => {
  if (!segment.startsWith(ENCODED_SEGMENT_PREFIX)) {
    throw new Error('Host private storage returned an invalid encoded entry')
  }
  const encoded = segment.slice(ENCODED_SEGMENT_PREFIX.length)
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
    throw new Error('Host private storage returned an invalid encoded entry')
  }
  const bytes = Uint8Array.from(encoded.match(/.{2}/g)!, (value) =>
    Number.parseInt(value, 16),
  )
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (encodePrivateSegment(decoded) !== segment) {
    throw new Error('Host private storage returned a non-canonical entry')
  }
  return decoded
}

const mapPath = (rootKey: string, path: string): string => {
  const relative = assertRelativePath(path, true)
  return relative
    ? `${rootKey}/${relative.split('/').map(encodePrivateSegment).join('/')}`
    : rootKey
}

const requireValue = <T>(value: T | null, path: string): T => {
  if (value === null)
    throw new Error(`Anki private storage file not found: ${path}`)
  return value
}

export const createRootedAnkiRuntimeStorage = (
  scope: PrivateStorageScope,
  root = 'anki-runtime',
): AnkiRuntimeStoragePort => {
  const rootKey = assertRelativePath(root)
  const stripRoot = (key: string): string => {
    const prefix = `${rootKey}/`
    if (!key.startsWith(prefix)) {
      throw new Error('Host private storage returned an out-of-root entry')
    }
    return key
      .slice(prefix.length)
      .split('/')
      .map(decodePrivateSegment)
      .join('/')
  }

  return {
    exists: async (path) => (await scope.stat(mapPath(rootKey, path))) !== null,
    stat: (path) => scope.stat(mapPath(rootKey, path)),
    list: async (path): Promise<AnkiRuntimeStorageListing> => {
      const listing = await scope.listEntries(mapPath(rootKey, path))
      return {
        files: listing.files.map(stripRoot),
        folders: listing.folders.map(stripRoot),
      }
    },
    mkdir: (path) => scope.mkdir(mapPath(rootKey, path)),
    remove: (path) => scope.remove(mapPath(rootKey, path)),
    rename: (fromPath, toPath) =>
      scope.rename(mapPath(rootKey, fromPath), mapPath(rootKey, toPath)),
    readText: async (path) =>
      requireValue(await scope.readText(mapPath(rootKey, path)), path),
    readBinary: async (path) =>
      requireValue(await scope.readBinary(mapPath(rootKey, path)), path),
    writeText: (path, content) =>
      scope.writeText(mapPath(rootKey, path), content),
    writeBinary: (path, content) =>
      scope.writeBinary(mapPath(rootKey, path), content),
  }
}

export const runHostStorageExclusive = async <T>(
  scope: PrivateStorageScope,
  root: string,
  operation: () => Promise<T>,
): Promise<T> => {
  let roots = storageLocks.get(scope)
  if (!roots) {
    roots = new Map()
    storageLocks.set(scope, roots)
  }
  const previous = roots.get(root) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  roots.set(root, current)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (roots.get(root) === current) roots.delete(root)
  }
}
