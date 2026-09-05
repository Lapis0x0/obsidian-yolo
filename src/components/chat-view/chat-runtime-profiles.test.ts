import type { RegisteredModuleChatModeV1 } from '../../core/modules/moduleChatModeRegistry'

import { resolveChatModeRuntime } from './chat-runtime-profiles'

function moduleChatMode(
  overrides: Partial<RegisteredModuleChatModeV1['mode']> = {},
): RegisteredModuleChatModeV1 {
  return {
    fullModeId: 'module:learning:chat',
    moduleId: 'learning',
    serverName: 'module-mode-learning-chat',
    availability: { status: 'available' },
    mode: {
      id: 'chat',
      label: { en: 'Learning' },
      personaPrompt: 'You are the learning course assistant.',
      capability: 'vault-read',
      tools: [
        {
          name: 'start_course_generation',
          description: 'Start generating a course.',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ ok: true }),
          requiresApproval: true,
        },
        {
          name: 'get_generation_status',
          description: 'Get generation status.',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ ok: true }),
        },
      ],
      ...overrides,
    } as RegisteredModuleChatModeV1['mode'],
  }
}

describe('resolveChatModeRuntime module chat mode branch', () => {
  const assistant = {
    enableTools: false,
    includeBuiltinTools: false,
    toolPreferences: {
      yolo_local__fs_write: {
        enabled: true,
        approvalMode: 'require_approval' as const,
      },
    },
    toolServerPreferences: {
      playwright: { approvalMode: 'full_access' as const },
    },
  }

  it('grants the capability tier host tools + all mode tool names, ignoring the assistant enable/tool-preference toggles entirely', () => {
    const registered = moduleChatMode()
    const runtime = resolveChatModeRuntime({
      mode: 'module:learning:chat',
      assistant,
      assistantEnabledToolNames: [], // assistant has enableTools: false — irrelevant here
      moduleChatMode: registered,
    })

    expect(runtime.loopConfig).toEqual({
      enableTools: true,
      includeBuiltinTools: true,
      maxAutoIterations: 100,
    })
    expect(runtime.allowedToolNames).toEqual(
      expect.arrayContaining([
        'yolo_local__bash',
        'module-mode-learning-chat__start_course_generation',
        'module-mode-learning-chat__get_generation_status',
      ]),
    )
    // vault-read must not also grant the write tool.
    expect(runtime.allowedToolNames).not.toContain('yolo_local__fs_edit')
    expect(runtime.toolPreferences).toBeUndefined()
    expect(runtime.toolServerPreferences).toBeUndefined()
  })

  it('sets bashReadOnly from the capability profile (vault-read → true)', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'module:learning:chat',
      assistantEnabledToolNames: [],
      moduleChatMode: moduleChatMode(),
    })
    expect(runtime.bashReadOnly).toBe(true)
  })

  it('sets bashReadOnly to false for vault-write capability', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'module:learning:chat',
      assistantEnabledToolNames: [],
      moduleChatMode: moduleChatMode({ capability: 'vault-write' }),
    })
    expect(runtime.bashReadOnly).toBe(false)
    expect(runtime.allowedToolNames).toEqual(
      expect.arrayContaining(['yolo_local__bash', 'yolo_local__fs_edit']),
    )
  })

  it('never bypasses tool approval, even with yoloEnabled true', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'module:learning:chat',
      yoloEnabled: true,
      assistantEnabledToolNames: [],
      moduleChatMode: moduleChatMode(),
    })
    expect(runtime.bypassToolApproval).toBe(false)
  })

  it("maps capability 'none' to toolCapabilityMode 'ask', others to 'agent'", () => {
    expect(
      resolveChatModeRuntime({
        mode: 'module:learning:chat',
        assistantEnabledToolNames: [],
        moduleChatMode: moduleChatMode({ capability: 'none' }),
      }).toolCapabilityMode,
    ).toBe('ask')
    expect(
      resolveChatModeRuntime({
        mode: 'module:learning:chat',
        assistantEnabledToolNames: [],
        moduleChatMode: moduleChatMode({ capability: 'vault-read' }),
      }).toolCapabilityMode,
    ).toBe('agent')
  })

  it('carries the persona prompt, owning module id, and useAssistant: false', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'module:learning:chat',
      assistantEnabledToolNames: [],
      moduleChatMode: moduleChatMode(),
    })
    expect(runtime.modePersonaPrompt).toBe(
      'You are the learning course assistant.',
    )
    expect(runtime.modePersonaModuleId).toBe('learning')
    expect(runtime.moduleChatModeId).toBe('module:learning:chat')
    expect(runtime.contextPolicy).toEqual({ useAssistant: false })
  })

  it("builds moduleToolApprovalPolicies keyed by full tool name from each tool's requiresApproval", () => {
    const runtime = resolveChatModeRuntime({
      mode: 'module:learning:chat',
      assistantEnabledToolNames: [],
      moduleChatMode: moduleChatMode(),
    })
    expect(runtime.moduleToolApprovalPolicies).toEqual(
      new Map([
        ['module-mode-learning-chat__start_course_generation', true],
        ['module-mode-learning-chat__get_generation_status', false],
      ]),
    )
  })

  it('builds an empty moduleToolApprovalPolicies map when the mode declares no tools', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'module:learning:chat',
      assistantEnabledToolNames: [],
      moduleChatMode: moduleChatMode({ tools: undefined }),
    })
    expect(runtime.moduleToolApprovalPolicies).toEqual(new Map())
  })

  it('falls back to the built-in branch when moduleChatMode is missing (defensive)', () => {
    // Callers are expected to resolve the effective mode before calling —
    // this only guards against a mismatched/missing lookup rather than
    // throwing.
    const runtime = resolveChatModeRuntime({
      mode: 'module:learning:chat',
      assistant,
      assistantEnabledToolNames: ['yolo_local__fs_read'],
    })
    expect(runtime.bashReadOnly).toBe(false)
    expect(runtime.contextPolicy).toEqual({ useAssistant: true })
    expect(runtime.moduleToolApprovalPolicies).toBeUndefined()
  })
})

