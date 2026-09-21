import { parseYoloSettings } from '../../settings/schema/settings'

import {
  patchConversationCliModeOverrides,
  rememberCliModePreference,
  resolveCliModePreference,
  resolveCliRuntimePreference,
  setCliRuntimeDefault,
} from './cliRuntimePreferences'

describe('CLI runtime preferences', () => {
  it('follows the CLI configuration until a default is set', () => {
    expect(
      resolveCliRuntimePreference(parseYoloSettings({}), 'codex', []),
    ).toEqual({})
  })

  it('stores the explicit default as one model plus its effort', () => {
    const next = setCliRuntimeDefault(parseYoloSettings({}), 'codex', {
      modelId: 'luna',
      reasoningEffort: 'medium',
    })

    expect(next.chatOptions.cliModelIdByRuntime?.codex).toBe('luna')
    expect(next.chatOptions.cliReasoningEffortByModel).toEqual({
      'codex:luna': 'medium',
    })
    expect(
      resolveCliRuntimePreference(next, 'codex', [
        {
          id: 'luna',
          label: 'Luna',
          reasoningEfforts: [{ id: 'medium' }],
        },
      ]),
    ).toEqual({ modelId: 'luna', reasoningEffort: 'medium' })
  })

  it('replacing or clearing a default drops only that runtime', () => {
    const withDefaults = setCliRuntimeDefault(
      setCliRuntimeDefault(parseYoloSettings({}), 'codex', {
        modelId: 'luna',
        reasoningEffort: 'medium',
      }),
      'hermes',
      { modelId: 'mimo', reasoningEffort: 'high' },
    )
    const replaced = setCliRuntimeDefault(withDefaults, 'codex', {
      modelId: 'sol',
      reasoningEffort: null,
    })
    expect(replaced.chatOptions.cliReasoningEffortByModel).toEqual({
      'hermes:mimo': 'high',
    })

    const cleared = setCliRuntimeDefault(replaced, 'hermes', null)
    expect(cleared.chatOptions.cliModelIdByRuntime).toEqual({ codex: 'sol' })
    expect(cleared.chatOptions.cliReasoningEffortByModel).toEqual({})
    expect(resolveCliRuntimePreference(cleared, 'hermes', [])).toEqual({})
  })

  it('keeps CLI mode preferences isolated by runtime and conversation', () => {
    const settings = rememberCliModePreference(
      rememberCliModePreference(parseYoloSettings({}), 'claude-code', {
        mode: 'agent',
        yoloEnabled: false,
      }),
      'codex',
      { mode: 'agent', yoloEnabled: true },
    )
    const overrides = patchConversationCliModeOverrides(null, 'claude-code', {
      mode: 'plan',
      yoloEnabled: false,
    })

    expect(
      resolveCliModePreference(settings, 'claude-code', overrides),
    ).toEqual({ mode: 'plan', yoloEnabled: false })
    expect(resolveCliModePreference(settings, 'codex', overrides)).toEqual({
      mode: 'agent',
      yoloEnabled: true,
    })
  })
})
