import { decideAfterLlmResult, decideAfterToolResult } from './loop-decision'

describe('loop decisions', () => {
  it('enters tool phase when tool calls exist', () => {
    const result = decideAfterLlmResult({
      hasToolCalls: true,
      hasAssistantOutput: false,
      iteration: 1,
      maxIterations: 6,
    })

    expect(result).toEqual({ type: 'tool_phase' })
  })

  it('completes when no tools and no output', () => {
    const result = decideAfterLlmResult({
      hasToolCalls: false,
      hasAssistantOutput: false,
      iteration: 1,
      maxIterations: 6,
    })

    expect(result).toEqual({ type: 'done', reason: 'completed' })
  })

  it('completes when no tools but assistant has output', () => {
    const result = decideAfterLlmResult({
      hasToolCalls: false,
      hasAssistantOutput: true,
      iteration: 1,
      maxIterations: 6,
    })

    expect(result).toEqual({ type: 'done', reason: 'completed' })
  })

  it('continues after tool results when no pending tools', () => {
    const result = decideAfterToolResult({
      hasPendingTools: false,
      iteration: 2,
      maxIterations: 6,
    })

    expect(result).toEqual({ type: 'llm_request', nextIteration: 3 })
  })
})
