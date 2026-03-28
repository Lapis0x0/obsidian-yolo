import type { LLMProvider } from '../../types/provider.types'

import { shouldUseStreamingForProvider } from './streamingPolicy'

const createProvider = (overrides: Partial<LLMProvider> = {}): LLMProvider => ({
  id: 'provider-1',
  presetType: 'openai-compatible',
  apiType: 'openai-compatible',
  ...overrides,
})

describe('shouldUseStreamingForProvider', () => {
  it('keeps streaming enabled for non-obsidian transports', () => {
    expect(
      shouldUseStreamingForProvider({
        requestedStream: true,
        provider: createProvider({
          additionalSettings: { requestTransportMode: 'browser' },
        }),
      }),
    ).toBe(true)
  })

  it('disables streaming for obsidian transport', () => {
    expect(
      shouldUseStreamingForProvider({
        requestedStream: true,
        provider: createProvider({
          additionalSettings: { requestTransportMode: 'obsidian' },
        }),
      }),
    ).toBe(false)
  })

  it('preserves explicit non-streaming requests', () => {
    expect(
      shouldUseStreamingForProvider({
        requestedStream: false,
        provider: createProvider({
          additionalSettings: { requestTransportMode: 'browser' },
        }),
      }),
    ).toBe(false)
  })
})
