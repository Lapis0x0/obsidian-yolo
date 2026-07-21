import {
  createLearningTranslation,
  en,
  it as italian,
  normalizeLearningLocale,
  zh,
} from './index'

describe('Learning i18n', () => {
  it('keeps en, zh, and it leaf keys in parity', () => {
    expect(leafKeys(zh)).toEqual(leafKeys(en))
    expect(leafKeys(italian)).toEqual(leafKeys(en))
  })

  it('normalizes locales and falls back to English', () => {
    expect(normalizeLearningLocale('zh-CN')).toBe('zh')
    expect(normalizeLearningLocale('it_IT')).toBe('it')
    expect(normalizeLearningLocale('fr')).toBe('en')
    expect(createLearningTranslation('zh-CN')('learning.home.title')).toBe(
      '学习中心',
    )
    expect(createLearningTranslation('it')('missing', 'Fallback')).toBe(
      'Fallback',
    )
  })
})

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix]
  return Object.entries(value)
    .flatMap(([key, child]) =>
      leafKeys(child, prefix ? `${prefix}.${key}` : key),
    )
    .sort()
}
