import { applyDeepSeekCapabilities } from './deepseekCapabilities'

const v4Model = {
  model: 'deepseek-v4-pro',
  reasoningType: 'openai' as const,
}

const reasonerModel = {
  model: 'deepseek-reasoner',
  reasoningType: 'openai' as const,
}

function run(
  model: { model: string; reasoningType?: 'openai' | 'none' },
  level?: Parameters<typeof applyDeepSeekCapabilities>[0]['reasoningLevel'],
): Record<string, unknown> {
  const request: Record<string, unknown> = {}
  applyDeepSeekCapabilities({ request, model, reasoningLevel: level })
  return request
}

describe('applyDeepSeekCapabilities', () => {
  it('disables thinking for off', () => {
    expect(run(v4Model, 'off')).toEqual({ thinking: { type: 'disabled' } })
  })

  it('skips for auto so the API uses its default', () => {
    expect(run(v4Model, 'auto')).toEqual({})
  })

  it.each(['low', 'medium', 'high'] as const)(
    'maps %s to reasoning_effort=high',
    (level) => {
      expect(run(v4Model, level)).toEqual({
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      })
    },
  )

  it('maps extra-high to reasoning_effort=max', () => {
    expect(run(v4Model, 'extra-high')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
  })

  it('skips deepseek-reasoner regardless of level (V3.2 has no toggle)', () => {
    expect(run(reasonerModel, 'off')).toEqual({})
    expect(run(reasonerModel, 'high')).toEqual({})
  })

  it('skips when model has no reasoning type', () => {
    expect(run({ model: 'deepseek-v4-pro', reasoningType: 'none' }, 'high')).toEqual(
      {},
    )
  })

  it('skips when level is undefined', () => {
    expect(run(v4Model, undefined)).toEqual({})
  })
})
