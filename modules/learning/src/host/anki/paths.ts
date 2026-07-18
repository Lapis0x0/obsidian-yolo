const JSON_DATA_DIR = '.yolo_json_db'

const normalizeVaultPath = (path: string, label: string): string => {
  if (path.includes('\\')) throw new Error(`${label} must use vault separators`)
  const normalized = path.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
  if (
    !normalized ||
    normalized !== path ||
    normalized.normalize('NFC') !== normalized ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`${label} must be a canonical vault-relative path`)
  }
  return normalized
}

export const getHostLearningDataRoot = (
  paths: YoloModuleHostApiV1['paths'],
): string => {
  const contentRoot = normalizeVaultPath(
    paths.getSnapshot().contentRoot,
    'Learning content root',
  )
  const parent = contentRoot.split('/').slice(0, -1).join('/')
  return parent ? `${parent}/${JSON_DATA_DIR}` : JSON_DATA_DIR
}

export const normalizeHostAnkiPath = normalizeVaultPath

export const splitLearningDataPath = (
  path: string,
): Readonly<{ root: string; relative: string }> => {
  const normalized = normalizeVaultPath(path, 'Learning data path')
  const parts = normalized.split('/')
  const rootIndex = parts.lastIndexOf(JSON_DATA_DIR)
  if (rootIndex < 0) {
    throw new Error(`Learning data path is outside ${JSON_DATA_DIR}: ${path}`)
  }
  return {
    root: parts.slice(0, rootIndex + 1).join('/'),
    relative: parts.slice(rootIndex + 1).join('/'),
  }
}

export const encodeStorageSegment = (value: string): string =>
  Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
