import {
  cardGenerationSystemPrompt,
  cardInstructions,
} from './cardInstructions'

describe('cardInstructions', () => {
  it('offers four instructions when something points into the card', () => {
    expect(cardInstructions(true).map((one) => one.key)).toEqual([
      'expand',
      'ideas',
      'challenge',
      'summarize',
    ])
  })

  it('offers only the two an isolated card can answer', () => {
    expect(cardInstructions(false).map((one) => one.key)).toEqual([
      'ideas',
      'summarize',
    ])
  })

  it('tells an isolated card to go looking for its own context', () => {
    for (const instruction of cardInstructions(false)) {
      expect(instruction.prompt).toContain('read_card')
    }
  })

  it('labels every chip through i18n rather than in place', () => {
    for (const instruction of [
      ...cardInstructions(true),
      ...cardInstructions(false),
    ]) {
      expect(instruction.labelKey).toBe(`cardAi.instruction.${instruction.key}`)
    }
  })
})

describe('cardGenerationSystemPrompt', () => {
  // It replaces the host's default system prompt outright (master.md §5), so
  // an empty one would silently restore the assistant persona and the
  // built-in tool documentation this run must not have.
  it('is never empty and names the locale it was built for', () => {
    const prompt = cardGenerationSystemPrompt('zh')
    expect(prompt.trim()).not.toBe('')
    expect(prompt).toContain('(zh)')
  })
})
