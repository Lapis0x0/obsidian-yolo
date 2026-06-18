import { parseShardedManifest } from './shardedManifest'

describe('parseShardedManifest', () => {
  it('parses a valid manifest', () => {
    const manifest = parseShardedManifest({
      schemaVersion: 1,
      formatVersion: 1,
      activeModel: 'openai/text-embedding-3-small@1536',
      updatedAt: 1,
      shards: [],
    })

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.shards).toEqual([])
  })
})
