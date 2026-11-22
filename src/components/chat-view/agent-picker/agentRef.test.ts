import {
  type AgentRef,
  MAX_PINNED_AGENTS,
  getAgentRuntimeId,
  parseAgentRef,
  resolveCurrentAgentRef,
  serializeAgentRef,
  togglePinnedAgent,
} from './agentRef'

describe('agentRef', () => {
  const refs: AgentRef[] = [
    { kind: 'assistant', assistantId: 'writer' },
    { kind: 'cli', runtimeId: 'claude-code' },
    { kind: 'cli', runtimeId: 'omp' },
    { kind: 'hermes', profileId: undefined },
    { kind: 'hermes', profileId: 'research' },
  ]

  it('round-trips every kind through its persisted string', () => {
    for (const ref of refs) {
      expect(parseAgentRef(serializeAgentRef(ref))).toEqual(ref)
    }
  })

  it('skips entries it does not recognise instead of guessing', () => {
    expect(parseAgentRef('cli:some-future-runtime')).toBeNull()
    expect(parseAgentRef('cli:hermes')).toBeNull()
    expect(parseAgentRef('assistant:')).toBeNull()
    expect(parseAgentRef('module:x')).toBeNull()
    expect(parseAgentRef('no-prefix')).toBeNull()
  })

  it('maps agents to the runtime they run on', () => {
    expect(refs.map(getAgentRuntimeId)).toEqual([
      'yolo',
      'claude-code',
      'omp',
      'hermes',
      'hermes',
    ])
  })

  it('derives the current agent from the conversation runtime state', () => {
    const state = { assistantId: 'writer', hermesProfileId: 'research' }
    expect(resolveCurrentAgentRef({ runtimeId: 'yolo', ...state })).toEqual({
      kind: 'assistant',
      assistantId: 'writer',
    })
    expect(resolveCurrentAgentRef({ runtimeId: 'hermes', ...state })).toEqual({
      kind: 'hermes',
      profileId: 'research',
    })
    expect(resolveCurrentAgentRef({ runtimeId: 'codex', ...state })).toEqual({
      kind: 'cli',
      runtimeId: 'codex',
    })
  })

  it('pins up to the limit, and unpins regardless of the limit', () => {
    let pinned: readonly string[] = []
    for (let index = 0; index < MAX_PINNED_AGENTS + 1; index += 1) {
      pinned = togglePinnedAgent(pinned, {
        kind: 'assistant',
        assistantId: `a${index}`,
      })
    }
    expect(pinned).toHaveLength(MAX_PINNED_AGENTS)
    expect(pinned).not.toContain(`assistant:a${MAX_PINNED_AGENTS}`)
    expect(
      togglePinnedAgent(pinned, { kind: 'assistant', assistantId: 'a0' }),
    ).not.toContain('assistant:a0')
  })
})
