import {
  getAssistantToolApprovalMode,
  getDefaultEnabledForTool,
  getEnabledAssistantToolNames,
  getExplicitlyEnabledAssistantToolNames,
  isAssistantToolEnabled,
  pruneOrphanedAssistantToolPreferences,
  renameAssistantToolPreferencesServer,
} from './tool-preferences'

const JS_SANDBOX_FQN = 'yolo_local__js_eval'

describe('tool-preferences defaults', () => {
  describe('getDefaultEnabledForTool', () => {
    it('returns true for user-facing built-in tools not in the deny-list', () => {
      expect(getDefaultEnabledForTool('yolo_local__fs_read')).toBe(true)
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
  })

  describe('isAssistantToolEnabled', () => {
    it('treats missing entries as disabled (single source of truth)', () => {
      // toolPreferences is now the only signal — the v60→v61 migration is
      // responsible for materializing every default-on built-in into the
      // map, so reads do not silently fill in.
      const assistant = { toolPreferences: {}, enabledToolNames: [] }
      expect(isAssistantToolEnabled(assistant, 'yolo_local__fs_read')).toBe(
        false,
      )
      expect(
        isAssistantToolEnabled(assistant, 'yolo_local__context_compact'),
      ).toBe(false)
      expect(isAssistantToolEnabled(assistant, 'Gemini__get_all_tabs')).toBe(
        false,
      )
    })

    it('explicit preferences are honored', () => {
      expect(
        isAssistantToolEnabled(
          {
            toolPreferences: {
              yolo_local__fs_read: { enabled: false },
            },
            enabledToolNames: [],
          },
          'yolo_local__fs_read',
        ),
      ).toBe(false)
      expect(
        isAssistantToolEnabled(
          {
            toolPreferences: {
              yolo_local__context_compact: { enabled: true },
            },
            enabledToolNames: [],
          },
          'yolo_local__context_compact',
        ),
      ).toBe(true)
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

    it('handles null / undefined assistant as disabled', () => {
      expect(isAssistantToolEnabled(null, 'yolo_local__fs_read')).toBe(false)
      expect(isAssistantToolEnabled(undefined, 'yolo_local__fs_read')).toBe(
        false,
      )
    })
  })

  describe('getEnabledAssistantToolNames', () => {
    it('returns only tools with explicit enabled:true (no fill-in)', () => {
      const result = getEnabledAssistantToolNames({
        toolPreferences: {
          yolo_local__fs_read: { enabled: true },
          yolo_local__fs_edit: { enabled: false },
        },
        enabledToolNames: [],
      })
      expect(result).toEqual(['yolo_local__fs_read'])
    })

    it('returns empty for a fresh assistant with no preferences', () => {
      // The migration is responsible for seeding entries; reads do not
      // invent enablement.
      expect(
        getEnabledAssistantToolNames({
          toolPreferences: {},
          enabledToolNames: [],
        }),
      ).toEqual([])
    })

    it('legacy enabledToolNames is promoted via the preferences merge', () => {
      const result = getEnabledAssistantToolNames({
        toolPreferences: {},
        enabledToolNames: ['Gemini__get_all_tabs'],
      })
      expect(result).toContain('Gemini__get_all_tabs')
    })

    it('excludes built-in tools when includeBuiltinTools is false', () => {
      const result = getEnabledAssistantToolNames({
        toolPreferences: {
          yolo_local__fs_read: { enabled: true },
          Gemini__get_all_tabs: { enabled: true },
        },
        enabledToolNames: [],
        includeBuiltinTools: false,
      })
      expect(result).not.toContain('yolo_local__fs_read')
      expect(result).toContain('Gemini__get_all_tabs')
    })
  })

  describe('getAssistantToolApprovalMode (js_eval global cap override)', () => {
    const assistant = {
      toolPreferences: {
        [JS_SANDBOX_FQN]: {
          enabled: true,
          approvalMode: 'full_access' as const,
        },
      },
      enabledToolNames: [],
    }

    it('keeps the saved full_access mode when no extension capability is on', () => {
      expect(
        getAssistantToolApprovalMode(assistant, JS_SANDBOX_FQN, {
          jsSandboxSettings: {},
        }),
      ).toBe('full_access')
    })

    it('forces require_approval when any extension capability is on globally', () => {
      for (const cap of [
        'allowFetch',
        'allowVaultRead',
        'allowDbQuery',
        'allowExternalScripts',
      ] as const) {
        expect(
          getAssistantToolApprovalMode(assistant, JS_SANDBOX_FQN, {
            jsSandboxSettings: { [cap]: true },
          }),
        ).toBe('require_approval')
      }
    })

    it('does not override approval mode for other tools', () => {
      const withFsRead = {
        toolPreferences: {
          ...assistant.toolPreferences,
          yolo_local__fs_read: {
            enabled: true,
            approvalMode: 'full_access' as const,
          },
        },
        enabledToolNames: [],
      }
      expect(
        getAssistantToolApprovalMode(withFsRead, 'yolo_local__fs_read', {
          jsSandboxSettings: { allowFetch: true },
        }),
      ).toBe('full_access')
    })
  })

  describe('getAssistantToolApprovalMode defaults', () => {
    it('allows subagent delegation to use the default full-access approval mode', () => {
      expect(
        getAssistantToolApprovalMode(
          {
            toolPreferences: {
              yolo_local__delegate_subagent: { enabled: true },
            },
            enabledToolNames: [],
          },
          'yolo_local__delegate_subagent',
        ),
      ).toBe('full_access')
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
        enabledToolNames: ['yolo_local__fs_read', 'Gemini__get_all_tabs'],
      })
      expect(result).toContain('yolo_local__fs_read')
      expect(result).toContain('Gemini__get_all_tabs')
    })
  })

  describe('pruneOrphanedAssistantToolPreferences', () => {
    it('drops keys whose server is not in the known set', () => {
      const result = pruneOrphanedAssistantToolPreferences(
        {
          toolPreferences: {
            yolo_local__fs_read: {
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
            'yolo_local__fs_read',
            'Gemini__click',
            'github__list',
          ],
        },
        new Set(['yolo_local', 'github']),
      )
      expect(Object.keys(result.toolPreferences ?? {})).toEqual([
        'yolo_local__fs_read',
        'github__list',
      ])
      expect(result.enabledToolNames).toEqual([
        'yolo_local__fs_read',
        'github__list',
      ])
    })

    it('returns the same reference when nothing changes', () => {
      const input = {
        toolPreferences: {
          yolo_local__fs_read: {
            enabled: true,
            approvalMode: 'full_access' as const,
          },
        },
        enabledToolNames: ['yolo_local__fs_read'],
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
            yolo_local__fs_read: {
              enabled: true,
              approvalMode: 'full_access',
            },
          },
          enabledToolNames: ['old__a', 'yolo_local__fs_read'],
        },
        'old',
        'new',
      )
      expect(result.toolPreferences).toEqual({
        new__a: { enabled: true, approvalMode: 'full_access' as const },
        new__b: { enabled: false, approvalMode: 'require_approval' as const },
        yolo_local__fs_read: {
          enabled: true,
          approvalMode: 'full_access' as const,
        },
      })
      expect(result.enabledToolNames).toEqual(['new__a', 'yolo_local__fs_read'])
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
