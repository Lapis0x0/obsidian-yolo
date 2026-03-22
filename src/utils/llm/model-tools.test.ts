import { getHostedToolsForModel } from './model-tools'

describe('getHostedToolsForModel', () => {
  it('returns web_search when GPT web search is enabled', () => {
    expect(
      getHostedToolsForModel({
        toolType: 'gpt',
        gptTools: {
          webSearch: {
            enabled: true,
          },
        },
      }),
    ).toEqual([{ type: 'web_search' }])
  })

  it('returns no hosted tools when GPT tools are disabled', () => {
    expect(
      getHostedToolsForModel({
        toolType: 'gpt',
        gptTools: {
          webSearch: {
            enabled: false,
          },
        },
      }),
    ).toEqual([])
  })

  it('returns no hosted tools for non-GPT tool types', () => {
    expect(
      getHostedToolsForModel({
        toolType: 'gemini',
        gptTools: {
          webSearch: {
            enabled: true,
          },
        },
      }),
    ).toEqual([])
  })
})
