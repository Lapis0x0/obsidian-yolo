import {
  assertNoDuplicates,
  getCapability,
  getCapabilityForTool,
  getToolDefinition,
  getToolNamesForChatMode,
  isBuiltinCapabilityId,
  isBuiltinToolName,
  listBuiltinToolNames,
  listBuiltinTools,
  listCapabilities,
} from './registry'
import type { BuiltinChatModeId } from './types'

describe('assertNoDuplicates', () => {
  it('does not throw for a list with no duplicates', () => {
    expect(() => assertNoDuplicates(['a', 'b', 'c'], 'thing')).not.toThrow()
  })

  it('does not throw for an empty list', () => {
    expect(() => assertNoDuplicates([], 'thing')).not.toThrow()
  })

  it('throws when a value repeats', () => {
    expect(() => assertNoDuplicates(['a', 'b', 'a'], 'thing')).toThrow(
      'Duplicate thing: "a"',
    )
  })

  it('is exercised at module load time for the real registry (capability ids and tool names)', () => {
    // The real CAPABILITIES array has no duplicates by construction, so this
    // just confirms importing the registry module didn't throw — the
    // dedicated throw-path coverage above is what actually exercises the
    // "found a duplicate" branch (see this file's doc comment in
    // registry.ts for why: a `Record` literal in a wiring table wouldn't
    // catch a duplicate on its own).
    expect(listCapabilities().length).toBeGreaterThan(0)
    expect(listBuiltinTools().length).toBeGreaterThan(0)
  })
})

