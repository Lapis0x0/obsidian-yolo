export type ShardedManifestShard = {
  id: string
  relativePath: string
  state: 'ready' | 'building'
  dimension: number
  vectorCount: number
  checksums: {
    chunksSqlite: string
    vectorsF32: string
    indexBin: string
    tombstonesBin: string
    shardMeta: string
  }
}

export type ShardedManifest = {
  schemaVersion: number
  formatVersion: number
  activeModel: string
  updatedAt: number
  shards: ShardedManifestShard[]
}
