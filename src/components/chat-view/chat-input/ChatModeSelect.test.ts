import { Platform } from 'obsidian'

import type { RegisteredModuleChatModeV1 } from '../../../core/modules/moduleChatModeRegistry'

import {
  CHAT_MODES,
  CLAUDE_CODE_CHAT_MODES,
  CODEX_CHAT_MODES,
  type ModuleChatModeOption,
  availableBuiltinChatModes,
  chatModeForSave,
  isChatMode,
  isModuleChatMode,
  isToolChatMode,
  isYoloModeActive,
  narrowToMentionChatMode,
  normalizePersistedChatMode,
  readYoloPreference,
  resolveEffectiveChatMode,
  resolveVisibleModuleModeOptions,
  resolveYoloByMode,
  shouldShowYoloToggle,
  yoloPreferenceKeyForMode,
  yoloPreferencePatch,
} from './ChatModeSelect'

/**
 * `Platform` is ambient in the Obsidian API and the plugin reads it the same
 * way everywhere (tool `isAvailable`, `tool-gateway`), so the desktop-only
 * cases flip the mocked object rather than threading a flag through every
 * signature.
 */
const withPlatform = <T>(isDesktop: boolean, run: () => T): T => {
  const previous = Platform.isDesktop
  Platform.isDesktop = isDesktop
  try {
    return run()
  } finally {
    Platform.isDesktop = previous
  }
}

describe('ChatModeSelect runtime options', () => {
  it('exposes the intended modes for each runtime', () => {
    expect(CHAT_MODES).toEqual(['ask', 'agent', 'max'])
    expect(CLAUDE_CODE_CHAT_MODES).toEqual(['agent', 'plan'])
    expect(CODEX_CHAT_MODES).toEqual(['agent'])
  })

  it('hides the YOLO switches while Plan is active', () => {
    expect(shouldShowYoloToggle('agent')).toBe(true)
    expect(shouldShowYoloToggle('plan')).toBe(false)
  })

  it('hides the YOLO switches while a module chat mode is selected', () => {
    expect(shouldShowYoloToggle('agent')).toBe(true)
    expect(shouldShowYoloToggle('module:learning:chat')).toBe(false)
  })

  it('does not present persisted YOLO state as active when the control is unavailable', () => {
    expect(isYoloModeActive(false, 'agent', true)).toBe(false)
    expect(isYoloModeActive(true, 'agent', true)).toBe(true)
    expect(isYoloModeActive(true, 'plan', true)).toBe(false)
  })

  it('treats Max as a YOLO-capable mode, same as Agent', () => {
    expect(isYoloModeActive(true, 'max', true)).toBe(true)
    expect(isYoloModeActive(true, 'max', false)).toBe(false)
    expect(shouldShowYoloToggle('max')).toBe(true)
    expect(shouldShowYoloToggle('ask')).toBe(true)
  })

  it('shows both tool cards their own switch whichever mode is selected, including Ask', () => {
    // The gate is whole-menu; which cards carry a switch follows from
    // `isToolChatMode`, and a card that is not listed cannot render one.
    for (const mode of ['ask', 'agent', 'max'] as const) {
      expect(shouldShowYoloToggle(mode)).toBe(true)
    }
    expect(CHAT_MODES.filter(isToolChatMode)).toEqual(['agent', 'max'])
  })

  it('offers Max only on desktop', () => {
    expect(withPlatform(true, availableBuiltinChatModes)).toEqual([
      'ask',
      'agent',
      'max',
    ])
    expect(withPlatform(false, availableBuiltinChatModes)).toEqual([
      'ask',
      'agent',
    ])
  })
})

describe('isToolChatMode', () => {
  it('covers the modes that run tools, and nothing else', () => {
    expect(isToolChatMode('agent')).toBe(true)
    expect(isToolChatMode('max')).toBe(true)
    expect(isToolChatMode('ask')).toBe(false)
    expect(isToolChatMode('plan')).toBe(false)
    // A module chat mode has tools too, but it declares its own grant and
    // never participates in the assistant/YOLO wiring this gates.
    expect(isToolChatMode('module:learning:chat')).toBe(false)
  })
})

describe('per-mode YOLO preference', () => {
  it('routes Max to its own field and leaves every other mode on the Agent field', () => {
    expect(yoloPreferenceKeyForMode('max')).toBe('maxYoloEnabled')
    expect(yoloPreferenceKeyForMode('agent')).toBe('agentYoloEnabled')
    expect(yoloPreferenceKeyForMode('ask')).toBe('agentYoloEnabled')
    expect(yoloPreferenceKeyForMode('module:learning:chat')).toBe(
      'agentYoloEnabled',
    )
  })

  it('reads the field belonging to the mode, not whichever one is set', () => {
    const stored = { agentYoloEnabled: false, maxYoloEnabled: true }
    expect(readYoloPreference(stored, 'agent')).toBe(false)
    expect(readYoloPreference(stored, 'max')).toBe(true)
    expect(readYoloPreference(null, 'max')).toBeUndefined()
    expect(readYoloPreference({}, 'agent')).toBeUndefined()
  })

  it('patches only the current mode, so switching modes cannot overwrite the other profile', () => {
    expect(yoloPreferencePatch('max', true)).toEqual({ maxYoloEnabled: true })
    expect(yoloPreferencePatch('agent', false)).toEqual({
      agentYoloEnabled: false,
    })
    expect({
      agentYoloEnabled: true,
      ...yoloPreferencePatch('max', true),
    }).toEqual({ agentYoloEnabled: true, maxYoloEnabled: true })
  })
})

