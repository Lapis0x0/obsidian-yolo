import { migrateFrom77To78 } from './77_to_78'

describe('migrateFrom77To78', () => {
  it('initializes empty CLI mode preference maps', () => {
    expect(
      migrateFrom77To78({
        version: 77,
        chatOptions: {
          includeCurrentFileContent: true,
        },
      }),
    ).toEqual({
      version: 78,
      chatOptions: {
        includeCurrentFileContent: true,
        cliChatModeByRuntime: {},
        cliAgentYoloEnabledByRuntime: {},
      },
    })
  })

  it('preserves existing CLI mode preference maps', () => {
    expect(
      migrateFrom77To78({
        version: 77,
        chatOptions: {
          cliChatModeByRuntime: { 'claude-code': 'plan' },
          cliAgentYoloEnabledByRuntime: { codex: true },
        },
      }),
    ).toEqual({
      version: 78,
      chatOptions: {
        cliChatModeByRuntime: { 'claude-code': 'plan' },
        cliAgentYoloEnabledByRuntime: { codex: true },
      },
    })
  })
})
