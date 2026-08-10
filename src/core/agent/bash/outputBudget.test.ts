import {
  VAULT_BASH_STDERR_BUDGET,
  VAULT_BASH_STDOUT_BUDGET,
  truncateBashOutputForContext,
} from './outputBudget'

describe('truncateBashOutputForContext', () => {
  const makeLines = (count: number, prefix = 'file'): string =>
    Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}.md`).join('\n')

  it('returns output within both limits unchanged', () => {
    const output = makeLines(300)
    expect(truncateBashOutputForContext(output, VAULT_BASH_STDOUT_BUDGET)).toBe(
      output,
    )
  })

  it('returns empty output unchanged', () => {
    expect(truncateBashOutputForContext('', VAULT_BASH_STDOUT_BUDGET)).toBe('')
  })

  it('does not count a trailing newline as an extra line', () => {
    const output = `${makeLines(300)}\n`
    expect(truncateBashOutputForContext(output, VAULT_BASH_STDOUT_BUDGET)).toBe(
      output,
    )
  })

  it('truncates by line count, keeping the head and reporting totals', () => {
    const output = makeLines(1000)
    const result = truncateBashOutputForContext(
      output,
      VAULT_BASH_STDOUT_BUDGET,
    )
    const lines = result.split('\n')
    expect(lines).toHaveLength(301)
    expect(lines[0]).toBe('file-1.md')
    expect(lines[299]).toBe('file-300.md')
    expect(lines[300]).toBe(
      `[output truncated: showing first 300 of 1000 lines (${output.length} chars total). ${VAULT_BASH_STDOUT_BUDGET.guidance}]`,
    )
  })

  it('truncates a single oversized line by the char limit', () => {
    const output = 'x'.repeat(50_000)
    const result = truncateBashOutputForContext(
      output,
      VAULT_BASH_STDOUT_BUDGET,
    )
    const [head, notice] = result.split('\n')
    expect(head).toBe('x'.repeat(16_000))
    expect(notice).toContain('showing first 1 of 1 lines (50000 chars total)')
  })

  it('applies the char limit even when the line count is within budget', () => {
    const longLine = 'y'.repeat(200)
    const output = Array.from({ length: 200 }, () => longLine).join('\n')
    const result = truncateBashOutputForContext(
      output,
      VAULT_BASH_STDOUT_BUDGET,
    )
    expect(result.length).toBeLessThan(output.length)
    expect(result).toContain('[output truncated: showing first ')
    expect(result).toContain(`of 200 lines (${output.length} chars total)`)
  })

  it('omits guidance for the stderr budget', () => {
    const output = makeLines(500, 'err')
    const result = truncateBashOutputForContext(
      output,
      VAULT_BASH_STDERR_BUDGET,
    )
    const lines = result.split('\n')
    expect(lines).toHaveLength(101)
    expect(lines[100]).toBe(
      `[stderr truncated: showing first 100 of 500 lines (${output.length} chars total).]`,
    )
  })
})
