import {
  assertNoDuplicates,
  getCapability,
  getCapabilityForTool,
  getToolDefinition,
  isBuiltinCapabilityId,
  isBuiltinToolName,
  listBuiltinTools,
  listCapabilities,
} from './registry'

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
