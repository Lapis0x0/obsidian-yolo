export type BuiltinToolUiMeta = {
  labelKey: string
  descKey?: string
  labelFallback: string
  descFallback?: string
}

export const FILE_OPS_GROUP_TOOL_NAME = 'fs_file_ops'
export const MEMORY_OPS_GROUP_TOOL_NAME = 'memory_ops'

export const BUILTIN_TOOL_UI_META: Record<string, BuiltinToolUiMeta> = {
  fs_list: {
    labelKey: 'settings.agent.builtinFsListLabel',
    descKey: 'settings.agent.builtinFsListDesc',
    labelFallback: 'Read Vault',
    descFallback:
      'List directory structure under a vault path. Useful for workspace orientation.',
  },
  fs_search: {
    labelKey: 'settings.agent.builtinFsSearchLabel',
    descKey: 'settings.agent.builtinFsSearchDesc',
    labelFallback: 'Search Vault',
    descFallback:
      'Search the vault using keyword matching, semantic (RAG) retrieval, or hybrid retrieval, with content results grouped by file and accompanied by top snippets.',
  },
  fs_read: {
    labelKey: 'settings.agent.builtinFsReadLabel',
    descKey: 'settings.agent.builtinFsReadDesc',
    labelFallback: 'Read File',
    descFallback:
      'Read vault files by path with either full-file or targeted line-range operations.',
  },
  context_prune_tool_results: {
    labelKey: 'settings.agent.builtinContextPruneToolResultsLabel',
    descKey: 'settings.agent.builtinContextPruneToolResultsDesc',
    labelFallback: 'Prune Tool Results',
    descFallback:
      'Exclude selected historical tool results, or prune all prunable tool results at once, from future model-visible context without deleting chat history.',
  },
  context_compact: {
    labelKey: 'settings.agent.builtinContextCompactLabel',
    descKey: 'settings.agent.builtinContextCompactDesc',
    labelFallback: 'Compact Context',
    descFallback:
      'Compress earlier conversation history into a summary and continue in a fresh context window.',
  },
  fs_edit: {
    labelKey: 'settings.agent.builtinFsEditLabel',
    descKey: 'settings.agent.builtinFsEditDesc',
    labelFallback: 'Text Editing',
    descFallback:
      'Apply exactly one text edit operation within a single existing file, including replace, replace_lines, insert_after, and append.',
  },
  [FILE_OPS_GROUP_TOOL_NAME]: {
    labelKey: 'settings.agent.builtinFsFileOpsLabel',
    descKey: 'settings.agent.builtinFsFileOpsDesc',
    labelFallback: 'File Operation Toolset',
    descFallback:
      'Grouped file path operations: create/delete file, create/delete folder, and move.',
  },
  [MEMORY_OPS_GROUP_TOOL_NAME]: {
    labelKey: 'settings.agent.builtinMemoryOpsLabel',
    descKey: 'settings.agent.builtinMemoryOpsDesc',
    labelFallback: 'Memory Toolset',
    descFallback: 'Grouped memory operations: add, update, and delete memory.',
  },
  memory_add: {
    labelKey: 'settings.agent.builtinMemoryAddLabel',
    descKey: 'settings.agent.builtinMemoryAddDesc',
    labelFallback: 'Add Memory',
    descFallback:
      'Add one memory item into global or assistant memory and auto-assign an id.',
  },
  memory_update: {
    labelKey: 'settings.agent.builtinMemoryUpdateLabel',
    descKey: 'settings.agent.builtinMemoryUpdateDesc',
    labelFallback: 'Update Memory',
    descFallback: 'Update an existing memory item by id.',
  },
  memory_delete: {
    labelKey: 'settings.agent.builtinMemoryDeleteLabel',
    descKey: 'settings.agent.builtinMemoryDeleteDesc',
    labelFallback: 'Delete Memory',
    descFallback: 'Delete an existing memory item by id.',
  },
  open_skill: {
    labelKey: 'settings.agent.builtinOpenSkillLabel',
    descKey: 'settings.agent.builtinOpenSkillDesc',
    labelFallback: 'Open Skill',
    descFallback: 'Load a skill markdown file by id or name.',
  },
}

export const getBuiltinToolUiMeta = (
  toolName: string,
): BuiltinToolUiMeta | null => {
  return BUILTIN_TOOL_UI_META[toolName] ?? null
}
