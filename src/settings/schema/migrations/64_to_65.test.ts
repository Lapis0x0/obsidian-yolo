import { migrateFrom64To65 } from './64_to_65'

describe('migrateFrom64To65', () => {
  it('renames fs_create_file and merges delete tools in toolPreferences (FQN keys)', () => {
    const result = migrateFrom64To65({
      version: 64,
      assistants: [
        {
          id: 'a1',
          name: 'Default',
          toolPreferences: {
            yolo_local__fs_read: { enabled: true, approvalMode: 'full_access' },
            yolo_local__fs_create_file: {
              enabled: true,
              approvalMode: 'full_access',
            },
            yolo_local__fs_delete_file: {
              enabled: true,
              approvalMode: 'full_access',
            },
            yolo_local__fs_delete_dir: {
              enabled: true,
              approvalMode: 'full_access',
            },
            yolo_local__fs_move: { enabled: true, approvalMode: 'full_access' },
          },
        },
      ],
    })

    expect(result.version).toBe(65)
    const prefs = (result.assistants as Array<Record<string, unknown>>)[0]
      .toolPreferences as Record<string, unknown>

    expect(prefs.yolo_local__fs_create_file).toBeUndefined()
    expect(prefs.yolo_local__fs_delete_file).toBeUndefined()
    expect(prefs.yolo_local__fs_delete_dir).toBeUndefined()

    expect(prefs.yolo_local__fs_write).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    expect(prefs.yolo_local__fs_delete).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    expect(prefs.yolo_local__fs_move).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    expect(prefs.yolo_local__fs_read).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
  })

  it('handles bare (unprefixed) toolPreferences keys', () => {
    const result = migrateFrom64To65({
      version: 64,
      assistants: [
        {
          id: 'a1',
          name: 'Default',
          toolPreferences: {
            fs_create_file: { enabled: true },
            fs_delete_file: { enabled: true },
            fs_delete_dir: { enabled: true },
          },
        },
      ],
    })

    const prefs = (result.assistants as Array<Record<string, unknown>>)[0]
      .toolPreferences as Record<string, unknown>

    expect(prefs.fs_write).toEqual({ enabled: true })
    expect(prefs.fs_delete).toEqual({ enabled: true })
    expect(prefs.fs_create_file).toBeUndefined()
    expect(prefs.fs_delete_file).toBeUndefined()
    expect(prefs.fs_delete_dir).toBeUndefined()
  })

  describe('conservative union for merged fs_delete preference', () => {
    const merged = (
      file: Record<string, unknown>,
      dir: Record<string, unknown>,
    ): Record<string, unknown> => {
      const result = migrateFrom64To65({
        version: 64,
        assistants: [
          {
            id: 'a1',
            name: 'A',
            toolPreferences: {
              yolo_local__fs_delete_file: file,
              yolo_local__fs_delete_dir: dir,
            },
          },
        ],
      })
      return (result.assistants as Array<Record<string, unknown>>)[0]
        .toolPreferences as Record<string, unknown>
    }

    it('enabled only when both enabled', () => {
      expect(
        (
          merged({ enabled: true }, { enabled: true })
            .yolo_local__fs_delete as Record<string, unknown>
        ).enabled,
      ).toBe(true)
      expect(
        (
          merged({ enabled: true }, { enabled: false })
            .yolo_local__fs_delete as Record<string, unknown>
        ).enabled,
      ).toBe(false)
      expect(
        (
          merged({ enabled: false }, { enabled: false })
            .yolo_local__fs_delete as Record<string, unknown>
        ).enabled,
      ).toBe(false)
    })

    it('absent enabled is treated as false (matches runtime default)', () => {
      expect(
        (merged({}, {}).yolo_local__fs_delete as Record<string, unknown>)
          .enabled,
      ).toBe(false)
      // A pref the runtime sees as disabled (no enabled field) must not
      // migrate into an enabled fs_delete.
      expect(
        (
          merged({ approvalMode: 'full_access' }, { enabled: true })
            .yolo_local__fs_delete as Record<string, unknown>
        ).enabled,
      ).toBe(false)
    })

    it('a missing delete preference key counts as not-enabled', () => {
      // Only fs_delete_file present (enabled); fs_delete_dir key absent.
      const result = migrateFrom64To65({
        version: 64,
        assistants: [
          {
            id: 'a1',
            name: 'A',
            toolPreferences: {
              yolo_local__fs_delete_file: { enabled: true },
            },
          },
        ],
      })
      const prefs = (result.assistants as Array<Record<string, unknown>>)[0]
        .toolPreferences as Record<string, unknown>
      expect(
        (prefs.yolo_local__fs_delete as Record<string, unknown>).enabled,
      ).toBe(false)
    })

    it('approvalMode require_approval if either requires it', () => {
      expect(
        (
          merged(
            { approvalMode: 'full_access' },
            { approvalMode: 'require_approval' },
          ).yolo_local__fs_delete as Record<string, unknown>
        ).approvalMode,
      ).toBe('require_approval')
      expect(
        (
          merged(
            { approvalMode: 'full_access' },
            { approvalMode: 'full_access' },
          ).yolo_local__fs_delete as Record<string, unknown>
        ).approvalMode,
      ).toBe('full_access')
    })

    it('disclosureMode on_demand if either is on_demand', () => {
      expect(
        (
          merged({ disclosureMode: 'always' }, { disclosureMode: 'on_demand' })
            .yolo_local__fs_delete as Record<string, unknown>
        ).disclosureMode,
      ).toBe('on_demand')
    })
  })

  it('merges builtinToolOptions delete options conservatively and renames write', () => {
    const result = migrateFrom64To65({
      version: 64,
      mcp: {
        servers: [],
        builtinToolOptions: {
          fs_create_file: { disabled: true },
          fs_delete_file: { disabled: false },
          fs_delete_dir: { disabled: true },
          fs_move: {},
        },
      },
    })

    const options = (result.mcp as Record<string, unknown>)
      .builtinToolOptions as Record<string, unknown>

    expect(options.fs_create_file).toBeUndefined()
    expect(options.fs_delete_file).toBeUndefined()
    expect(options.fs_delete_dir).toBeUndefined()
    expect(options.fs_write).toEqual({ disabled: true })
    // delete_dir disabled → merged fs_delete disabled
    expect(options.fs_delete).toEqual({ disabled: true })
    expect(options.fs_move).toEqual({})
  })

  it('leaves fs_delete enabled when neither legacy delete option is disabled', () => {
    const result = migrateFrom64To65({
      version: 64,
      mcp: {
        builtinToolOptions: {
          fs_delete_file: {},
          fs_delete_dir: { disabled: false },
        },
      },
    })

    const options = (result.mcp as Record<string, unknown>)
      .builtinToolOptions as Record<string, unknown>
    expect(options.fs_delete).toEqual({})
  })

  it('renames leftover split FQNs in enabledToolNames defensively', () => {
    const result = migrateFrom64To65({
      version: 64,
      assistants: [
        {
          id: 'a1',
          name: 'A',
          enabledToolNames: [
            'yolo_local__fs_file_ops',
            'yolo_local__fs_create_file',
            'yolo_local__fs_delete_file',
            'yolo_local__fs_delete_dir',
            'yolo_local__fs_move',
          ],
        },
      ],
    })

    const names = (result.assistants as Array<Record<string, unknown>>)[0]
      .enabledToolNames as string[]

    expect(names).toContain('yolo_local__fs_file_ops')
    expect(names).toContain('yolo_local__fs_write')
    expect(names).toContain('yolo_local__fs_delete')
    expect(names).toContain('yolo_local__fs_move')
    expect(names).not.toContain('yolo_local__fs_create_file')
    expect(names).not.toContain('yolo_local__fs_delete_file')
    expect(names).not.toContain('yolo_local__fs_delete_dir')
  })

  it('legacy fs_create_file wins over a pre-seeded fs_write on collision', () => {
    // Simulates a multi-step upgrade where an earlier migration seeded a
    // default fs_write before this migration runs alongside the user's real
    // fs_create_file preference.
    const result = migrateFrom64To65({
      version: 64,
      assistants: [
        {
          id: 'a1',
          name: 'A',
          toolPreferences: {
            yolo_local__fs_write: {
              enabled: true,
              approvalMode: 'require_approval',
            },
            yolo_local__fs_create_file: {
              enabled: false,
              approvalMode: 'full_access',
            },
          },
        },
      ],
      mcp: {
        builtinToolOptions: {
          fs_write: { disabled: false },
          fs_create_file: { disabled: true },
        },
      },
    })

    const prefs = (result.assistants as Array<Record<string, unknown>>)[0]
      .toolPreferences as Record<string, unknown>
    expect(prefs.yolo_local__fs_write).toEqual({
      enabled: false,
      approvalMode: 'full_access',
    })

    const options = (result.mcp as Record<string, unknown>)
      .builtinToolOptions as Record<string, unknown>
    expect(options.fs_write).toEqual({ disabled: true })
  })

  it('deduplicates fs_delete in enabledToolNames after renaming both delete FQNs', () => {
    const result = migrateFrom64To65({
      version: 64,
      assistants: [
        {
          id: 'a1',
          name: 'A',
          enabledToolNames: [
            'yolo_local__fs_delete_file',
            'yolo_local__fs_delete_dir',
          ],
        },
      ],
    })

    const names = (result.assistants as Array<Record<string, unknown>>)[0]
      .enabledToolNames as string[]
    expect(names.filter((n) => n === 'yolo_local__fs_delete')).toHaveLength(1)
  })

  it('is a no-op when no fs tool state is present', () => {
    const result = migrateFrom64To65({
      version: 64,
      chatModelId: 'gpt-4',
    })

    expect(result.version).toBe(65)
    expect(result.chatModelId).toBe('gpt-4')
  })
})
