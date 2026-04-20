jest.mock('obsidian')

import { App } from 'obsidian'

import { collectWikilinkPaths } from './annotate-wikilinks'

function makeApp(resolver: (linkpath: string) => string | null): App {
  return {
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string) =>
        resolver(linkpath) ? { path: resolver(linkpath) as string } : null,
    },
  } as unknown as App
}

describe('collectWikilinkPaths', () => {
  it('resolves wikilinks by base linkpath', () => {
    const app = makeApp((name) =>
      name === 'Foo' ? 'notes/Foo.md' : name === 'Bar/Baz' ? 'notes/Bar/Baz.md' : null,
    )
    const content = 'see [[Foo]] and [[Bar/Baz]] for details'
    expect(collectWikilinkPaths(app, content, 'src.md')).toEqual([
      { link: 'Foo', path: 'notes/Foo.md' },
      { link: 'Bar/Baz', path: 'notes/Bar/Baz.md' },
    ])
  })

  it('strips #heading and |alias for resolution while keeping dedup by base path', () => {
    const app = makeApp((name) => (name === 'Foo' ? 'notes/Foo.md' : null))
    const content = 'ref [[Foo#A]] and [[Foo#B|nickname]] again [[Foo]]'
    expect(collectWikilinkPaths(app, content, 'src.md')).toEqual([
      { link: 'Foo', path: 'notes/Foo.md' },
    ])
  })

  it('ignores image embeds (![[...]])', () => {
    const app = makeApp(() => 'notes/Foo.md')
    const content = 'embed ![[Foo.png]] only'
    expect(collectWikilinkPaths(app, content, 'src.md')).toEqual([])
  })

  it('omits unresolved links', () => {
    const app = makeApp((name) => (name === 'Known' ? 'notes/Known.md' : null))
    const content = '[[Known]] and [[Unknown]]'
    expect(collectWikilinkPaths(app, content, 'src.md')).toEqual([
      { link: 'Known', path: 'notes/Known.md' },
    ])
  })

  it('does not mutate the input content (disk-exact preservation)', () => {
    const app = makeApp(() => 'notes/Foo.md')
    const content = 'keep [[Foo#H|alias]] untouched'
    collectWikilinkPaths(app, content, 'src.md')
    expect(content).toBe('keep [[Foo#H|alias]] untouched')
  })
})
