import { migrateFrom80To81 } from './80_to_81'

type MigratedAssistant = {
  toolPreferences: Record<string, { enabled?: boolean; approvalMode?: string }>
  enabledToolNames?: string[]
  builtinCapabilityPreferences: Record<
    string,
    { enabled: boolean; approvalMode: string }
  >
}

type MigratedData = {
  version: number
  mcp?: {
    builtinCapabilityOptions?: Record<string, Record<string, unknown>>
    builtinToolOptions?: unknown
  }
  assistants?: MigratedAssistant[]
}

const runMigration = (data: Record<string, unknown>): MigratedData =>
  migrateFrom80To81(data) as MigratedData

describe('migrateFrom80To81', () => {
  it('stamps the version and produces the full builtinCapabilityOptions map when there is no prior data', () => {
    const result = runMigration({ version: 80 })

    expect(result.version).toBe(81)
    expect(result.mcp?.builtinToolOptions).toBeUndefined()
    // Every registered capability gets an entry, all enabled by default
    // (`disabled: false`) since no legacy `builtinToolOptions` existed.
    expect(result.mcp?.builtinCapabilityOptions?.file_editing).toEqual({
      disabled: false,
    })
    expect(result.mcp?.builtinCapabilityOptions?.terminal).toEqual({
      disabled: false,
    })
  })

  it('is a no-op safe default for empty/malformed/missing-field data — never throws', () => {
    expect(() => runMigration({ version: 80 })).not.toThrow()
    expect(() =>
      runMigration({ version: 80, mcp: null, assistants: null }),
    ).not.toThrow()
    expect(() =>
      runMigration({
        version: 80,
        mcp: 'not-an-object',
        assistants: [null, 'not-an-object', 42, { id: 'a' }],
      }),
    ).not.toThrow()

    const result = runMigration({
      version: 80,
      mcp: 'not-an-object',
      assistants: [null, 'not-an-object', 42],
    })
    expect(result.version).toBe(81)
    expect(result.assistants).toEqual([null, 'not-an-object', 42])
    // A malformed `mcp` is treated as absent — the capability map is still
    // built from scratch rather than the migration throwing or skipping it.
    expect(result.mcp?.builtinCapabilityOptions?.file_editing).toEqual({
      disabled: false,
    })
  })

  it('a disabled legacy File Editing group carries `disabled: true` onto file_editing', () => {
    const result = runMigration({
      version: 80,
      mcp: {
        builtinToolOptions: {
          fs_edit_ops: { disabled: true },
        },
      },
    })

    expect(result.mcp?.builtinCapabilityOptions?.file_editing).toEqual({
      disabled: true,
    })
  })

  it('a disabled legacy member key (not just the group key) also disables the capability', () => {
    const result = runMigration({
      version: 80,
      mcp: {
        builtinToolOptions: {
          fs_write: { disabled: true },
        },
      },
    })

    expect(result.mcp?.builtinCapabilityOptions?.file_editing).toEqual({
      disabled: true,
    })
  })

  it('preserves delegate_subagent allowedModelIds/preferredModelId under the new subagent_delegation key', () => {
    const result = runMigration({
      version: 80,
      mcp: {
        builtinToolOptions: {
          delegate_subagent: {
            allowedModelIds: ['openai/gpt-5', 'openai/gpt-4.1-mini'],
            preferredModelId: 'openai/gpt-4.1-mini',
          },
        },
      },
    })

    expect(result.mcp?.builtinCapabilityOptions?.subagent_delegation).toEqual({
      disabled: false,
      allowedModelIds: ['openai/gpt-5', 'openai/gpt-4.1-mini'],
      preferredModelId: 'openai/gpt-4.1-mini',
    })
  })

  it('preserves terminal_command blockedPrefixes under the new terminal key', () => {
    const result = runMigration({
      version: 80,
      mcp: {
        builtinToolOptions: {
          terminal_command: {
            disabled: true,
            blockedPrefixes: ['rm -rf', 'sudo'],
          },
        },
      },
    })

    expect(result.mcp?.builtinCapabilityOptions?.terminal).toEqual({
      disabled: true,
      blockedPrefixes: ['rm -rf', 'sudo'],
    })
  })

  it('stamps the version when there are no assistants', () => {
    expect(runMigration({ version: 80 })).toEqual({
      version: 81,
      mcp: expect.objectContaining({
        builtinCapabilityOptions: expect.any(Object),
      }),
    })
  })

  it('a disabled legacy File Editing agent entry produces file_editing.enabled === false', () => {
    const result = runMigration({
      version: 80,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            yolo_local__fs_edit: {
              enabled: false,
              approvalMode: 'full_access',
            },
            yolo_local__fs_write: {
              enabled: false,
              approvalMode: 'require_approval',
            },
          },
        },
      ],
    })

    const assistant = result.assistants?.[0]
    expect(assistant?.builtinCapabilityPreferences.file_editing).toEqual({
      enabled: false,
      approvalMode: 'require_approval',
    })
  })

  it('fs_edit=full_access + fs_write=require_approval merges to the stricter require_approval', () => {
    const result = runMigration({
      version: 80,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            yolo_local__fs_edit: { enabled: true, approvalMode: 'full_access' },
            yolo_local__fs_write: {
              enabled: true,
              approvalMode: 'require_approval',
            },
          },
        },
      ],
    })

    expect(
      result.assistants?.[0]?.builtinCapabilityPreferences.file_editing,
    ).toEqual({ enabled: true, approvalMode: 'require_approval' })
  })

  it('fs_edit=full_access + fs_write=full_access merges to full_access (no spurious strictening)', () => {
    const result = runMigration({
      version: 80,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            yolo_local__fs_edit: { enabled: true, approvalMode: 'full_access' },
            yolo_local__fs_write: {
              enabled: true,
              approvalMode: 'full_access',
            },
          },
        },
      ],
    })

    expect(
      result.assistants?.[0]?.builtinCapabilityPreferences.file_editing,
    ).toEqual({ enabled: true, approvalMode: 'full_access' })
  })

  it('a require_approval Memory Toolset agent entry produces memory.approvalMode === require_approval', () => {
    const result = runMigration({
      version: 80,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            yolo_local__memory_add: {
              enabled: true,
              approvalMode: 'require_approval',
            },
            yolo_local__memory_update: {
              enabled: true,
              approvalMode: 'require_approval',
            },
            yolo_local__memory_delete: {
              enabled: true,
              approvalMode: 'require_approval',
            },
          },
        },
      ],
    })

    expect(result.assistants?.[0]?.builtinCapabilityPreferences.memory).toEqual(
      { enabled: true, approvalMode: 'require_approval' },
    )
  })

  it('a dangerous_only bash agent entry produces vault_shell.approvalMode === dangerous_only', () => {
    const result = runMigration({
      version: 80,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            yolo_local__bash: { enabled: true, approvalMode: 'dangerous_only' },
          },
        },
      ],
    })

    expect(
      result.assistants?.[0]?.builtinCapabilityPreferences.vault_shell,
    ).toEqual({ enabled: true, approvalMode: 'dangerous_only' })
  })

  // An absent legacy entry means the tool was NOT available at runtime —
  // `getEnabledAssistantToolNames` does no fill-in ("no implicit defaults").
  // The capability's own `defaultEnabled` must NOT be used as the fallback
  // here, or capabilities silently switch on during migration. The D9 plan
  // text says otherwise; it is wrong (see `80_to_81.ts`'s own doc comment).
  it('maps a capability with no legacy entry at all to enabled: false, NOT its defaultEnabled', () => {
    const result = runMigration({
      version: 80,
      assistants: [{ id: 'agent-1', toolPreferences: {} }],
    })

    const prefs = result.assistants?.[0]?.builtinCapabilityPreferences
    // file_editing's `defaultEnabled` is true — irrelevant here, because
    // neither fs_edit nor fs_write was ever granted to this assistant.
    expect(prefs?.file_editing).toEqual({
      enabled: false,
      approvalMode: 'require_approval',
    })
    expect(prefs?.terminal).toEqual({
      enabled: false,
      approvalMode: 'require_approval',
    })
  })

  // The real-world instance of the above, found in this vault's own
  // `data.json`: an assistant created before `bash` shipped (2026-08-08,
  // schema v79) has no `yolo_local__bash` entry in either legacy source, so
  // Vault Shell is off for it — and must stay off, since it can `rm`/`mv`.
  it('keeps vault_shell off for an assistant that predates the bash tool', () => {
    const result = runMigration({
      version: 80,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            yolo_local__fs_read: { enabled: true, approvalMode: 'full_access' },
          },
          enabledToolNames: ['yolo_local__fs_read'],
        },
      ],
    })

    expect(
      result.assistants?.[0]?.builtinCapabilityPreferences.vault_shell,
    ).toEqual({ enabled: false, approvalMode: 'dangerous_only' })
    expect(
      result.assistants?.[0]?.builtinCapabilityPreferences.file_reading,
    ).toEqual({ enabled: true, approvalMode: 'full_access' })
  })

  // `getAssistantToolPreferences` resolves an assistant's effective
  // preferences as `{ ...fromEnabledToolNames, ...toolPreferences }`, so a
  // built-in tool listed only in the legacy `enabledToolNames` array is a
  // real grant. Reading only `toolPreferences` would silently revoke it.
  it('treats a built-in tool present only in enabledToolNames as an enabled grant', () => {
    const result = runMigration({
      version: 80,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {},
          enabledToolNames: [
            'yolo_local__web_search',
            'yolo_local__web_scrape',
          ],
        },
      ],
    })

    expect(
      result.assistants?.[0]?.builtinCapabilityPreferences.web_access,
    ).toEqual({ enabled: true, approvalMode: 'full_access' })
  })

  it('leaves remote MCP toolPreferences, toolServerPreferences, and enabledToolNames entries completely untouched', () => {
    const result = runMigration({
      version: 80,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            server__tool_a: { enabled: true, approvalMode: 'require_approval' },
            server__tool_b: { enabled: false },
            yolo_local__fs_write: {
              enabled: true,
              approvalMode: 'full_access',
            },
          },
          enabledToolNames: [
            'server__tool_a',
            'yolo_local__fs_write',
            'yolo_local__terminal_command',
          ],
          toolServerPreferences: {
            server: {
              approvalMode: 'require_approval',
              disclosureMode: 'always',
            },
          },
        },
      ],
    })

    const assistant = result.assistants?.[0]
    expect(assistant?.toolPreferences).toEqual({
      server__tool_a: { enabled: true, approvalMode: 'require_approval' },
      server__tool_b: { enabled: false },
    })
    expect(assistant?.enabledToolNames).toEqual(['server__tool_a'])
    expect(
      (assistant as unknown as { toolServerPreferences: unknown })
        .toolServerPreferences,
    ).toEqual({
      server: { approvalMode: 'require_approval', disclosureMode: 'always' },
    })
  })

  it('strips every yolo_local__* entry (including retired short names) from toolPreferences and enabledToolNames', () => {
    const result = runMigration({
      version: 80,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            // Retired name — no longer a registered capability member, but
            // still a `yolo_local__*` FQN that must be stripped.
            yolo_local__fs_list: { enabled: true },
            yolo_local__fs_edit: { enabled: true, approvalMode: 'full_access' },
          },
          enabledToolNames: ['yolo_local__fs_list', 'yolo_local__removed_tool'],
        },
      ],
    })

    const assistant = result.assistants?.[0]
    expect(
      Object.keys(assistant?.toolPreferences ?? {}).some((key) =>
        key.startsWith('yolo_local__'),
      ),
    ).toBe(false)
    expect(assistant?.enabledToolNames).toEqual([])
  })

  it('is a no-op for non-object assistant entries', () => {
    const result = runMigration({
      version: 80,
      assistants: [null, 'not-an-object', 42],
    })

    expect(result.assistants).toEqual([null, 'not-an-object', 42])
  })

  it('running the migration twice (idempotency check via re-invocation on already-migrated shape) never reintroduces yolo_local__* entries', () => {
    const once = runMigration({
      version: 80,
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            yolo_local__fs_edit: { enabled: true, approvalMode: 'full_access' },
          },
        },
      ],
    })

    // A second pass would only run if the version guard were bypassed; since
    // `toolPreferences` no longer has any `yolo_local__*` residue, running
    // the same per-assistant transform again is a true no-op on the built-in
    // side (every capability falls back to its own default, since nothing
    // is present to read from toolPreferences anymore).
    const assistant = once.assistants?.[0] as unknown as Record<string, unknown>
    const twice = migrateFrom80To81({
      ...once,
      version: 80,
      assistants: [assistant],
    }) as MigratedData

    expect(
      Object.keys(twice.assistants?.[0]?.toolPreferences ?? {}).some((key) =>
        key.startsWith('yolo_local__'),
      ),
    ).toBe(false)
  })

  /**
   * ⚠️ DO NOT update this list when a new capability ships.
   *
   * It pins that `80_to_81` writes exactly the twelve capabilities that
   * existed at v81 and nothing else — i.e. that it reads its frozen
   * `V81_CAPABILITIES` snapshot rather than the live registry. Wiring it
   * back to `listCapabilities()` would make a 13th capability appear here,
   * and (because a capability with no legacy member entries resolves to
   * `enabled: false`) would stamp that new capability off for every
   * assistant of every user upgrading straight from v80. If this test fails
   * after you added a capability, the fix is to restore the snapshot, not
   * to extend this list.
   */
  const V81_CAPABILITY_IDS = [
    'file_reading',
    'vault_shell',
    'file_editing',
    'context_pruning',
    'context_compaction',
    'user_questions',
    'todo_list',
    'memory',
    'web_access',
    'js_sandbox',
    'terminal',
    'subagent_delegation',
  ]

  it('writes exactly the twelve v81 capabilities globally, never a later-added one', () => {
    const result = runMigration({ version: 80 })

    expect(
      Object.keys(result.mcp?.builtinCapabilityOptions ?? {}).sort(),
    ).toEqual([...V81_CAPABILITY_IDS].sort())
  })

  it('writes exactly the twelve v81 capabilities per assistant, never a later-added one', () => {
    const result = runMigration({
      version: 80,
      assistants: [{ id: 'agent-1', toolPreferences: {} }],
    })

    expect(
      Object.keys(
        result.assistants?.[0]?.builtinCapabilityPreferences ?? {},
      ).sort(),
    ).toEqual([...V81_CAPABILITY_IDS].sort())
  })
})
