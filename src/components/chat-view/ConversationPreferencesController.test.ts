import { SETTINGS_SCHEMA_VERSION } from '../../settings/schema/migrations'
import type { YoloSettings } from '../../settings/schema/setting.types'
import { parseYoloSettings } from '../../settings/schema/settings'

import {
  ConversationPreferencesController,
  type ConversationPreferencesControllerDeps,
} from './ConversationPreferencesController'

function createSettings(): YoloSettings {
  const base = parseYoloSettings({ version: SETTINGS_SCHEMA_VERSION })
  return {
    ...base,
    chatModelId: 'model-default',
    chatModels: [
      { providerId: 'provider-1', id: 'model-default', model: 'model-default' },
      {
        providerId: 'provider-1',
        id: 'model-assistant',
        model: 'model-assistant',
      },
    ],
    assistants: [
      {
        id: 'assistant-1',
        name: 'Assistant One',
        systemPrompt: '',
      },
      {
        id: 'assistant-2',
        name: 'Assistant Two',
        systemPrompt: '',
        modelId: 'model-assistant',
      },
    ],
  }
}

function createController(
  conversationId: string,
  overrides: Partial<ConversationPreferencesControllerDeps> = {},
) {
  const settings = createSettings()
  const persistPreferredAssistantId = jest.fn()
  const persistPreferredChatMode = jest.fn()
  const getReasoningLevelForModelId = jest.fn(() => 'off' as const)
  const deps: ConversationPreferencesControllerDeps = {
    getSettings: () => settings,
    getReasoningLevelForModelId,
    persistPreferredAssistantId,
    persistPreferredChatMode,
    ...overrides,
  }
  const controller = new ConversationPreferencesController(
    conversationId,
    {
      conversationModelId: 'model-default',
      conversationAssistantId: 'assistant-1',
      reasoningLevel: 'off',
      chatMode: 'agent',
      persistedChatMode: 'agent',
      yoloEnabled: false,
      conversationOverrides: null,
    },
    deps,
  )
  return {
    controller,
    settings,
    persistPreferredAssistantId,
    persistPreferredChatMode,
    getReasoningLevelForModelId,
  }
}