describe('resolveChatModeRuntime', () => {
  const assistantEnabledToolNames = [
    'yolo_local__fs_read',
    'yolo_local__fs_write',
    'yolo_local__terminal_command',
  ]

  const assistant = {
    enableTools: true,
    includeBuiltinTools: true,
    toolPreferences: {
      yolo_local__fs_write: {
        enabled: true,
        approvalMode: 'require_approval' as const,
      },
    },
    toolServerPreferences: {
      playwright: { approvalMode: 'full_access' as const },
    },
  }

  it('filters write tools in ask mode and disables bypass', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'ask',
      assistant,
      assistantEnabledToolNames,
    })

    expect(runtime.allowedToolNames).toEqual(['yolo_local__fs_read'])
    expect(runtime.toolPreferences).toBeUndefined()
    expect(runtime.toolServerPreferences).toBeUndefined()
    expect(runtime.bypassToolApproval).toBe(false)
    expect(runtime.toolCapabilityMode).toBe('ask')
  })

  it('keeps full tool set in agent mode with per-tool preferences', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'agent',
      assistant,
      assistantEnabledToolNames,
    })

    expect(runtime.allowedToolNames).toEqual(assistantEnabledToolNames)
    expect(runtime.toolPreferences).toEqual(assistant.toolPreferences)
    expect(runtime.toolServerPreferences).toEqual(
      assistant.toolServerPreferences,
    )
    expect(runtime.bypassToolApproval).toBe(false)
    expect(runtime.toolCapabilityMode).toBe('agent')
  })

  it('enables bypass only when agent mode and YOLO are combined', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'agent',
      yoloEnabled: true,
      assistant,
      assistantEnabledToolNames,
    })

    expect(runtime.allowedToolNames).toEqual(assistantEnabledToolNames)
    expect(runtime.toolPreferences).toEqual(assistant.toolPreferences)
    expect(runtime.toolServerPreferences).toEqual(
      assistant.toolServerPreferences,
    )
    expect(runtime.bypassToolApproval).toBe(true)
    expect(runtime.toolCapabilityMode).toBe('agent')
  })

  it('ignores YOLO outside agent mode', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'ask',
      yoloEnabled: true,
      assistant,
      assistantEnabledToolNames,
    })

    expect(runtime.bypassToolApproval).toBe(false)
  })

  // Per-mode visibility comes entirely from each capability's own
  // `chatModes` (master.md §6); the table itself is locked by
  // `core/tools/registry.test.ts`. These cases pin the *behavior* that
  // derivation has to produce at this layer.
  it('withholds every write/plan capability from ask mode', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'ask',
      assistant,
      assistantEnabledToolNames: [
        'yolo_local__fs_read',
        'yolo_local__fs_edit',
        'yolo_local__fs_write',
        'yolo_local__terminal_command',
        'yolo_local__todo_write',
        // bash stays: vault_shell declares 'ask'.
        'yolo_local__bash',
      ],
    })

    expect(runtime.allowedToolNames).toEqual([
      'yolo_local__fs_read',
      'yolo_local__bash',
    ])
  })

  it('leaves tools it does not own alone (MCP servers, module tool sets)', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'ask',
      assistant,
      assistantEnabledToolNames: [
        'playwright__browser_click',
        'yolo_whiteboard__create_board',
        'yolo_local__fs_write',
      ],
    })

    expect(runtime.allowedToolNames).toEqual([
      'playwright__browser_click',
      'yolo_whiteboard__create_board',
    ])
  })

  it('blocks todo_write in ask mode, same as the other blocked tools', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'ask',
      assistant,
      assistantEnabledToolNames: [
        'yolo_local__fs_read',
        'yolo_local__todo_write',
      ],
    })

    expect(runtime.allowedToolNames).toEqual(['yolo_local__fs_read'])
  })

  it('allows todo_write in agent mode', () => {
    const runtime = resolveChatModeRuntime({
      mode: 'agent',
      assistant,
      assistantEnabledToolNames: [
        'yolo_local__fs_read',
        'yolo_local__todo_write',
      ],
    })

    expect(runtime.allowedToolNames).toEqual([
      'yolo_local__fs_read',
      'yolo_local__todo_write',
    ])
  })

  // YOLO Max S1/S1b (master.md §6, p1-design.md §2/§3): the `native_files`
  // tools are enabled by default at the capability level, so they land in
  // `assistantEnabledToolNames` for every assistant. The only thing keeping
  // them out of Ask and Agent is `native_files`'s `chatModes: ['max']`.
  describe('native_files (chatModes: max)', () => {
    const withNativeFiles = [
      'yolo_local__fs_read',
      'yolo_local__read_file',
      'yolo_local__write_file',
      'yolo_local__edit_file',
    ]

    it('hides the native tools in agent mode, unlike the ask-only exclusions', () => {
      const runtime = resolveChatModeRuntime({
        mode: 'agent',
        assistant,
        assistantEnabledToolNames: withNativeFiles,
      })

      expect(runtime.allowedToolNames).toEqual(['yolo_local__fs_read'])
    })

    it('hides the native tools in ask mode too', () => {
      const runtime = resolveChatModeRuntime({
        mode: 'ask',
        assistant,
        assistantEnabledToolNames: withNativeFiles,
      })

      expect(runtime.allowedToolNames).toEqual(['yolo_local__fs_read'])
    })

    it('still hides them when YOLO is on in agent mode', () => {
      const runtime = resolveChatModeRuntime({
        mode: 'agent',
        yoloEnabled: true,
        assistant,
        assistantEnabledToolNames: withNativeFiles,
      })

      expect(runtime.allowedToolNames).toEqual(['yolo_local__fs_read'])
      expect(runtime.bypassToolApproval).toBe(true)
    })
  })
})
