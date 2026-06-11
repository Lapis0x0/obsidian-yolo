import type { SubagentAcceptedResult } from './types'

describe('SubagentAcceptedResult shape', () => {
  it('matches the async accepted placeholder contract', () => {
    const sample: SubagentAcceptedResult = {
      accepted: true,
      taskId: 'sub_deadbeef',
      title: 'Scan notes',
      status: 'running',
      note: 'Subagent started asynchronously.',
    }
    expect(sample.accepted).toBe(true)
    expect(sample.status).toBe('running')
    expect(sample.taskId).toMatch(/^sub_/)
  })
})
