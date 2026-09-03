import { migrateFrom84To85 } from './84_to_85'

describe('migrateFrom84To85', () => {
  it('drops the retired global disclosure flag', () => {
    const result = migrateFrom84To85({
      version: 84,
      mcp: { servers: [], enableToolDisclosure: false },
    }) as { version: number; mcp: Record<string, unknown> }

    expect(result.version).toBe(85)
    expect('enableToolDisclosure' in result.mcp).toBe(false)
    expect(result.mcp.servers).toEqual([])
  })

  it('leaves settings without an mcp block alone', () => {
    expect(migrateFrom84To85({ version: 84 })).toEqual({ version: 85 })
  })
})