describe('registry queries', () => {
  it('finds the memory capability by id', () => {
    const capability = getCapability('memory')
    expect(capability?.id).toBe('memory')
    expect(capability?.tools.map((tool) => tool.name)).toEqual([
      'memory_add',
      'memory_update',
      'memory_delete',
    ])
  })

  it('finds the subagent_delegation capability by id', () => {
    const capability = getCapability('subagent_delegation')
    expect(capability?.id).toBe('subagent_delegation')
    expect(capability?.tools.map((tool) => tool.name)).toEqual([
      'delegate_subagent',
    ])
  })

  it('returns undefined for an unknown capability id', () => {
    expect(getCapability('not_a_real_capability')).toBeUndefined()
  })

  it('finds each memory tool by name', () => {
    expect(getToolDefinition('memory_add')?.name).toBe('memory_add')
    expect(getToolDefinition('memory_update')?.name).toBe('memory_update')
    expect(getToolDefinition('memory_delete')?.name).toBe('memory_delete')
  })

  it('finds delegate_subagent by name', () => {
    expect(getToolDefinition('delegate_subagent')?.name).toBe(
      'delegate_subagent',
    )
  })

  it('returns undefined for an unknown tool name', () => {
    expect(getToolDefinition('not_a_real_tool')).toBeUndefined()
  })

  it('maps a tool name back to its owning capability', () => {
    expect(getCapabilityForTool('memory_delete')?.id).toBe('memory')
    expect(getCapabilityForTool('delegate_subagent')?.id).toBe(
      'subagent_delegation',
    )
    expect(getCapabilityForTool('not_a_real_tool')).toBeUndefined()
  })

  it('type-guards tool names and capability ids', () => {
    expect(isBuiltinToolName('memory_add')).toBe(true)
    expect(isBuiltinToolName('delegate_subagent')).toBe(true)
    expect(isBuiltinToolName('not_a_real_tool')).toBe(false)
    expect(isBuiltinCapabilityId('memory')).toBe(true)
    expect(isBuiltinCapabilityId('subagent_delegation')).toBe(true)
    expect(isBuiltinCapabilityId('not_a_real_capability')).toBe(false)
  })

  // `McpManager.callTool` gates its local-tool branch on
  // `isBuiltinToolName` (`core/mcp/mcpManager.ts`), so this guard returning
  // `true` is what actually makes a registered tool reachable at runtime.
  it('type-guards the D6 batch 1-3 tool names (context_prune_tool_results, context_compact, todo_write, ask_user_question, fs_read)', () => {
    expect(isBuiltinToolName('context_prune_tool_results')).toBe(true)
    expect(isBuiltinToolName('context_compact')).toBe(true)
    expect(isBuiltinToolName('todo_write')).toBe(true)
    expect(isBuiltinToolName('ask_user_question')).toBe(true)
    expect(isBuiltinToolName('fs_read')).toBe(true)
  })

  // D6 batch 4 (file_editing). Combined with
  // fs-edit-fs-write-equivalence.test.ts (which proves `executeBuiltinTool`
  // itself produces the same result as the old switch case for both
  // tools, including the approval path), this closes the same loop D6
  // batches 1-3 closed: registered -> reached -> correct.
  it('finds the file_editing capability by id, with its approval default flipped to require_approval (master.md decision 17)', () => {
    const capability = getCapability('file_editing')
    expect(capability?.id).toBe('file_editing')
    expect(capability?.tools.map((tool) => tool.name)).toEqual([
      'fs_edit',
      'fs_write',
    ])
    expect(capability?.approval.defaultMode).toBe('require_approval')
  })

  it('maps fs_edit and fs_write back to file_editing', () => {
    expect(getCapabilityForTool('fs_edit')?.id).toBe('file_editing')
    expect(getCapabilityForTool('fs_write')?.id).toBe('file_editing')
  })

  it('type-guards the D6 batch 4 tool names (fs_edit, fs_write)', () => {
    expect(isBuiltinToolName('fs_edit')).toBe(true)
    expect(isBuiltinToolName('fs_write')).toBe(true)
    expect(isBuiltinCapabilityId('file_editing')).toBe(true)
  })

  // D6 batch 5 (web_access). Combined with web-access-equivalence.test.ts
  // (which proves `executeBuiltinTool` itself produces the same result as
  // the old switch case for both tools, including the `isAvailable`
  // provider-readiness gate), this closes the same loop earlier batches
  // closed: registered -> reached -> correct.
  it('finds the web_access capability by id, with its dedicated settings entry (master.md §1.4c)', () => {
    const capability = getCapability('web_access')
    expect(capability?.id).toBe('web_access')
    expect(capability?.tools.map((tool) => tool.name)).toEqual([
      'web_search',
      'web_scrape',
    ])
    expect(capability?.hasSettings).toBe(true)
  })

  it('maps web_search and web_scrape back to web_access', () => {
    expect(getCapabilityForTool('web_search')?.id).toBe('web_access')
    expect(getCapabilityForTool('web_scrape')?.id).toBe('web_access')
  })

  it('type-guards the D6 batch 5 tool names (web_search, web_scrape)', () => {
    expect(isBuiltinToolName('web_search')).toBe(true)
    expect(isBuiltinToolName('web_scrape')).toBe(true)
    expect(isBuiltinCapabilityId('web_access')).toBe(true)
  })

  // D6 batch 6 (js_sandbox, terminal). Combined with
  // js-eval-terminal-equivalence.test.ts (which proves `executeBuiltinTool`
  // itself produces the same result as the old switch case for both tools,
  // including `terminal_command`'s `isAvailable` platform gate — the one
  // deliberate behavior change in this batch), this closes the same loop
  // earlier batches closed: registered -> reached -> correct.
  it('finds js_sandbox and terminal, each with their own dedicated settings entry', () => {
    const jsSandbox = getCapability('js_sandbox')
    expect(jsSandbox?.tools.map((tool) => tool.name)).toEqual(['js_eval'])
    expect(jsSandbox?.hasSettings).toBe(true)

    const terminal = getCapability('terminal')
    expect(terminal?.tools.map((tool) => tool.name)).toEqual([
      'terminal_command',
    ])
    expect(terminal?.hasSettings).toBe(true)
    // master.md §3.1: terminal is one of two capabilities (with vault_shell)
    // that forbid "always allow for this conversation".
    expect(terminal?.approval.allowAlwaysAllow).toBe(false)
  })

  it('maps js_eval and terminal_command back to their capabilities', () => {
    expect(getCapabilityForTool('js_eval')?.id).toBe('js_sandbox')
    expect(getCapabilityForTool('terminal_command')?.id).toBe('terminal')
  })

  it('type-guards the D6 batch 6 tool names (js_eval, terminal_command)', () => {
    expect(isBuiltinToolName('js_eval')).toBe(true)
    expect(isBuiltinToolName('terminal_command')).toBe(true)
    expect(isBuiltinCapabilityId('js_sandbox')).toBe(true)
    expect(isBuiltinCapabilityId('terminal')).toBe(true)
  })

  // D6 batch 7 (vault_shell) — the last D6 batch. Combined with
  // bash-equivalence.test.ts (which proves `executeBuiltinTool` itself
  // produces the same result as the old `case BASH_TOOL_NAME` switch branch,
  // including all three approval tiers and the `dangerous_only` interception
  // behavior), this closes the same loop earlier batches closed: registered
  // -> reached -> correct.
  it('finds vault_shell, the only capability with a three-tier approval and no dedicated settings', () => {
    const vaultShell = getCapability('vault_shell')
    expect(vaultShell?.id).toBe('vault_shell')
    expect(vaultShell?.tools.map((tool) => tool.name)).toEqual(['bash'])
    expect(vaultShell?.hasSettings).toBe(false)
    expect(vaultShell?.approval).toEqual({
      defaultMode: 'dangerous_only',
      allowedModes: ['full_access', 'dangerous_only', 'require_approval'],
      allowAlwaysAllow: false,
    })
  })

  it('maps bash back to vault_shell', () => {
    expect(getCapabilityForTool('bash')?.id).toBe('vault_shell')
  })

  it('type-guards the D6 batch 7 tool name (bash)', () => {
    expect(isBuiltinToolName('bash')).toBe(true)
    expect(isBuiltinCapabilityId('vault_shell')).toBe(true)
  })
})

