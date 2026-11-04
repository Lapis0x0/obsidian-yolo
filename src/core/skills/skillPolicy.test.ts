import type { Assistant } from '../../types/assistant.types'

import { countEnabledAssistantSkills } from './skillPolicy'

describe('countEnabledAssistantSkills', () => {
  it('counts skills the assistant has on and the global list does not disable', () => {
    const assistant = {
      skillPreferences: { off_for_agent: { enabled: false } },
    } as unknown as Assistant

    expect(
      countEnabledAssistantSkills({
        assistant,
        skills: [
          { name: 'default_on' },
          { name: 'off_for_agent' },
          { name: 'off_globally' },
        ],
        disabledSkillNames: ['off_globally'],
      }),
    ).toBe(1)
  })
})
