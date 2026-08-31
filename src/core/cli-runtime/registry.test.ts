import { RUNTIME_CAPABILITIES } from './capabilities'
import { CLI_RUNTIME_DESCRIPTORS, getCliRuntimeDescriptor } from './registry'
import { CLI_RUNTIME_IDS } from './types'

describe('CLI runtime registry', () => {
  it('orders descriptors the same as CLI_RUNTIME_IDS, the selector display order', () => {
    expect(CLI_RUNTIME_DESCRIPTORS.map((descriptor) => descriptor.id)).toEqual([
      ...CLI_RUNTIME_IDS,
    ])
  })

  it('links each descriptor to its RUNTIME_CAPABILITIES entry', () => {
    for (const descriptor of CLI_RUNTIME_DESCRIPTORS) {
      expect(descriptor.capabilities).toBe(RUNTIME_CAPABILITIES[descriptor.id])
    }
  })

  it('resolves a descriptor by id', () => {
    expect(getCliRuntimeDescriptor('claude-code').id).toBe('claude-code')
    expect(getCliRuntimeDescriptor('codex').id).toBe('codex')
  })

  it('gives every descriptor a label, description, and icon', () => {
    for (const descriptor of CLI_RUNTIME_DESCRIPTORS) {
      expect(descriptor.labelKey.length).toBeGreaterThan(0)
      expect(descriptor.descriptionKey.length).toBeGreaterThan(0)
      expect(descriptor.icon.src.length).toBeGreaterThan(0)
      expect(descriptor.icon.provider.length).toBeGreaterThan(0)
    }
  })

  it('only gives Claude Code a short label — Codex has no shorter form', () => {
    expect(getCliRuntimeDescriptor('claude-code').shortLabelKey).toBe(
      'sidebar.runtimeSelector.claudeCodeShortLabel',
    )
    expect(getCliRuntimeDescriptor('codex').shortLabelKey).toBeUndefined()
  })
})
