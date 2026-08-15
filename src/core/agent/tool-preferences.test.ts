import { USER_FACING_LOCAL_TOOL_SHORT_NAMES } from '../mcp/localFileTools'
import { getCapabilityForTool, listCapabilities } from '../tools/registry'

import {
  BUILTIN_DEFAULT_ENABLED_TOOL_FQNS,
  buildServerToolTokenBudgets,
  getAssistantToolApprovalMode,
  getAssistantToolDisclosureMode,
  getDefaultApprovalModeForTool,
  getDefaultEnabledForTool,
  getEnabledAssistantToolNames,
  getExplicitlyEnabledAssistantToolNames,
  isAssistantToolEnabled,
  pruneOrphanedAssistantToolPreferences,
  renameAssistantToolPreferencesServer,
} from './tool-preferences'

const JS_SANDBOX_FQN = 'yolo_local__js_eval'

describe('tool-preferences defaults', () => {
  it('shares cached MCP schema costs across catalog consumers', async () => {
    const estimate = jest.fn().mockResolvedValue(123)
    const buildCatalog = () =>
      new Map([
        [
          'cache_test_server',
          [
            {
              name: 'cache_test_server__unique_tool_524',
              description: 'schema cache regression 524',
              inputSchema: { type: 'object' as const, properties: {} },
            },
          ],
        ],
      ])

    await buildServerToolTokenBudgets(buildCatalog(), estimate)
    await buildServerToolTokenBudgets(buildCatalog(), estimate)

    expect(estimate).toHaveBeenCalledTimes(1)
  })

  it('uses the server disclosure policy for every current and future tool', () => {
    const assistant = {
      toolPreferences: {},
      toolServerPreferences: {
        remote: { disclosureMode: 'on_demand' as const },
      },
    }

    expect(getAssistantToolDisclosureMode(assistant, 'remote__existing')).toBe(
      'on_demand',
    )
    expect(getAssistantToolDisclosureMode(assistant, 'remote__new_tool')).toBe(
      'on_demand',
    )
  })

  describe('getDefaultEnabledForTool', () => {
    it('returns true for user-facing built-in tools not in the deny-list', () => {
      expect(getDefaultEnabledForTool('yolo_local__fs_write')).toBe(true)
      expect(getDefaultEnabledForTool('yolo_local__fs_edit')).toBe(true)
    })

    it('returns false for the protocol-only schema loader', () => {
      // load_tool_schemas is no longer user-configurable; it's injected by
      // the runtime when on-demand disclosure is active. Treat it as never
      // a default for per-agent preferences.
      expect(getDefaultEnabledForTool('yolo_local__load_tool_schemas')).toBe(
        false,
      )
    })

    it('returns false for built-in tools in the deny-list', () => {
      expect(
        getDefaultEnabledForTool('yolo_local__context_prune_tool_results'),
      ).toBe(false)
      expect(getDefaultEnabledForTool('yolo_local__context_compact')).toBe(
        false,
      )
      expect(getDefaultEnabledForTool('yolo_local__delegate_subagent')).toBe(
        false,
      )
      expect(getDefaultEnabledForTool('yolo_local__js_eval')).toBe(false)
    })

    it('returns false for third-party MCP tools', () => {
      expect(getDefaultEnabledForTool('Gemini__get_all_tabs')).toBe(false)
      expect(getDefaultEnabledForTool('some_server__some_tool')).toBe(false)
    })

    it('returns false for malformed tool names', () => {
      expect(getDefaultEnabledForTool('not_a_qualified_name')).toBe(false)
    })

    it('returns false for unknown short names on the local server', () => {
      // Finding 2: server-only check used to default-enable arbitrary
      // `yolo_local__*` strings; tighten by also requiring the short name to
      // exist in LOCAL_FILE_TOOL_SHORT_NAMES.
      expect(getDefaultEnabledForTool('yolo_local__unknown_tool')).toBe(false)
      expect(getDefaultEnabledForTool('yolo_local__fs_write_legacy')).toBe(
        false,
      )
    })

    // D7 (phase2-migration.md D7 item 5): `defaultEnabled` used to be read
    // off a hand-maintained deny-list (`BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_
    // NAMES`) that had to be kept in sync with each capability's own
    // `defaultEnabled` by inspection. This pins every user-facing tool's
    // result against its owning capability's `defaultEnabled` directly, so a
    // future capability whose `defaultEnabled` disagrees with its tools'
    // `getDefaultEnabledForTool` result fails loudly here instead of via
    // silent drift.
    it("agrees with every registered capability's own defaultEnabled, for every user-facing tool", () => {
      for (const shortName of USER_FACING_LOCAL_TOOL_SHORT_NAMES) {
        const capability = getCapabilityForTool(shortName)
        expect(capability).toBeDefined()
        expect(getDefaultEnabledForTool(`yolo_local__${shortName}`)).toBe(
          capability?.defaultEnabled,
        )
      }
    })

    it('the five capabilities that default off match master.md §3.1', () => {
      const disabledCapabilityIds = listCapabilities()
        .filter((capability) => !capability.defaultEnabled)
        .map((capability) => capability.id)
        .sort()
      expect(disabledCapabilityIds).toEqual(
        [
          'context_compaction',
          'context_pruning',
          'js_sandbox',
          'subagent_delegation',
          'terminal',
        ].sort(),
      )
    })
  })

  describe('BUILTIN_DEFAULT_ENABLED_TOOL_FQNS', () => {
    it('includes exactly the tools of default-enabled capabilities', () => {
      const expected = new Set(
        listCapabilities()
          .filter((capability) => capability.defaultEnabled)
          .flatMap((capability) =>
            capability.tools.map((tool) => `yolo_local__${tool.name}`),
          ),
      )
      expect(new Set(BUILTIN_DEFAULT_ENABLED_TOOL_FQNS)).toEqual(expected)
    })

    it('excludes the five default-off tools and includes fs_edit/fs_write', () => {
      expect(BUILTIN_DEFAULT_ENABLED_TOOL_FQNS).not.toContain(
        'yolo_local__context_prune_tool_results',
      )
      expect(BUILTIN_DEFAULT_ENABLED_TOOL_FQNS).not.toContain(
        'yolo_local__context_compact',
      )
      expect(BUILTIN_DEFAULT_ENABLED_TOOL_FQNS).not.toContain(
        'yolo_local__delegate_subagent',
      )
      expect(BUILTIN_DEFAULT_ENABLED_TOOL_FQNS).not.toContain(
        'yolo_local__js_eval',
      )
      expect(BUILTIN_DEFAULT_ENABLED_TOOL_FQNS).not.toContain(
        'yolo_local__terminal_command',
      )
      expect(BUILTIN_DEFAULT_ENABLED_TOOL_FQNS).toContain('yolo_local__fs_edit')
      expect(BUILTIN_DEFAULT_ENABLED_TOOL_FQNS).toContain(
        'yolo_local__fs_write',
      )
    })
  })

  // D7 (phase2-migration.md D7 items 5-7): pins every case the task's
  // acceptance table calls out, now that `getDefaultApprovalModeForTool`
  // reads `approval.defaultMode` off the owning capability instead of the
  // three retired side tables (`FULL_ACCESS_LOCAL_TOOLS`,
  // `REQUIRE_APPROVAL_LOCAL_TOOLS`, and the bash-specific `if`).
  describe('getDefaultApprovalModeForTool', () => {
    it('fs_edit: NEW value require_approval (master.md decision 17 — the one deliberate behavior change)', () => {
      expect(getDefaultApprovalModeForTool('yolo_local__fs_edit')).toBe(
        'require_approval',
      )
    })

    it('fs_write / terminal_command / the fs_edit_ops group name: require_approval, unchanged from before', () => {
      expect(getDefaultApprovalModeForTool('yolo_local__fs_write')).toBe(
        'require_approval',
      )
      expect(
        getDefaultApprovalModeForTool('yolo_local__terminal_command'),
      ).toBe('require_approval')
    })

    it('bash: dangerous_only, derived from vault_shell (no more BASH_TOOL_NAME special case)', () => {
      expect(getDefaultApprovalModeForTool('yolo_local__bash')).toBe(
        'dangerous_only',
      )
    })

    it('load_tool_schemas: full_access (protocol-internal tool, not a CAPABILITIES member)', () => {
      expect(
        getDefaultApprovalModeForTool('yolo_local__load_tool_schemas'),
      ).toBe('full_access')
    })

    it('the rest default to full_access', () => {
      expect(getDefaultApprovalModeForTool('yolo_local__fs_read')).toBe(
        'full_access',
      )
      expect(getDefaultApprovalModeForTool('yolo_local__memory_add')).toBe(
        'full_access',
      )
      expect(getDefaultApprovalModeForTool('yolo_local__todo_write')).toBe(
        'full_access',
      )
      expect(
        getDefaultApprovalModeForTool('yolo_local__ask_user_question'),
      ).toBe('full_access')
      expect(getDefaultApprovalModeForTool('yolo_local__web_search')).toBe(
        'full_access',
      )
      expect(getDefaultApprovalModeForTool('yolo_local__web_scrape')).toBe(
        'full_access',
      )
      expect(getDefaultApprovalModeForTool(JS_SANDBOX_FQN)).toBe('full_access')
      expect(
        getDefaultApprovalModeForTool('yolo_local__delegate_subagent'),
      ).toBe('full_access')
    })

    it('an unknown local tool short name (e.g. a retired name like fs_list) falls back to full_access, matching the pre-refactor fallthrough', () => {
      expect(getDefaultApprovalModeForTool('yolo_local__fs_list')).toBe(
        'full_access',
      )
      expect(getDefaultApprovalModeForTool('yolo_local__fs_search')).toBe(
        'full_access',
      )
    })

    it('the legacy fs_edit_ops group-name FQN also falls back to full_access — it is not a registered tool name and no live call site ever passes it (see D7b report)', () => {
      expect(getDefaultApprovalModeForTool('yolo_local__fs_edit_ops')).toBe(
        'full_access',
      )
    })

    it('a non-local server tool always requires approval', () => {
      expect(getDefaultApprovalModeForTool('some_server__some_tool')).toBe(
        'require_approval',
      )
    })

    it('a malformed tool name falls back to the module default (require_approval)', () => {
      expect(getDefaultApprovalModeForTool('not_a_qualified_name')).toBe(
        'require_approval',
      )
    })

    it("agrees with every registered capability's own approval.defaultMode, for every one of its tools", () => {
      for (const capability of listCapabilities()) {
        for (const tool of capability.tools) {
          expect(
            getDefaultApprovalModeForTool(`yolo_local__${tool.name}`),
          ).toBe(capability.approval.defaultMode)
        }
      }
    })
  })

  // D7 (phase2-migration.md D7 item 7): `allowAlwaysAllow` used to be a
  // hand-maintained two-item list (`ALWAYS_ALLOW_DISABLED_TOOL_NAMES`,
  // consumed only by `ToolMessage.tsx`'s `isAlwaysAllowDisabled`). Pinned
  // here at the data level, since that's a rendering hook rather than an
  // exported function.
  describe('capability approval.allowAlwaysAllow (consumed by ToolMessage.tsx)', () => {
    it('only vault_shell and terminal disable always-allow', () => {
      const disallowed = listCapabilities()
        .filter((capability) => !capability.approval.allowAlwaysAllow)
        .map((capability) => capability.id)
        .sort()
      expect(disallowed).toEqual(['terminal', 'vault_shell'].sort())
    })

    it('every other capability allows always-allow', () => {
      const allowed = listCapabilities()
        .filter((capability) => capability.approval.allowAlwaysAllow)
        .map((capability) => capability.id)
        .sort()
      expect(allowed).toEqual(
        [
          'file_reading',
          'file_editing',
          'memory',
          'context_compaction',
          'context_pruning',
          'todo_list',
          'user_questions',
          'web_access',
          'js_sandbox',
          'subagent_delegation',
        ].sort(),
      )
    })
  })

  // D9 (docs/plans/2026-08-15-tool-registry/phase2-migration.md D9): a
  // built-in tool's FQN resolves through its owning capability's
  // `builtinCapabilityPreferences` entry now, not `toolPreferences` —
  // `toolPreferences` is exclusively remote-MCP-tool territory as of the
  // `80_to_81` migration. Remote-tool behavior (unaffected by D9) is
  // unchanged from before.
  describe('isAssistantToolEnabled', () => {
    it('a built-in tool with no explicit builtinCapabilityPreferences entry falls back to its capability default', () => {
      // file_editing defaults enabled; context_compaction defaults disabled
      // (master.md §3.1) — no fill-in happens in toolPreferences for either,
      // since built-ins never read it at all post-D9.
      const assistant = {
        toolPreferences: {},
        enabledToolNames: [],
        builtinCapabilityPreferences: {},
      }
      expect(isAssistantToolEnabled(assistant, 'yolo_local__fs_write')).toBe(
        true,
      )
      expect(
        isAssistantToolEnabled(assistant, 'yolo_local__context_compact'),
      ).toBe(false)
    })

    it('a remote MCP tool with no toolPreferences entry is treated as disabled (no fill-in)', () => {
      const assistant = { toolPreferences: {}, enabledToolNames: [] }
      expect(isAssistantToolEnabled(assistant, 'Gemini__get_all_tabs')).toBe(
        false,
      )
    })

    it('explicit builtinCapabilityPreferences are honored for built-in tools', () => {
      expect(
        isAssistantToolEnabled(
          {
            builtinCapabilityPreferences: {
              file_editing: { enabled: false },
            },
          },
          'yolo_local__fs_write',
        ),
      ).toBe(false)
      expect(
        isAssistantToolEnabled(
          {
            builtinCapabilityPreferences: {
              context_compaction: { enabled: true },
            },
          },
          'yolo_local__context_compact',
        ),
      ).toBe(true)
    })

    it('explicit toolPreferences are honored for remote MCP tools', () => {
      expect(
        isAssistantToolEnabled(
          {
            toolPreferences: {
              Gemini__get_all_tabs: { enabled: true },
            },
            enabledToolNames: [],
          },
          'Gemini__get_all_tabs',
        ),
      ).toBe(true)
    })

    it('legacy enabledToolNames is promoted to enabled via preferences merge', () => {
      const assistant = {
        toolPreferences: {},
        enabledToolNames: ['Gemini__get_all_tabs'],
      }
      expect(isAssistantToolEnabled(assistant, 'Gemini__get_all_tabs')).toBe(
        true,
      )
    })

    it('a null / undefined assistant resolves built-in tools to their capability default, and remote tools to disabled', () => {
      // No assistant is the same input shape as a freshly-created one with
      // an empty builtinCapabilityPreferences map — both fall back to the
      // registry's own defaults, matching `buildDefaultBuiltinCapabilityPreferences`.
      expect(isAssistantToolEnabled(null, 'yolo_local__fs_write')).toBe(true)
      expect(isAssistantToolEnabled(undefined, 'yolo_local__fs_write')).toBe(
        true,
      )
      expect(isAssistantToolEnabled(null, 'yolo_local__context_compact')).toBe(
        false,
      )
      expect(isAssistantToolEnabled(null, 'Gemini__get_all_tabs')).toBe(false)
    })
  })

  describe('getEnabledAssistantToolNames', () => {
    it('returns only remote MCP tools with explicit enabled:true from toolPreferences (no fill-in there)', () => {
      const result = getEnabledAssistantToolNames({
        toolPreferences: {
          Gemini__get_all_tabs: { enabled: true },
          Gemini__close_tab: { enabled: false },
        },
        enabledToolNames: [],
        builtinCapabilityPreferences: Object.fromEntries(
          listCapabilities().map((c) => [c.id, { enabled: false }]),
        ),
      })
      expect(result).toEqual(['Gemini__get_all_tabs'])
    })

    it('expands every default-enabled capability into its member FQNs for a fresh assistant with no preferences', () => {
      // Built-ins fall back to the capability's own defaultEnabled when
      // builtinCapabilityPreferences is empty — unlike remote MCP tools,
      // which still require an explicit toolPreferences entry.
      const result = new Set(
        getEnabledAssistantToolNames({
          toolPreferences: {},
          enabledToolNames: [],
        }),
      )
      const defaultEnabledFqns = new Set(
        listCapabilities()
          .filter((c) => c.defaultEnabled)
          .flatMap((c) => c.tools.map((tool) => `yolo_local__${tool.name}`)),
      )
      expect(result).toEqual(defaultEnabledFqns)
    })

    it('legacy enabledToolNames is promoted via the preferences merge', () => {
      const result = getEnabledAssistantToolNames({
        toolPreferences: {},
        enabledToolNames: ['Gemini__get_all_tabs'],
        builtinCapabilityPreferences: Object.fromEntries(
          listCapabilities().map((c) => [c.id, { enabled: false }]),
        ),
      })
      expect(result).toContain('Gemini__get_all_tabs')
    })

    it('excludes built-in tools when includeBuiltinTools is false', () => {
      const result = getEnabledAssistantToolNames({
        toolPreferences: {
          Gemini__get_all_tabs: { enabled: true },
        },
        enabledToolNames: [],
        includeBuiltinTools: false,
      })
      expect(result).not.toContain('yolo_local__fs_write')
      expect(result).toContain('Gemini__get_all_tabs')
    })
  })

  describe('getAssistantToolApprovalMode (js_eval)', () => {
    // D9 (docs/plans/2026-08-15-tool-registry/phase2-migration.md D9): a
    // built-in tool's approval mode is now read from its owning capability's
    // `builtinCapabilityPreferences` entry, not from a `toolPreferences[fqn]`
    // entry — `toolPreferences` no longer carries built-in tool state at all.
    it.each(['full_access', 'require_approval'] as const)(
      'honors the saved %s mode',
      (approvalMode) => {
        expect(
          getAssistantToolApprovalMode(
            {
              toolPreferences: {},
              enabledToolNames: [],
              builtinCapabilityPreferences: {
                js_sandbox: { enabled: true, approvalMode },
              },
            },
            JS_SANDBOX_FQN,
          ),
        ).toBe(approvalMode)
      },
    )
  })

  describe('getAssistantToolApprovalMode defaults', () => {
    it('allows subagent delegation to use the default full-access approval mode', () => {
      expect(
        getAssistantToolApprovalMode(
          {
            builtinCapabilityPreferences: {
              subagent_delegation: { enabled: true },
            },
          },
          'yolo_local__delegate_subagent',
        ),
      ).toBe('full_access')
    })

    it('honors an explicit builtinCapabilityPreferences approvalMode for a built-in tool', () => {
      expect(
        getAssistantToolApprovalMode(
          {
            builtinCapabilityPreferences: {
              file_editing: {
                enabled: true,
                approvalMode: 'full_access',
              },
            },
          },
          'yolo_local__fs_edit',
        ),
      ).toBe('full_access')
      expect(
        getAssistantToolApprovalMode(
          {
            builtinCapabilityPreferences: {
              file_editing: {
                enabled: true,
                approvalMode: 'full_access',
              },
            },
          },
          'yolo_local__fs_write',
        ),
      ).toBe('full_access')
    })

    it('uses server-level approval for third-party MCP tools', () => {
      expect(
        getAssistantToolApprovalMode(
          {
            toolPreferences: {
              server__tool_a: {
                enabled: true,
                approvalMode: 'require_approval',
              },
            },
            toolServerPreferences: {
              server: { approvalMode: 'full_access' },
            },
            enabledToolNames: [],
          },
          'server__tool_a',
        ),
      ).toBe('full_access')
    })

    it('defaults third-party MCP tools to approval when no server setting exists', () => {
      expect(
        getAssistantToolApprovalMode(
          {
            toolPreferences: {
              server__tool_a: {
                enabled: true,
                approvalMode: 'full_access',
              },
            },
            enabledToolNames: [],
          },
          'server__tool_a',
        ),
      ).toBe('require_approval')
    })
  })

  describe('getExplicitlyEnabledAssistantToolNames', () => {
    it('returns only explicit-on preferences, never defaults', () => {
      const result = getExplicitlyEnabledAssistantToolNames({
        toolPreferences: {
          Gemini__get_all_tabs: { enabled: true },
          Gemini__close_tab: { enabled: false },
        },
        enabledToolNames: [],
      })
      expect(result).toEqual(['Gemini__get_all_tabs'])
    })

    it('returns empty for a fresh assistant with no preferences', () => {
      expect(
        getExplicitlyEnabledAssistantToolNames({
          toolPreferences: {},
          enabledToolNames: [],
        }),
      ).toEqual([])
    })

    it('promotes legacy enabledToolNames into the explicit set', () => {
      const result = getExplicitlyEnabledAssistantToolNames({
        toolPreferences: {},
        enabledToolNames: ['yolo_local__fs_write', 'Gemini__get_all_tabs'],
      })
      expect(result).toContain('yolo_local__fs_write')
      expect(result).toContain('Gemini__get_all_tabs')
    })
  })

  describe('pruneOrphanedAssistantToolPreferences', () => {
    it('drops keys whose server is not in the known set', () => {
      const result = pruneOrphanedAssistantToolPreferences(
        {
          toolPreferences: {
            yolo_local__fs_write: {
              enabled: true,
              approvalMode: 'full_access' as const,
            },
            Gemini__click: {
              enabled: true,
              approvalMode: 'require_approval' as const,
            },
            github__list: {
              enabled: true,
              approvalMode: 'require_approval' as const,
            },
          },
          enabledToolNames: [
            'yolo_local__fs_write',
            'Gemini__click',
            'github__list',
          ],
          toolServerPreferences: {
            Gemini: { approvalMode: 'full_access' as const },
            github: { approvalMode: 'require_approval' as const },
          },
        },
        new Set(['yolo_local', 'github']),
      )
      expect(Object.keys(result.toolPreferences ?? {})).toEqual([
        'yolo_local__fs_write',
        'github__list',
      ])
      expect(result.enabledToolNames).toEqual([
        'yolo_local__fs_write',
        'github__list',
      ])
      expect(result.toolServerPreferences).toEqual({
        github: { approvalMode: 'require_approval' as const },
      })
    })

    it('returns the same reference when nothing changes', () => {
      const input = {
        toolPreferences: {
          yolo_local__fs_write: {
            enabled: true,
            approvalMode: 'full_access' as const,
          },
        },
        enabledToolNames: ['yolo_local__fs_write'],
      }
      expect(
        pruneOrphanedAssistantToolPreferences(input, new Set(['yolo_local'])),
      ).toBe(input)
    })
  })

  describe('renameAssistantToolPreferencesServer', () => {
    it('rewrites prefixes in both toolPreferences and enabledToolNames', () => {
      const result = renameAssistantToolPreferencesServer(
        {
          toolPreferences: {
            old__a: { enabled: true, approvalMode: 'full_access' as const },
            old__b: {
              enabled: false,
              approvalMode: 'require_approval' as const,
            },
            yolo_local__fs_write: {
              enabled: true,
              approvalMode: 'full_access',
            },
          },
          enabledToolNames: ['old__a', 'yolo_local__fs_write'],
          toolServerPreferences: {
            old: { approvalMode: 'full_access' as const },
          },
        },
        'old',
        'new',
      )
      expect(result.toolPreferences).toEqual({
        new__a: { enabled: true, approvalMode: 'full_access' as const },
        new__b: { enabled: false, approvalMode: 'require_approval' as const },
        yolo_local__fs_write: {
          enabled: true,
          approvalMode: 'full_access' as const,
        },
      })
      expect(result.enabledToolNames).toEqual([
        'new__a',
        'yolo_local__fs_write',
      ])
      expect(result.toolServerPreferences).toEqual({
        new: { approvalMode: 'full_access' as const },
      })
    })

    it('dedupes enabledToolNames when the rename collides with an existing entry', () => {
      const result = renameAssistantToolPreferencesServer(
        {
          toolPreferences: {
            old__a: { enabled: true, approvalMode: 'full_access' as const },
            new__a: { enabled: false, approvalMode: 'full_access' as const },
          },
          enabledToolNames: ['old__a', 'new__a'],
        },
        'old',
        'new',
      )
      expect(result.enabledToolNames).toEqual(['new__a'])
    })

    it('returns the same reference when oldName === newName', () => {
      const input = {
        toolPreferences: {
          x__t: { enabled: true, approvalMode: 'full_access' as const },
        },
        enabledToolNames: ['x__t'],
      }
      expect(renameAssistantToolPreferencesServer(input, 'x', 'x')).toBe(input)
    })
  })
})
