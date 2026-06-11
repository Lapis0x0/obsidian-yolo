import { getLocalFileTools } from '../../mcp/localFileTools'

import { DELEGATE_SUBAGENT_TOOL_SHORT_NAME } from './constants'

describe('delegate_subagent tool registration', () => {
  it('registers description and prompt only in the input schema', () => {
    const tools = getLocalFileTools({ vaultBasePath: '/vault' })
    const tool = tools.find(
      (entry) => entry.name === DELEGATE_SUBAGENT_TOOL_SHORT_NAME,
    )
    expect(tool).toBeDefined()
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['description', 'prompt'],
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
      },
    })
  })
})
