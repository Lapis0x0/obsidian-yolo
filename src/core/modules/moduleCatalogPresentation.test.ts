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

  it('requires complete metadata for every supported locale', () => {
    expect(() =>
      parseModuleCatalogLocalizations(
        { en: localizations.en, zh: localizations.zh },
        'Test localizations',
      ),
    ).toThrow('fields are invalid')
  })
})
