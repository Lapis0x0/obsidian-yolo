import { migrateFrom82To83 } from './82_to_83'

describe('migrateFrom82To83', () => {
  it('drops the retired global disclosure flag', () => {
    const result = migrateFrom82To83({
      version: 82,
      mcp: { servers: [], enableToolDisclosure: false },
    }) as { version: number; mcp: Record<string, unknown> }

    expect(result.version).toBe(83)
    expect('enableToolDisclosure' in result.mcp).toBe(false)
    expect(result.mcp.servers).toEqual([])
  })

  it('leaves settings without an mcp block alone', () => {
    expect(migrateFrom82To83({ version: 82 })).toEqual({ version: 83 })
  })
})
