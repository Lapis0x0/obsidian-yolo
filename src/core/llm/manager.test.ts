import { SmartComposerSettings } from '../../settings/schema/setting.types'

import { BedrockProvider } from './bedrockProvider'
import { getProviderClient } from './manager'
import { OpenAICompatibleProvider } from './openaiCompatibleProvider'

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
    ],
  } as unknown as SmartComposerSettings)

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
})
