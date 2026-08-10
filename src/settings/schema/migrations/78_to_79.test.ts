import { migrateFrom78To79 } from './78_to_79'

describe('migrateFrom78To79', () => {
  it('stamps the version when there are no assistants', () => {
    expect(migrateFrom78To79({ version: 78 })).toEqual({ version: 79 })
  })

  it('seeds the bash tool for an assistant that already has explicit toolPreferences', () => {
    const result = migrateFrom78To79({
      version: 78,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            yolo_local__fs_edit: { enabled: true, approvalMode: 'full_access' },
            yolo_local__terminal_command: {
              enabled: false,
              approvalMode: 'require_approval',
            },
          },
        },
      ],
    })

    expect(result.version).toBe(79)
    const assistants = (
      result as {
        assistants: Array<{ toolPreferences: Record<string, unknown> }>
      }
    ).assistants
    const preferences = assistants[0]?.toolPreferences

    // Pre-existing explicit preferences are untouched, including a
    // deliberately-disabled terminal_command.
    expect(preferences?.yolo_local__fs_edit).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    expect(preferences?.yolo_local__terminal_command).toEqual({
      enabled: false,
      approvalMode: 'require_approval',
    })
    // bash was missing, so it gets filled in with its current default.
    expect(preferences?.yolo_local__bash).toEqual({
      enabled: true,
      approvalMode: 'dangerous_only',
    })
  })

  it('leaves an assistant untouched when nothing is missing', () => {
    const assistant = {
      id: 'agent-2',
      toolPreferences: {
        yolo_local__bash: { enabled: false, approvalMode: 'full_access' },
      },
    }

    const result = migrateFrom78To79({
      version: 78,
      assistants: [assistant],
    }) as { assistants: unknown[] }

    // A user who explicitly disabled bash keeps it disabled — the migration
    // only fills genuinely missing entries, never overrides existing ones.
    expect(
      (result.assistants[0] as { toolPreferences: Record<string, unknown> })
        .toolPreferences.yolo_local__bash,
    ).toEqual({ enabled: false, approvalMode: 'full_access' })
  })

  it('is a no-op for non-object assistant entries', () => {
    const result = migrateFrom78To79({
      version: 78,
      assistants: [null, 'not-an-object', 42],
    })

    expect(result).toEqual({
      version: 79,
      assistants: [null, 'not-an-object', 42],
    })
  })
})
