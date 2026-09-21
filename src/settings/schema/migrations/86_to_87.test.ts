import { migrateFrom86To87 } from './86_to_87'

describe('migrateFrom86To87', () => {
  it('drops auto-captured CLI model defaults and keeps other chat options', () => {
    const result = migrateFrom86To87({
      version: 86,
      chatOptions: {
        includeCurrentFileContent: true,
        cliModelIdByRuntime: { hermes: 'openrouter:old-model' },
        cliReasoningEffortByModel: { 'codex:gpt-5.6-luna': 'medium' },
        cliChatModeByRuntime: { hermes: 'agent' },
      },
    })

    expect(result.version).toBe(87)
    expect(result.chatOptions).toEqual({
      includeCurrentFileContent: true,
      cliModelIdByRuntime: {},
      cliReasoningEffortByModel: {},
      cliChatModeByRuntime: { hermes: 'agent' },
    })
  })

  it('leaves settings without chat options untouched', () => {
    expect(migrateFrom86To87({ version: 86 })).toEqual({ version: 87 })
  })
})
