const normalizeSegment = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/g, '')

export const getShardedIndexRoot = (baseDir: string): string =>
  `${normalizeSegment(baseDir)}/rag-index/v1`

export const getShardedManifestPath = (baseDir: string): string =>
  `${getShardedIndexRoot(baseDir)}/manifest.json`

export const getShardedStagedManifestPath = (baseDir: string): string =>
  `${getShardedIndexRoot(baseDir)}/manifest.next.json`

export const getShardedModelRoot = (
  baseDir: string,
  modelNamespace: string,
): string => `${getShardedIndexRoot(baseDir)}/models/${modelNamespace}`

export const getShardedShardRoot = (
  baseDir: string,
  modelNamespace: string,
  shardId: string,
): string => `${getShardedModelRoot(baseDir, modelNamespace)}/shards/${shardId}`

export const getShardedTempShardRoot = (
  baseDir: string,
  modelNamespace: string,
  runId: string,
  shardId: string,
): string =>
  `${getShardedModelRoot(baseDir, modelNamespace)}/shards/.build-${runId}-${shardId}`
