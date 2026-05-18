import { DEFAULT_AGENT_LLM_TOOLS } from '../setting.types'

import { migrateFrom56To57 } from './56_to_57'

describe('migrateFrom56To57', () => {
  it('adds agent LLM tool defaults when missing', () => {
    const result = migrateFrom56To57({ version: 56 })

    expect(result.version).toBe(57)
    expect(result.agentLlmTools).toEqual(DEFAULT_AGENT_LLM_TOOLS)
  })

  it('preserves existing agent LLM tool settings', () => {
    const agentLlmTools = {
      enabled: false,
      categories: [
        {
          id: 'custom',
          name: 'Custom',
          description: 'Custom category',
        },
      ],
      modelTools: [
        {
          id: 'tool-1',
          modelId: 'openai/model',
          categoryId: 'custom',
          enabled: true,
        },
      ],
    }

    const result = migrateFrom56To57({ version: 56, agentLlmTools })

    expect(result.version).toBe(57)
    expect(result.agentLlmTools).toBe(agentLlmTools)
  })
})
