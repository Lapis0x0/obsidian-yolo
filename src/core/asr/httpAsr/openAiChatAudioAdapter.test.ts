import { sendAsrJsonRequest } from '../httpTransport'

import { OpenAiCompatibleChatAudioAsrProvider } from './openAiChatAudioAdapter'

jest.mock('../httpTransport', () => ({
  sendAsrJsonRequest: jest.fn(),
}))

const mockedSendAsrJsonRequest = jest.mocked(sendAsrJsonRequest)

const bytes = (value: string): ArrayBuffer =>
  new TextEncoder().encode(value).buffer

const getJsonBody = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object') {
    throw new Error('Expected JSON request body.')
  }
  return body as Record<string, unknown>
}

describe('OpenAiCompatibleChatAudioAsrProvider', () => {
  beforeEach(() => {
    mockedSendAsrJsonRequest.mockReset()
  })

  it('expands extra_body custom parameters into chat-audio request body', async () => {
    mockedSendAsrJsonRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: '{}',
      json: {
        choices: [{ message: { content: '你好 MiMo' } }],
      },
    })

    const provider = new OpenAiCompatibleChatAudioAsrProvider({
      baseURL: 'https://api.xiaomimimo.com/v1',
      apiKey: 'mimo-key',
      model: 'mimo-v2.5-asr',
      chatCompletionsPath: '/chat/completions',
      audioContentFormat: 'input_audio_data_url',
      audioFormat: 'auto',
      transportMode: 'node',
      language: 'zh',
      customParameters: [
        {
          key: 'extra_body',
          type: 'json',
          value: '{"asr_options":{"language":"zh"}}',
        },
      ],
    })

    const result = await provider.transcribe({
      blob: new Blob([bytes('fake wav')], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
    })

    const call = mockedSendAsrJsonRequest.mock.calls[0]?.[0]
    expect(call?.url).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(call?.headers).toMatchObject({
      Authorization: 'Bearer mimo-key',
    })
    expect(getJsonBody(call?.body)).toMatchObject({
      model: 'mimo-v2.5-asr',
      asr_options: { language: 'zh' },
    })
    expect(
      getJsonBody(call?.body).messages as Array<Record<string, unknown>>,
    ).toHaveLength(1)
    expect(result.text).toBe('你好 MiMo')
  })
})
