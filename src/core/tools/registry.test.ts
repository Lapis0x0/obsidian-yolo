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

  // D6 batches 1-3. `McpManager.callTool`'s fork (`core/mcp/mcpManager.ts`,
  // the local-tool branch) is `isBuiltinToolName(toolName) ?
  // executeBuiltinTool(...) : callLocalFileTool(...)` — so this being `true`
  // for all five is what actually routes them through the new dispatcher at
  // runtime rather than silently falling back to the old switch. Combined
  // with the per-tool equivalence suites (context-tools-equivalence.test.ts,
  // todo-and-questions-equivalence.test.ts, fs-read-equivalence.test.ts),
  // which prove `executeBuiltinTool` itself produces the same result as the
  // old switch case, this closes the loop: registered -> reached ->
  // correct.
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
})