describe('resolveYoloByMode', () => {
  it('gives each card its own state, so one profile never renders under the other label', () => {
    expect(
      resolveYoloByMode(
        'agent',
        true,
        { maxYoloEnabled: false },
        { agentYoloEnabled: false, maxYoloEnabled: true },
      ),
    ).toEqual({ agent: true, max: false })
  })

  it('takes the selected mode from the live flag the runtime reads, not from storage', () => {
    // The conversation override still says false — the card must follow the
    // snapshot the run is actually using, or the ∞ badge would lie.
    expect(
      resolveYoloByMode(
        'max',
        true,
        { maxYoloEnabled: false },
        { maxYoloEnabled: false },
      ),
    ).toEqual({ agent: false, max: true })
  })

  it('resolves the unselected mode override-first, then the global default', () => {
    expect(
      resolveYoloByMode('agent', false, { maxYoloEnabled: true }, {}),
    ).toEqual({ agent: false, max: true })
    expect(
      resolveYoloByMode('agent', false, null, { maxYoloEnabled: true }),
    ).toEqual({ agent: false, max: true })
    expect(resolveYoloByMode('agent', false, null, null)).toEqual({
      agent: false,
      max: false,
    })
  })

  it('reads both cards from storage when the selected mode owns no profile (Ask, Plan, module modes)', () => {
    const stored = { agentYoloEnabled: true, maxYoloEnabled: true }
    // `activeYoloEnabled` describes no card here, so it must not leak into one.
    expect(resolveYoloByMode('ask', false, null, stored)).toEqual({
      agent: true,
      max: true,
    })
  })
})

describe('resolveVisibleModuleModeOptions', () => {
  const learningOption: ModuleChatModeOption = {
    value: 'module:learning:chat',
    label: 'Learning',
    description: 'Study with a tutor',
    icon: 'graduation-cap',
  }
  const otherOption: ModuleChatModeOption = {
    value: 'module:other:mode',
    label: 'Other',
  }

  it('keeps only module options present in availableModes, same as the built-in filter', () => {
    expect(
      resolveVisibleModuleModeOptions(
        [learningOption, otherOption],
        ['ask', 'agent', 'module:learning:chat'],
      ),
    ).toEqual([learningOption])
  })

  it('returns an empty list when no module options are selectable (e.g. CLI runtimes)', () => {
    expect(
      resolveVisibleModuleModeOptions([learningOption], ['agent', 'plan']),
    ).toEqual([])
  })

  it('passes through every option once all are selectable', () => {
    expect(
      resolveVisibleModuleModeOptions(
        [learningOption, otherOption],
        ['ask', 'agent', 'module:learning:chat', 'module:other:mode'],
      ),
    ).toEqual([learningOption, otherOption])
  })
})

describe('narrowToMentionChatMode', () => {
  it('passes ask/agent through unchanged', () => {
    expect(narrowToMentionChatMode('ask')).toBe('ask')
    expect(narrowToMentionChatMode('agent')).toBe('agent')
  })

  it('narrows Max to agent — the compact / switcher does not offer it, so the highlight has to land on the nearest mode it does offer', () => {
    expect(narrowToMentionChatMode('max')).toBe('agent')
  })

  it('narrows a module chat mode to agent — the mention menu only understands CHAT_MODES (ask/agent), so a module mode must fall back to the closest built-in mode rather than the unrelated ask', () => {
    expect(narrowToMentionChatMode('module:learning:chat')).toBe('agent')
  })

  it('drops other values (plan, undefined) so nothing is highlighted', () => {
    expect(narrowToMentionChatMode('plan')).toBeUndefined()
    expect(narrowToMentionChatMode(undefined)).toBeUndefined()
  })
})

