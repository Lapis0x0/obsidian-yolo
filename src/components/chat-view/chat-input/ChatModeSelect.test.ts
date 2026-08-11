import type { RegisteredModuleChatModeV1 } from '../../../core/modules/moduleChatModeRegistry'

import {
  CHAT_MODES,
  CLAUDE_CODE_CHAT_MODES,
  CODEX_CHAT_MODES,
  type ModuleChatModeOption,
  chatModeForSave,
  isChatMode,
  isModuleChatMode,
  narrowToMentionChatMode,
  normalizePersistedChatMode,
  resolveEffectiveChatMode,
  resolveVisibleModuleModeOptions,
  shouldShowYoloToggle,
} from './ChatModeSelect'

describe('ChatModeSelect runtime options', () => {
  it('exposes the intended modes for each runtime', () => {
    expect(CHAT_MODES).toEqual(['ask', 'agent'])
    expect(CLAUDE_CODE_CHAT_MODES).toEqual(['agent', 'plan'])
    expect(CODEX_CHAT_MODES).toEqual(['agent'])
  })

  it('hides the YOLO switch while Plan is active', () => {
    expect(shouldShowYoloToggle(CLAUDE_CODE_CHAT_MODES, 'agent')).toBe(true)
    expect(shouldShowYoloToggle(CLAUDE_CODE_CHAT_MODES, 'plan')).toBe(false)
  })

  it('hides the YOLO switch while a module chat mode is selected', () => {
    const availableModes = ['ask', 'agent', 'module:learning:chat'] as const
    expect(shouldShowYoloToggle(availableModes, 'agent')).toBe(true)
    expect(shouldShowYoloToggle(availableModes, 'module:learning:chat')).toBe(
      false,
    )
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
    expect(chatModeForSave('module:learning:chat')).toBe('module:learning:chat')
  })
})
