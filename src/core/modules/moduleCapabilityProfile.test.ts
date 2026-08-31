import {
  MODULE_CAPABILITY_TOOL_NAMES,
  resolveModuleCapabilityProfile,
} from './moduleCapabilityProfile'

describe('resolveModuleCapabilityProfile', () => {
  it('grants no host tools and is not read-only for "none"', () => {
    const profile = resolveModuleCapabilityProfile('none')
    expect(profile.allowedHostToolNames).toEqual([])
    expect(profile.bashReadOnly).toBe(false)
  })

  it('grants only bash and forces read-only for "vault-read"', () => {
    const profile = resolveModuleCapabilityProfile('vault-read')
    expect(profile.allowedHostToolNames).toEqual([
      MODULE_CAPABILITY_TOOL_NAMES.bash,
    ])
    expect(profile.bashReadOnly).toBe(true)
  })

  it('grants bash and edit and is not read-only for "vault-write"', () => {
    const profile = resolveModuleCapabilityProfile('vault-write')
    expect(profile.allowedHostToolNames).toEqual([
      MODULE_CAPABILITY_TOOL_NAMES.bash,
      MODULE_CAPABILITY_TOOL_NAMES.edit,
    ])
    expect(profile.bashReadOnly).toBe(false)
  })

  it('returns a frozen profile with a frozen tool name list', () => {
    const profile = resolveModuleCapabilityProfile('vault-write')
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.allowedHostToolNames)).toBe(true)
  })
})
