import {
  parseModuleCatalogLocalizations,
  resolveModuleCatalogPresentation,
} from './moduleCatalogPresentation'

const localizations = {
  en: { name: 'Learning', description: 'Learn from notes' },
  zh: { name: '学习', description: '从笔记中学习' },
  it: { name: 'Apprendimento', description: 'Impara dalle note' },
}

describe('module catalog presentation', () => {
  it('resolves the requested catalog locale', () => {
    const parsed = parseModuleCatalogLocalizations(
      localizations,
      'Test localizations',
    )

    expect(resolveModuleCatalogPresentation(parsed, 'zh')).toEqual({
      name: '学习',
      description: '从笔记中学习',
    })
  })

  it('renders a locale this build knows and falls back for the rest', () => {
    const parsed = parseModuleCatalogLocalizations(
      { en: localizations.en, zh: localizations.zh },
      'Test localizations',
    )

    expect(resolveModuleCatalogPresentation(parsed, 'zh')).toEqual(
      localizations.zh,
    )
    expect(resolveModuleCatalogPresentation(parsed, 'it')).toEqual(
      localizations.en,
    )
  })

  it('requires the en fallback and complete metadata for a present locale', () => {
    expect(() =>
      parseModuleCatalogLocalizations(
        { zh: localizations.zh },
        'Test localizations',
      ),
    ).toThrow('en fallback')
    expect(() =>
      parseModuleCatalogLocalizations(
        { en: localizations.en, zh: { name: '学习', description: '  ' } },
        'Test localizations',
      ),
    ).toThrow('Test localizations zh is invalid')
  })
})
