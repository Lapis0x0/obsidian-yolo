import { migrateFrom65To66 } from './65_to_66'

describe('migrateFrom65To66', () => {
  it('bumps the version to 66', () => {
    const result = migrateFrom65To66({ version: 65 })
    expect(result.version).toBe(66)
  })

  it('strips legacy time placeholders from settings.systemPrompt', () => {
    const result = migrateFrom65To66({
      version: 65,
      systemPrompt:
        'Today is {{current_date}} ({{current_weekday}}) at {{current_hour}} / {{current_minute}} / {{current_time:date}}. Be helpful.',
    })

    expect(result.systemPrompt).toBe('Today is  () at  /  / . Be helpful.')
  })

  it('strips placeholders case-insensitively and tolerates whitespace', () => {
    const result = migrateFrom65To66({
      version: 65,
      systemPrompt: 'A {{ CURRENT_DATE }} B {{current_time:weekday}} C',
    })

    expect(result.systemPrompt).toBe('A  B  C')
  })

  it('strips placeholders from each assistants[].systemPrompt', () => {
    const result = migrateFrom65To66({
      version: 65,
      assistants: [
        {
          id: 'a1',
          name: 'Default',
          systemPrompt: 'You are X. Now is {{current_minute}}.',
        },
        {
          id: 'a2',
          name: 'NoPrompt',
        },
      ],
    })

    const assistants = result.assistants as Array<Record<string, unknown>>
    expect(assistants[0].systemPrompt).toBe('You are X. Now is .')
    expect(assistants[1].systemPrompt).toBeUndefined()
  })

  it('leaves non-time placeholders untouched', () => {
    const result = migrateFrom65To66({
      version: 65,
      systemPrompt: 'Keep {{custom_var}} and {{current_date}} only stripped.',
    })

    expect(result.systemPrompt).toBe('Keep {{custom_var}} and  only stripped.')
  })

  it('defaults timeContextEnabled to true when absent', () => {
    const result = migrateFrom65To66({ version: 65 })
    expect(result.timeContextEnabled).toBe(true)
  })

  it('preserves an explicit timeContextEnabled', () => {
    const result = migrateFrom65To66({
      version: 65,
      timeContextEnabled: false,
    })
    expect(result.timeContextEnabled).toBe(false)
  })

  it('is a no-op for unrelated fields', () => {
    const result = migrateFrom65To66({
      version: 65,
      chatModelId: 'gpt-4',
    })

    expect(result.version).toBe(66)
    expect(result.chatModelId).toBe('gpt-4')
    expect(result.timeContextEnabled).toBe(true)
  })
})
