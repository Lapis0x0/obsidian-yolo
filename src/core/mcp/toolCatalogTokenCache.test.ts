jest.mock('../../utils/llm/contextTokenEstimate', () => ({
  estimateJsonTokens: jest.fn(),
}))

import { estimateJsonTokens } from '../../utils/llm/contextTokenEstimate'

import {
  getMcpToolSchemaTokenCost,
  prewarmMcpServerToolTokenCosts,
} from './toolCatalogTokenCache'

const mockEstimateJsonTokens = jest.mocked(estimateJsonTokens)

describe('MCP tool catalog token cache', () => {
  beforeEach(() => {
    mockEstimateJsonTokens.mockReset()
  })

  it('prewarms the exact FQN payload and shares its inflight with consumers', async () => {
    let resolveEstimate: ((value: number) => void) | undefined
    mockEstimateJsonTokens.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveEstimate = resolve
      }),
    )
    const nativeTool = {
      name: 'search',
      description: 'Search the catalog',
      inputSchema: { type: 'object' as const, properties: {} },
    }

    prewarmMcpServerToolTokenCosts('remote', [nativeTool])
    const consumer = getMcpToolSchemaTokenCost({
      ...nativeTool,
      name: 'remote__search',
    })

    expect(mockEstimateJsonTokens).toHaveBeenCalledTimes(1)
    expect(mockEstimateJsonTokens).toHaveBeenCalledWith([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'remote__search' }),
      }),
    ])
    resolveEstimate?.(321)
    await expect(consumer).resolves.toBe(321)
  })
})