describe('chat mode visibility', () => {
  /**
   * docs/plans/09-05-yolo-max/master.md §6's declaration table, written out in
   * full. Each capability carries its own `chatModes`, so this is the one
   * place the whole table is visible at once — and the regression that makes
   * a change to any single capability's visibility a deliberate act. It is
   * also why no per-mode block list exists anywhere else in the codebase.
   */
  const CAPABILITY_IDS_BY_CHAT_MODE: Record<BuiltinChatModeId, string[]> = {
    ask: [
      'context_compaction',
      'context_pruning',
      'file_reading',
      'memory',
      'subagent_delegation',
      'user_questions',
      'vault_shell',
      'web_access',
    ],
    agent: [
      'context_compaction',
      'context_pruning',
      'file_editing',
      'file_reading',
      'js_sandbox',
      'memory',
      'subagent_delegation',
      'terminal',
      'todo_list',
      'user_questions',
      'vault_shell',
      'web_access',
    ],
    max: [
      'context_compaction',
      'context_pruning',
      'memory',
      'native_files',
      'subagent_delegation',
      'terminal',
      'todo_list',
      'user_questions',
      'web_access',
    ],
  }

  it.each(['ask', 'agent', 'max'] as const)(
    'exposes exactly the master.md §6 capability set in %s mode',
    (mode) => {
      expect(
        listCapabilities()
          .filter((capability) => capability.chatModes.includes(mode))
          .map((capability) => capability.id)
          .sort(),
      ).toEqual([...CAPABILITY_IDS_BY_CHAT_MODE[mode]].sort())
    },
  )

  it('leaves no capability invisible in every mode', () => {
    const everywhereInvisible = listCapabilities().filter(
      (capability) => capability.chatModes.length === 0,
    )
    expect(everywhereInvisible).toEqual([])
  })

  it('expands a mode to the fully-qualified tool names of its capabilities', () => {
    expect(getToolNamesForChatMode('max').sort()).toEqual(
      [
        'yolo_local__ask_user_question',
        'yolo_local__context_compact',
        'yolo_local__context_prune_tool_results',
        'yolo_local__delegate_subagent',
        'yolo_local__edit_file',
        'yolo_local__memory_add',
        'yolo_local__memory_delete',
        'yolo_local__memory_update',
        'yolo_local__read_file',
        'yolo_local__terminal_command',
        'yolo_local__todo_write',
        'yolo_local__web_scrape',
        'yolo_local__web_search',
        'yolo_local__write_file',
      ].sort(),
    )
  })

  it('keeps the vault-backed and native file toolsets in disjoint modes (master.md Q5)', () => {
    const vaultFileTools = [
      'yolo_local__fs_read',
      'yolo_local__fs_edit',
      'yolo_local__fs_write',
      'yolo_local__bash',
    ]
    const nativeFileTools = [
      'yolo_local__read_file',
      'yolo_local__write_file',
      'yolo_local__edit_file',
    ]
    for (const mode of ['ask', 'agent'] as const) {
      const names = getToolNamesForChatMode(mode)
      expect(names).toEqual(expect.arrayContaining(['yolo_local__fs_read']))
      expect(names.filter((name) => nativeFileTools.includes(name))).toEqual([])
    }
    expect(
      getToolNamesForChatMode('max').filter((name) =>
        vaultFileTools.includes(name),
      ),
    ).toEqual([])
  })

  it('lists every built-in tool by fully-qualified name', () => {
    expect(listBuiltinToolNames().sort()).toEqual(
      listBuiltinTools()
        .map((tool) => `yolo_local__${tool.name}`)
        .sort(),
    )
    // Every mode's tools are a subset of the whole catalog.
    const all = new Set(listBuiltinToolNames())
    for (const mode of ['ask', 'agent', 'max'] as const) {
      expect(getToolNamesForChatMode(mode).every((name) => all.has(name))).toBe(
        true,
      )
    }
  })
})