describe('ConversationPreferencesController', () => {
  it('exposes an initial snapshot and notifies subscribers only on change', () => {
    const { controller } = createController('c1')
    const listener = jest.fn()
    const unsubscribe = controller.subscribe(listener)

    controller.setReasoningLevel('off')
    expect(listener).not.toHaveBeenCalled()

    controller.setReasoningLevel('high')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().reasoningLevel).toBe('high')

    unsubscribe()
    controller.setReasoningLevel('low')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps unrelated snapshot fields referentially stable across a commit', () => {
    const { controller } = createController('c1')
    const before = controller.getSnapshot()

    controller.setReasoningLevel('high')

    const after = controller.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.reasoningLevel).toBe('high')
    // Only the changed field is a new value — object identity is otherwise
    // preserved as far as reference equality on the snapshot goes (the
    // snapshot itself is a fresh object per commit, matching the
    // ChatSessionController convention documented in CLAUDE.md).
    expect(after.conversationModelId).toBe(before.conversationModelId)
    expect(after.chatMode).toBe(before.chatMode)
  })

  describe('selectAssistant', () => {
    it('switches the assistant, persists the preference, and applies its default model', () => {
      const {
        controller,
        persistPreferredAssistantId,
        getReasoningLevelForModelId,
      } = createController('c1')

      controller.selectAssistant('assistant-2')

      const snapshot = controller.getSnapshot()
      expect(snapshot.conversationAssistantId).toBe('assistant-2')
      expect(snapshot.conversationModelId).toBe('model-assistant')
      expect(persistPreferredAssistantId).toHaveBeenCalledWith('assistant-2')
      expect(getReasoningLevelForModelId).toHaveBeenCalledWith(
        'model-assistant',
      )
      expect(controller.conversationAssistantIdRef.current.get('c1')).toBe(
        'assistant-2',
      )
      expect(controller.conversationModelIdRef.current.get('c1')).toBe(
        'model-assistant',
      )
    })

    it('falls back to the global chat model when the assistant has none', () => {
      const { controller } = createController('c1')

      // assistant-1 has no modelId → resolveAssistantModelId falls back to
      // settings.chatModelId.
      controller.selectAssistant('assistant-1')

      expect(controller.getSnapshot().conversationModelId).toBe('model-default')
    })
  })

  describe('changeChatMode', () => {
    it('updates chatMode + persistedChatMode together and merges the override', () => {
      const { controller, persistPreferredChatMode } = createController('c1')

      controller.changeChatMode('ask')

      const snapshot = controller.getSnapshot()
      expect(snapshot.chatMode).toBe('ask')
      expect(snapshot.persistedChatMode).toBe('ask')
      expect(snapshot.conversationOverrides).toEqual({ chatMode: 'ask' })
      expect(controller.conversationOverridesRef.current.get('c1')).toEqual({
        chatMode: 'ask',
      })
      expect(persistPreferredChatMode).toHaveBeenCalledWith('ask')
    })

    it('never learns a module chat mode into global settings', () => {
      const { controller, persistPreferredChatMode } = createController('c1')

      controller.changeChatMode('module:demo:writer')

      expect(controller.getSnapshot().chatMode).toBe('module:demo:writer')
      expect(persistPreferredChatMode).not.toHaveBeenCalled()
      // The conversation-scoped override still records it.
      expect(controller.getSnapshot().conversationOverrides).toEqual({
        chatMode: 'module:demo:writer',
      })
    })

    it('re-applies the assistant default model when switching back into agent mode at the global default', () => {
      const { controller } = createController('c1')
      controller.selectAssistant('assistant-2') // conversationModelId -> model-assistant
      controller.setConversationModelId('model-default') // simulate falling back to the global default

      controller.changeChatMode('ask')
      controller.changeChatMode('agent')

      // isAgentChatMode('agent') && assistant has a modelId && current model
      // equals the global default → re-applies the assistant's own model.
      expect(controller.getSnapshot().conversationModelId).toBe(
        'model-assistant',
      )
    })
  })

  describe('toggleYolo', () => {
    it('sets yoloEnabled and merges agentYoloEnabled into the override', () => {
      const { controller } = createController('c1')

      controller.toggleYolo(true)

      const snapshot = controller.getSnapshot()
      expect(snapshot.yoloEnabled).toBe(true)
      expect(snapshot.conversationOverrides).toEqual({ agentYoloEnabled: true })
      expect(controller.conversationOverridesRef.current.get('c1')).toEqual({
        agentYoloEnabled: true,
      })
    })
  })

  describe('switchConversation', () => {
    it('commits only the given fields and writes them into the per-conversation ref caches', () => {
      const { controller } = createController('c1')

      controller.switchConversation('c2', {
        conversationModelId: 'model-assistant',
        conversationAssistantId: 'assistant-2',
        reasoningLevel: 'high',
        conversationOverrides: { agentYoloEnabled: true },
      })

      const snapshot = controller.getSnapshot()
      expect(snapshot.conversationModelId).toBe('model-assistant')
      expect(snapshot.conversationAssistantId).toBe('assistant-2')
      expect(snapshot.reasoningLevel).toBe('high')
      expect(snapshot.conversationOverrides).toEqual({ agentYoloEnabled: true })
      // Fields not passed stay untouched.
      expect(snapshot.chatMode).toBe('agent')

      expect(controller.conversationModelIdRef.current.get('c2')).toBe(
        'model-assistant',
      )
      expect(controller.conversationAssistantIdRef.current.get('c2')).toBe(
        'assistant-2',
      )
      expect(controller.conversationReasoningLevelRef.current.get('c2')).toBe(
        'high',
      )
      expect(controller.conversationOverridesRef.current.get('c2')).toEqual({
        agentYoloEnabled: true,
      })
    })

    it('re-targets subsequent selectAssistant/changeChatMode ref writes at the new conversation id', () => {
      const { controller } = createController('c1')

      controller.switchConversation('c2', {
        conversationAssistantId: 'assistant-1',
      })
      controller.selectAssistant('assistant-2')

      // The ref cache write from the *command* (not switchConversation) must
      // land under the conversation id switchConversation moved the cursor
      // to, not the controller's original construction-time id.
      expect(controller.conversationAssistantIdRef.current.get('c2')).toBe(
        'assistant-2',
      )
      expect(controller.conversationAssistantIdRef.current.has('c1')).toBe(
        false,
      )
    })
  })

  describe('applyAssistantDefaultModel / onAssistantDefaultModelApplied', () => {
    it('is a no-op for an unknown model id', () => {
      const { controller } = createController('c1')
      const listener = jest.fn()
      controller.onAssistantDefaultModelApplied(listener)

      controller.applyAssistantDefaultModel('does-not-exist')

      expect(listener).not.toHaveBeenCalled()
      expect(controller.getSnapshot().conversationModelId).toBe('model-default')
    })

    it('applies the model + resolved reasoning level and emits a one-shot event', () => {
      const { controller } = createController('c1')
      const listener = jest.fn()
      controller.onAssistantDefaultModelApplied(listener)

      controller.applyAssistantDefaultModel('model-assistant')

      const snapshot = controller.getSnapshot()
      expect(snapshot.conversationModelId).toBe('model-assistant')
      expect(snapshot.reasoningLevel).toBe('off')
      expect(listener).toHaveBeenCalledWith('off')
      expect(controller.conversationModelIdRef.current.get('c1')).toBe(
        'model-assistant',
      )
      expect(controller.conversationReasoningLevelRef.current.get('c1')).toBe(
        'off',
      )
    })

    it('stops notifying a listener after it unsubscribes', () => {
      const { controller } = createController('c1')
      const listener = jest.fn()
      const unsubscribe = controller.onAssistantDefaultModelApplied(listener)
      unsubscribe()

      controller.applyAssistantDefaultModel('model-assistant')

      expect(listener).not.toHaveBeenCalled()
    })
  })
})
