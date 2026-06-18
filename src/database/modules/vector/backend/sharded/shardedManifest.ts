import { z } from 'zod'

import { ShardedManifest } from './types'

const shardedManifestSchema: z.ZodType<ShardedManifest> = z.object({
  schemaVersion: z.number().int().nonnegative(),
  formatVersion: z.number().int().nonnegative(),
  activeModel: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
  shards: z.array(
    z.object({
      id: z.string().min(1),
      relativePath: z.string().min(1),
      state: z.enum(['ready', 'building']),
      dimension: z.number().int().positive(),
      vectorCount: z.number().int().nonnegative(),
      checksums: z.object({
        chunksSqlite: z.string().min(1),
        vectorsF32: z.string().min(1),
        indexBin: z.string().min(1),
        tombstonesBin: z.string().min(1),
        shardMeta: z.string().min(1),
      }),
    }),
  ),
})

export const parseShardedManifest = (input: unknown): ShardedManifest =>
  shardedManifestSchema.parse(input)
