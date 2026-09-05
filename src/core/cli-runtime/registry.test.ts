import { RUNTIME_CAPABILITIES } from './capabilities'
import {
  CLI_RUNTIME_DESCRIPTORS,
  CLI_RUNTIME_SELECTOR_ROWS,
  getCliRuntimeDescriptor,
} from './registry'
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

  it('lets omp declare that it collapses into pi’s selector row', () => {
    expect(getCliRuntimeDescriptor('omp').variantOf).toBe('pi')
    // A variant still has an id of its own everywhere else, and the runtime it
    // folds into never declares the relationship back.
    expect(getCliRuntimeDescriptor('pi').variantOf).toBeUndefined()
  })

  it('collapses variants into their base runtime’s selector row', () => {
    expect(
      CLI_RUNTIME_SELECTOR_ROWS.map((row) => [
        row.primary.id,
        row.variants.map((variant) => variant.id),
      ]),
    ).toEqual([
      ['claude-code', []],
      ['codex', []],
      ['hermes', []],
      ['pi', ['omp']],
      ['grok', []],
    ])
  })

  it('keeps every runtime reachable through exactly one selector row', () => {
    const members = CLI_RUNTIME_SELECTOR_ROWS.flatMap((row) => [
      row.primary.id,
      ...row.variants.map((variant) => variant.id),
    ])
    expect([...members].sort()).toEqual([...CLI_RUNTIME_IDS].sort())
  })

  it('never nests a variant under another variant', () => {
    for (const row of CLI_RUNTIME_SELECTOR_ROWS) {
      expect(row.primary.variantOf).toBeUndefined()
      for (const variant of row.variants) {
        expect(variant.variantOf).toBe(row.primary.id)
      }
    }
  })

  it('gives omp the same capabilities as the pi runtime it forks', () => {
    expect(RUNTIME_CAPABILITIES.omp).toEqual(RUNTIME_CAPABILITIES.pi)
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
