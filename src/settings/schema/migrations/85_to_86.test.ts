import { migrateFrom85To86 } from './85_to_86'

describe('migrateFrom85To86', () => {
  it('drops the retired memory capability option and assistant preference', () => {
    const result = migrateFrom85To86({
      version: 85,
      mcp: {
        servers: [],
        builtinCapabilityOptions: {
          memory: { approvalMode: 'full_access' },
          web_access: { approvalMode: 'require_approval' },
        },
      },
      assistants: [
        {
          id: 'a1',
          builtinCapabilityPreferences: { memory: false, file_editing: true },
        },
        { id: 'a2', builtinCapabilityPreferences: { memory: true } },
      ],
    }) as {
      version: number
      mcp: { builtinCapabilityOptions: Record<string, unknown> }
      assistants: { builtinCapabilityPreferences: Record<string, unknown> }[]
    }

    expect(result.version).toBe(86)
    expect('memory' in result.mcp.builtinCapabilityOptions).toBe(false)
    expect(result.mcp.builtinCapabilityOptions.web_access).toEqual({
      approvalMode: 'require_approval',
    })
    expect(result.assistants[0].builtinCapabilityPreferences).toEqual({
      file_editing: true,
    })
    expect(result.assistants[1].builtinCapabilityPreferences).toEqual({})
  })

  it('is a no-op beyond the version bump when no memory keys exist', () => {
    expect(
      migrateFrom85To86({
        version: 85,
        mcp: { servers: [] },
        assistants: [{ id: 'a1' }],
      }),
    ).toEqual({
      version: 86,
      mcp: { servers: [] },
      assistants: [{ id: 'a1' }],
    })
  })

  it('leaves settings without mcp or assistants blocks alone', () => {
    expect(migrateFrom85To86({ version: 85 })).toEqual({ version: 86 })
  })
})
