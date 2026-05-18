import {
  DEFAULT_AGENT_LLM_TOOLS,
  SettingMigration,
  cloneDefaultAgentLlmCategories,
} from '../setting.types'

/**
 * v56 -> v57: initialize Agent LLM tool settings for existing users.
 */
export const migrateFrom56To57: SettingMigration['migrate'] = (data) => {
  const newData: Record<string, unknown> = { ...data, version: 57 }

  if (!('agentLlmTools' in newData)) {
    newData.agentLlmTools = {
      ...DEFAULT_AGENT_LLM_TOOLS,
      categories: cloneDefaultAgentLlmCategories(),
    }
  }

  return newData
}
