import { migrateFrom72To73 } from './72_to_73'

describe('migrateFrom72To73', () => {
  it('splits legacy agent-full into agent + agentYoloEnabled', () => {
    const result = migrateFrom72To73({
      version: 72,
      chatOptions: { chatMode: 'agent-full', includeCurrentFileContent: true },
    })

    expect(result.version).toBe(73)
    const chatOptions = result.chatOptions as Record<string, unknown>
    expect(chatOptions.chatMode).toBe('agent')
    expect(chatOptions.agentYoloEnabled).toBe(true)
    expect(chatOptions.includeCurrentFileContent).toBe(true)
  })

  it('leaves non agent-full modes untouched', () => {
    const result = migrateFrom72To73({
      version: 72,
      chatOptions: { chatMode: 'ask' },
    })

    const chatOptions = result.chatOptions as Record<string, unknown>
    expect(chatOptions.chatMode).toBe('ask')
    expect(chatOptions.agentYoloEnabled).toBeUndefined()
  })

  it('handles missing chatOptions', () => {
    const result = migrateFrom72To73({ version: 72 })

    expect(result.version).toBe(73)
    expect(result.chatOptions).toEqual({})
  })
})
