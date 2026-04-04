import { SmartComposerSettings } from '../../settings/schema/setting.types'

import { BedrockProvider } from './bedrockProvider'
import { GeminiOAuthProvider } from './geminiOAuthProvider'
import { GeminiProvider } from './gemini'
import { getProviderClient } from './manager'
import { MoonshotProvider } from './moonshotProvider'
import { OpenAICompatibleProvider } from './openaiCompatibleProvider'
import { QwenOAuthProvider } from './qwenOAuthProvider'

const createSettings = (): SmartComposerSettings =>
  ({
    providers: [
      {
        id: 'bedrock-native',
        presetType: 'amazon-bedrock',
        apiType: 'amazon-bedrock',
        apiKey: 'token',
        additionalSettings: { awsRegion: 'us-east-1' },
      },
      {
        id: 'bedrock-mantle',
        presetType: 'amazon-bedrock',
        apiType: 'openai-compatible',
        apiKey: 'token',
        additionalSettings: { awsRegion: 'us-east-1' },
      },
      {
        id: 'gemini-native',
        presetType: 'gemini',
        apiType: 'gemini',
        apiKey: 'token',
      },
      {
        id: 'gemini-oauth',
        presetType: 'gemini-oauth',
        apiType: 'gemini',
      },
      {
        id: 'moonshot',
        presetType: 'moonshot',
        apiType: 'openai-compatible',
        apiKey: 'token',
      },
      {
        id: 'qwen-oauth',
        presetType: 'qwen-oauth',
        apiType: 'openai-compatible',
      },
    ],
    continuationOptions: {
      streamFallbackRecoveryEnabled: true,
      primaryRequestTimeoutMs: 12000,
    },
  }) as unknown as SmartComposerSettings

describe('getProviderClient', () => {
  it('routes native Bedrock providers to BedrockProvider', () => {
    const client = getProviderClient({
      settings: createSettings(),
      providerId: 'bedrock-native',
    })

    expect(client).toBeInstanceOf(BedrockProvider)
  })

  it('routes Bedrock Mantle providers to OpenAICompatibleProvider', () => {
    const client = getProviderClient({
      settings: createSettings(),
      providerId: 'bedrock-mantle',
    })

    expect(client).toBeInstanceOf(OpenAICompatibleProvider)
  })

  it('passes shared request policy to native Gemini providers', () => {
    const client = getProviderClient({
      settings: createSettings(),
      providerId: 'gemini-native',
    })
    const clientWithPolicy = client as unknown as {
      requestPolicy?: { timeoutMs: number }
    }

    expect(client).toBeInstanceOf(GeminiProvider)
    expect(clientWithPolicy.requestPolicy).toEqual({
      timeoutMs: 12000,
    })
  })

  it('passes shared request policy to Gemini OAuth providers', () => {
    const client = getProviderClient({
      settings: createSettings(),
      providerId: 'gemini-oauth',
    })
    const clientWithPolicy = client as unknown as {
      requestPolicy?: { timeoutMs: number }
    }

    expect(client).toBeInstanceOf(GeminiOAuthProvider)
    expect(clientWithPolicy.requestPolicy).toEqual({
      timeoutMs: 12000,
    })
  })

  it('passes shared request policy to native Bedrock providers', () => {
    const client = getProviderClient({
      settings: createSettings(),
      providerId: 'bedrock-native',
    })
    const clientWithPolicy = client as unknown as {
      requestPolicy?: { timeoutMs: number }
    }

    expect(clientWithPolicy.requestPolicy).toEqual({
      timeoutMs: 12000,
    })
  })

  it('routes Moonshot providers to MoonshotProvider', () => {
    const client = getProviderClient({
      settings: createSettings(),
      providerId: 'moonshot',
    })

    expect(client).toBeInstanceOf(MoonshotProvider)
    expect(client).toBeInstanceOf(OpenAICompatibleProvider)
  })

  it('routes Qwen OAuth providers to QwenOAuthProvider', () => {
    const client = getProviderClient({
      settings: createSettings(),
      providerId: 'qwen-oauth',
    })

    expect(client).toBeInstanceOf(QwenOAuthProvider)
  })
})
