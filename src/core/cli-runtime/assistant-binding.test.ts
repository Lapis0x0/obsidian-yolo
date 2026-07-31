import type { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { LiteSkillEntry } from '../skills/liteSkills'

import {
  getCliAssistantBindingCacheKey,
  resolveCliAssistantBinding,
} from './assistant-binding'

const settings = {
  assistants: [
    {
      id: 'assistant-1',
      name: 'Reviewer',
      systemPrompt: 'Review carefully.',
      skillPreferences: {
        disabled: { enabled: false },
      },
    },
  ],
  skills: { disabledSkillIds: ['global-off'] },
} as unknown as YoloSettings

const skills: LiteSkillEntry[] = [
  {
    name: 'zeta',
    description: 'Z',
    mode: 'lazy',
    path: 'skills/zeta/SKILL.md',
  },
  {
    name: 'global-off',
    description: 'Global',
    mode: 'lazy',
    path: 'skills/global-off/SKILL.md',
  },
  {
    name: 'disabled',
    description: 'Disabled',
    mode: 'always',
    path: 'skills/disabled/SKILL.md',
  },
  {
    name: 'alpha',
    description: 'A',
    mode: 'always',
    path: 'skills/alpha/SKILL.md',
  },
]

describe('resolveCliAssistantBinding', () => {
  it('invalidates only for Assistant, Skill policy, or managed path changes', () => {
    const key = getCliAssistantBindingCacheKey(settings, 'assistant-1')
    expect(
      getCliAssistantBindingCacheKey(
        { ...settings, chatOptions: { chatMode: 'agent' } } as YoloSettings,
        'assistant-1',
      ),
    ).toBe(key)
    expect(
      getCliAssistantBindingCacheKey(
        {
          ...settings,
          skills: { disabledSkillIds: ['global-off', 'alpha'] },
        } as YoloSettings,
        'assistant-1',
      ),
    ).not.toBe(key)
  })

  it('freezes the selected persona and deterministically enabled skill names', async () => {
    const listSkillEntries = jest.fn(async () => skills)

    await expect(
      resolveCliAssistantBinding({
        app: {} as App,
        settings,
        assistantId: 'assistant-1',
        listSkillEntries,
      }),
    ).resolves.toEqual({
      assistantId: 'assistant-1',
      systemPrompt: 'Review carefully.',
      enabledSkillNames: ['alpha', 'zeta'],
    })
    expect(listSkillEntries).toHaveBeenCalledWith(expect.anything(), {
      settings,
    })
  })

  it('rejects a missing Assistant instead of silently changing persona', async () => {
    const listSkillEntries = jest.fn(async () => skills)

    await expect(
      resolveCliAssistantBinding({
        app: {} as App,
        settings,
        assistantId: 'missing',
        listSkillEntries,
      }),
    ).rejects.toThrow('Assistant is unavailable: missing')
    expect(listSkillEntries).not.toHaveBeenCalled()
  })
})
