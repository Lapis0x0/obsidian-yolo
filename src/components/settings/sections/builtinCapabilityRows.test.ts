import {
  buildBuiltinCapabilityRows,
  groupCapabilityRowsByCategory,
} from './builtinCapabilityRows'

// Pass-through translator: exercises the fallback strings, which is exactly
// what pre-D7 (`AgentToolsModal.tsx` etc.) rendered when no locale override
// was active.
const t = (_key: string, fallback?: string) => fallback ?? ''

/**
 * Regression test for D7a (docs/plans/2026-08-15-tool-registry/phase2-migration.md
 * D7): the settings page's built-in-capability list must render with the
 * exact same row order and labels as before the `BUILTIN_TOOL_UI_META` /
 * `BUILTIN_TOOL_CATEGORY_MAP` / `BUILTIN_TOOL_DISPLAY_ORDER` side tables were
 * torn down — this is now derived purely from `CAPABILITIES`'s registration
 * order (`core/tools/capabilities/index.ts`), so an accidental reorder there
 * is the single failure mode this guards against.
 */
describe('buildBuiltinCapabilityRows', () => {
  it('returns one row per capability, in CAPABILITIES registration order', () => {
    const rows = buildBuiltinCapabilityRows({ toolOptions: {}, t })

    expect(rows.map((row) => row.id)).toEqual([
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
    ])

    expect(rows.map((row) => row.label)).toEqual([
      'Read File',
      'Bash (Vault Shell)',
      'File Editing Toolset',
      'Prune Tool Results',
      'Compact Context',
      'Ask User',
      'Task List',
      'Memory Toolset',
      'Web Search Toolset',
      'Analysis Sandbox',
      'Terminal Commands',
      'Delegate Subagent',
    ])
  })
})

describe('groupCapabilityRowsByCategory', () => {
  it('buckets rows into the pre-D7 vault / context / external order and content', () => {
    const rows = buildBuiltinCapabilityRows({ toolOptions: {}, t })
    const groups = groupCapabilityRowsByCategory(rows, t)

    expect(groups.map((group) => group.category)).toEqual([
      'vault',
      'context',
      'external',
    ])

    const vault = groups.find((group) => group.category === 'vault')
    // fs_read -> bash -> fs_edit_ops (survey-current-state.md §四; the task
    // brief's "已经替你查清的事实").
    expect(vault?.rows.map((row) => row.id)).toEqual([
      'file_reading',
      'vault_shell',
      'file_editing',
    ])
    expect(vault?.rows.map((row) => row.label)).toEqual([
      'Read File',
      'Bash (Vault Shell)',
      'File Editing Toolset',
    ])

    const context = groups.find((group) => group.category === 'context')
    // context_prune_tool_results -> context_compact -> ask_user_question ->
    // todo_write -> memory_ops.
    expect(context?.rows.map((row) => row.id)).toEqual([
      'context_pruning',
      'context_compaction',
      'user_questions',
      'todo_list',
      'memory',
    ])
    expect(context?.rows.map((row) => row.label)).toEqual([
      'Prune Tool Results',
      'Compact Context',
      'Ask User',
      'Task List',
      'Memory Toolset',
    ])

    const external = groups.find((group) => group.category === 'external')
    // web_ops -> js_eval -> terminal_command -> delegate_subagent (former
    // `BUILTIN_TOOL_DISPLAY_ORDER.external`).
    expect(external?.rows.map((row) => row.id)).toEqual([
      'web_access',
      'js_sandbox',
      'terminal',
      'subagent_delegation',
    ])
    expect(external?.rows.map((row) => row.label)).toEqual([
      'Web Search Toolset',
      'Analysis Sandbox',
      'Terminal Commands',
      'Delegate Subagent',
    ])
  })

  it('titles each category group with the retired BUILTIN_TOOL_CATEGORY_I18N fallbacks', () => {
    const rows = buildBuiltinCapabilityRows({ toolOptions: {}, t })
    const groups = groupCapabilityRowsByCategory(rows, t)

    expect(groups.map((group) => group.title)).toEqual([
      'Vault',
      'Context & Memory',
      'External',
    ])
  })
})

describe('buildBuiltinCapabilityRows enablement', () => {
  it('is enabled by default when no tool options are disabled', () => {
    const rows = buildBuiltinCapabilityRows({ toolOptions: {}, t })
    const fileEditing = rows.find((row) => row.id === 'file_editing')
    expect(fileEditing?.enabled).toBe(true)
  })

  it('is disabled when its own capability-id key is disabled', () => {
    const rows = buildBuiltinCapabilityRows({
      toolOptions: { file_editing: { disabled: true } },
      t,
    })
    const fileEditing = rows.find((row) => row.id === 'file_editing')
    expect(fileEditing?.enabled).toBe(false)
  })

  it('is disabled for a 1:1 capability when its own capability-id key is disabled', () => {
    const rows = buildBuiltinCapabilityRows({
      toolOptions: { vault_shell: { disabled: true } },
      t,
    })
    const vaultShell = rows.find((row) => row.id === 'vault_shell')
    expect(vaultShell?.enabled).toBe(false)
  })

  it('a disabled key for an unrelated capability does not affect others', () => {
    const rows = buildBuiltinCapabilityRows({
      toolOptions: { vault_shell: { disabled: true } },
      t,
    })
    const fileEditing = rows.find((row) => row.id === 'file_editing')
    expect(fileEditing?.enabled).toBe(true)
  })
})
