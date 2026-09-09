import {
  AGENT_CAPABILITY_TOOL_NAMES,
  resolveAgentCapabilityProfile,
} from './capability-profile'

describe('resolveAgentCapabilityProfile', () => {
  it('grants no host tools and is not read-only for "none"', () => {
    const profile = resolveAgentCapabilityProfile('none')
    expect(profile.allowedHostToolNames).toEqual([])
    expect(profile.bashReadOnly).toBe(false)
  })

  it('grants only bash and forces read-only for "vault-read"', () => {
    const profile = resolveAgentCapabilityProfile('vault-read')
    expect(profile.allowedHostToolNames).toEqual([
      AGENT_CAPABILITY_TOOL_NAMES.bash,
    ])
    expect(profile.bashReadOnly).toBe(true)
  })

  it('grants bash and edit and is not read-only for "vault-write"', () => {
    const profile = resolveAgentCapabilityProfile('vault-write')
    expect(profile.allowedHostToolNames).toEqual([
      AGENT_CAPABILITY_TOOL_NAMES.bash,
      AGENT_CAPABILITY_TOOL_NAMES.edit,
    ])
    expect(profile.bashReadOnly).toBe(false)
  })

  it('returns a frozen profile with a frozen tool name list', () => {
    const profile = resolveAgentCapabilityProfile('vault-write')
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.allowedHostToolNames)).toBe(true)
  })
})
