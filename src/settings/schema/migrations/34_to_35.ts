import type { SettingMigration } from '../setting.types'

const renameToolName = (toolName: unknown): unknown => {
  if (toolName === 'fs_write') {
    return 'fs_file_ops'
  }
  if (toolName === 'yolo_local__fs_write') {
    return 'yolo_local__fs_file_ops'
  }
  return toolName
}

export const migrateFrom34To35: SettingMigration['migrate'] = (data) => {
  const newData: Record<string, unknown> = { ...data, version: 35 }

  if (Array.isArray(newData.assistants)) {
    newData.assistants = newData.assistants.map((assistant: unknown) => {
      if (!assistant || typeof assistant !== 'object') {
        return assistant
      }

      const assistantRecord = assistant as Record<string, unknown>
      const enabledToolNames = Array.isArray(assistantRecord.enabledToolNames)
        ? assistantRecord.enabledToolNames.map(renameToolName)
        : assistantRecord.enabledToolNames

      return {
        ...assistantRecord,
        enabledToolNames,
      }
    })
  }

  if (
    newData.mcp &&
    typeof newData.mcp === 'object' &&
    !Array.isArray(newData.mcp)
  ) {
    const mcpRecord = newData.mcp as Record<string, unknown>
    const builtinToolOptions =
      mcpRecord.builtinToolOptions &&
      typeof mcpRecord.builtinToolOptions === 'object' &&
      !Array.isArray(mcpRecord.builtinToolOptions)
        ? (mcpRecord.builtinToolOptions as Record<string, unknown>)
        : null

    if (builtinToolOptions) {
      const { fs_write, ...rest } = builtinToolOptions
      newData.mcp = {
        ...mcpRecord,
        builtinToolOptions: {
          ...rest,
          ...(fs_write === undefined ? {} : { fs_file_ops: fs_write }),
        },
      }
    }
  }

  return newData
}