describe('isModuleChatMode / isChatMode', () => {
  it('accepts only the full module:<moduleId>:<modeId> format', () => {
    expect(isModuleChatMode('module:learning:chat')).toBe(true)
    expect(isModuleChatMode('module:learning:course-chat')).toBe(true)
  })

  it('rejects malformed module ids', () => {
    expect(isModuleChatMode('module:learning')).toBe(false)
    expect(isModuleChatMode('module:Learning:chat')).toBe(false)
    expect(isModuleChatMode('module:learning:Chat')).toBe(false)
    expect(isModuleChatMode('module:learning:chat:extra')).toBe(false)
    expect(isModuleChatMode('module::chat')).toBe(false)
    expect(isModuleChatMode('modulex:learning:chat')).toBe(false)
    expect(isModuleChatMode('ask')).toBe(false)
  })

  it('isChatMode accepts built-ins and well-formed module ids', () => {
    expect(isChatMode('ask')).toBe(true)
    expect(isChatMode('agent')).toBe(true)
    expect(isChatMode('max')).toBe(true)
    expect(isChatMode('module:learning:chat')).toBe(true)
    expect(isChatMode('module:learning')).toBe(false)
    expect(isChatMode('plan')).toBe(false)
  })
})

describe('normalizePersistedChatMode', () => {
  it('folds historical aliases', () => {
    expect(normalizePersistedChatMode('chat', 'agent')).toBe('ask')
    expect(normalizePersistedChatMode('agent-full', 'ask')).toBe('agent')
  })

  it('passes built-in values and well-formed module ids through unchanged', () => {
    expect(normalizePersistedChatMode('ask', 'agent')).toBe('ask')
    expect(normalizePersistedChatMode('agent', 'ask')).toBe('agent')
    expect(normalizePersistedChatMode('module:learning:chat', 'agent')).toBe(
      'module:learning:chat',
    )
  })

  it('does NOT check registry availability — format validity is enough', () => {
    // An unregistered/uninstalled module id still normalizes through; only
    // `resolveEffectiveChatMode` (which needs a registry snapshot) downgrades it.
    expect(normalizePersistedChatMode('module:uninstalled:chat', 'agent')).toBe(
      'module:uninstalled:chat',
    )
  })

  it('falls back for malformed or unrecognized values', () => {
    expect(normalizePersistedChatMode('module:learning', 'agent')).toBe('agent')
    expect(normalizePersistedChatMode('module:Learning:chat', 'agent')).toBe(
      'agent',
    )
    expect(normalizePersistedChatMode('plan', 'agent')).toBe('agent')
    expect(normalizePersistedChatMode(null, 'agent')).toBe('agent')
    expect(normalizePersistedChatMode(undefined, 'ask')).toBe('ask')
  })
})

describe('resolveEffectiveChatMode', () => {
  const availableEntry: RegisteredModuleChatModeV1 = {
    fullModeId: 'module:learning:chat',
    moduleId: 'learning',
    mode: {
      id: 'chat',
      label: { en: 'Learning' },
      personaPrompt: 'You are a tutor.',
      capability: 'vault-read',
    } as RegisteredModuleChatModeV1['mode'],
    serverName: 'module-mode-learning-chat',
    availability: { status: 'available' },
  }
  const unavailableEntry: RegisteredModuleChatModeV1 = {
    ...availableEntry,
    availability: { status: 'unavailable', reason: 'module disabled' },
  }

  it('leaves built-in modes untouched regardless of the registry', () => {
    expect(resolveEffectiveChatMode('ask', [])).toBe('ask')
    expect(resolveEffectiveChatMode('agent', [availableEntry])).toBe('agent')
  })

  it('runs a Max conversation as Agent on mobile without touching what is persisted', () => {
    expect(withPlatform(true, () => resolveEffectiveChatMode('max', []))).toBe(
      'max',
    )
    expect(withPlatform(false, () => resolveEffectiveChatMode('max', []))).toBe(
      'agent',
    )
  })

  it('passes through a registered + available module mode', () => {
    expect(
      resolveEffectiveChatMode('module:learning:chat', [availableEntry]),
    ).toBe('module:learning:chat')
  })

  it('downgrades to agent when the module mode is unregistered', () => {
    expect(resolveEffectiveChatMode('module:learning:chat', [])).toBe('agent')
  })

  it('downgrades to agent when the module mode is registered but unavailable', () => {
    expect(
      resolveEffectiveChatMode('module:learning:chat', [unavailableEntry]),
    ).toBe('agent')
  })

  it('restores the module mode once it becomes available again', () => {
    // Same persisted value, only the registry snapshot changes — models a
    // module being disabled then re-enabled without ever touching the
    // persisted value in between.
    expect(
      resolveEffectiveChatMode('module:learning:chat', [unavailableEntry]),
    ).toBe('agent')
    expect(
      resolveEffectiveChatMode('module:learning:chat', [availableEntry]),
    ).toBe('module:learning:chat')
  })
})

describe('chatModeForSave', () => {
  it('always returns the persisted value verbatim — the write-back discipline is enforced by call sites always passing persistedChatMode, never an effective/downgraded value', () => {
    expect(chatModeForSave('ask')).toBe('ask')
    expect(chatModeForSave('agent')).toBe('agent')
    expect(chatModeForSave('max')).toBe('max')
    expect(chatModeForSave('module:learning:chat')).toBe('module:learning:chat')
  })
})
