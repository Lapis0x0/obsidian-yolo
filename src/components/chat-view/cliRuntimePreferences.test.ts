import { parseYoloSettings } from '../../settings/schema/settings'

import {
  rememberCliRuntimeConfiguration,
  resolveCliRuntimePreference,
} from './cliRuntimePreferences'

describe('CLI runtime preferences', () => {
  it('remembers model and per-model effort in one settings update', () => {
    const settings = parseYoloSettings({})
    const next = rememberCliRuntimeConfiguration(settings, 'codex', {
      models: [],
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

  it('keeps effort preferences isolated by model', () => {
    const settings = rememberCliRuntimeConfiguration(
      rememberCliRuntimeConfiguration(parseYoloSettings({}), 'codex', {
        models: [],
        modelId: 'luna',
        reasoningEffort: 'medium',
      }),
      'codex',
      {
        models: [],
        modelId: 'sol',
        reasoningEffort: 'high',
      },
    )

    expect(
      settings.chatOptions.cliReasoningEffortByModel,
    ).toEqual({ 'codex:luna': 'medium', 'codex:sol': 'high' })
  })
})
