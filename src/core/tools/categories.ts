import type { BuiltinToolCategory } from './types'

/**
 * Display order for the three settings-page category sections. Moved here
 * verbatim from the retired `core/agent/builtinToolUiMeta.ts` — a
 * capability concept (`BuiltinToolCategory` lives on
 * `BuiltinCapabilityDefinition`), not a UI-only one, so it belongs in
 * `core/tools/` rather than `core/agent/`.
 */
export const BUILTIN_TOOL_CATEGORY_ORDER: readonly BuiltinToolCategory[] = [
  'vault',
  'context',
  'external',
]

export const BUILTIN_TOOL_CATEGORY_I18N: Record<
  BuiltinToolCategory,
  { key: string; fallback: string }
> = {
  vault: {
    key: 'settings.agent.toolsGroupBuiltinVault',
    fallback: 'Vault',
  },
  context: {
    key: 'settings.agent.toolsGroupBuiltinContext',
    fallback: 'Context & Memory',
  },
  external: {
    key: 'settings.agent.toolsGroupBuiltinExternal',
    fallback: 'External',
  },
}
