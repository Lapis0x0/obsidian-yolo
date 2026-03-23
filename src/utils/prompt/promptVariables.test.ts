import { resolvePromptVariables } from './promptVariables'

describe('resolvePromptVariables', () => {
  const now = new Date(2026, 2, 23, 14, 37, 52)

  it('resolves current_date, current_hour, and current_minute', () => {
    expect(
      resolvePromptVariables(
        'Date={{current_date}}; Hour={{current_hour}}; Minute={{current_minute}}',
        { now },
      ),
    ).toBe(
      'Date=2026-03-23; Hour=2026-03-23 14; Minute=2026-03-23 14:37',
    )
  })

  it('supports current_time aliases with explicit granularity', () => {
    expect(
      resolvePromptVariables(
        '{{current_time:date}} | {{current_time:hour}} | {{current_time:minute}}',
        { now },
      ),
    ).toBe('2026-03-23 | 2026-03-23 14 | 2026-03-23 14:37')
  })

  it('keeps unknown variables unchanged', () => {
    expect(
      resolvePromptVariables(
        'Known={{current_date}} Unknown={{current_time:second}} {{foo}}',
        { now },
      ),
    ).toBe('Known=2026-03-23 Unknown={{current_time:second}} {{foo}}')
  })

  it('supports case-insensitive variable names', () => {
    expect(
      resolvePromptVariables(
        '{{CURRENT_DATE}} {{Current_Hour}} {{current_time:MINUTE}}',
        { now },
      ),
    ).toBe('2026-03-23 2026-03-23 14 2026-03-23 14:37')
  })
})
