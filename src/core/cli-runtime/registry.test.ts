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
    expect(getCliRuntimeDescriptor('grok')).toMatchObject({
      id: 'grok',
      icon: { provider: 'xai' },
    })
  })

  it('gives every descriptor a label, fallback, description, and icon', () => {
    for (const descriptor of CLI_RUNTIME_DESCRIPTORS) {
      expect(descriptor.labelKey.length).toBeGreaterThan(0)
      expect(descriptor.defaultLabel.length).toBeGreaterThan(0)
      expect(descriptor.descriptionKey.length).toBeGreaterThan(0)
      expect(descriptor.icon.src.length).toBeGreaterThan(0)
      expect(descriptor.icon.provider.length).toBeGreaterThan(0)
    }
  })

  it('only gives Claude Code a short label — other runtimes use their full labels', () => {
    expect(getCliRuntimeDescriptor('claude-code').shortLabelKey).toBe(
      'sidebar.runtimeSelector.claudeCodeShortLabel',
    )
    expect(getCliRuntimeDescriptor('codex').shortLabelKey).toBeUndefined()
    expect(getCliRuntimeDescriptor('grok').shortLabelKey).toBeUndefined()
  })

  it('hides the YOLO toggle only for the pinned ask-first Grok runtime', () => {
    expect(RUNTIME_CAPABILITIES['claude-code'].showsYoloToggle).toBe(true)
    expect(RUNTIME_CAPABILITIES.codex.showsYoloToggle).toBe(true)
    expect(RUNTIME_CAPABILITIES.pi.showsYoloToggle).toBe(true)
    expect(RUNTIME_CAPABILITIES.hermes.showsYoloToggle).toBe(true)
    expect(RUNTIME_CAPABILITIES.grok.showsYoloToggle).toBe(false)
  })

  it('declares the known Grok ACP image-input limitation', () => {
    expect(RUNTIME_CAPABILITIES.grok.supportsImageAttachments).toBe(false)
    expect(RUNTIME_CAPABILITIES.hermes.supportsImageAttachments).toBe(true)
  })
})
