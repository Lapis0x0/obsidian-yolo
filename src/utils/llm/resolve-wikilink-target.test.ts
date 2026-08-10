jest.mock('obsidian')

import { App, TFile } from 'obsidian'

import { resolveWikilinkReadTarget } from './resolve-wikilink-target'

type FakeHeading = { heading: string; level: number; line0: number }
type FakeBlock = { id: string; startLine0: number; endLine0: number }

function makeFile(path: string, extension = 'md'): TFile {
  return Object.assign(new TFile(), { path, extension })
}

function makeApp(options: {
  resolver: (linkpath: string, sourcePath: string) => TFile | null
  fileCaches?: Map<TFile, { headings?: FakeHeading[]; blocks?: FakeBlock[] }>
}): App {
  const { resolver, fileCaches } = options
  return {
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string, sourcePath: string) =>
        resolver(linkpath, sourcePath),
      getFileCache: (file: TFile) => {
        const entry = fileCaches?.get(file)
        if (!entry) return null
        return {
          headings: entry.headings?.map((h) => ({
            heading: h.heading,
            level: h.level,
            position: {
              start: { line: h.line0, col: 0, offset: 0 },
              end: { line: h.line0, col: 0, offset: 0 },
            },
          })),
          blocks: entry.blocks
            ? Object.fromEntries(
                entry.blocks.map((b) => [
                  b.id,
                  {
                    id: b.id,
                    position: {
                      start: { line: b.startLine0, col: 0, offset: 0 },
                      end: { line: b.endLine0, col: 0, offset: 0 },
                    },
                  },
                ]),
              )
            : undefined,
        }
      },
    },
  } as unknown as App
}

describe('resolveWikilinkReadTarget', () => {
  it('resolves a bare link name without brackets', () => {
    const file = makeFile('Notes/Foo.md')
    const app = makeApp({
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
    })
    const result = resolveWikilinkReadTarget(app, 'Foo')
    expect(result?.file).toBe(file)
    expect(result?.subpath).toBeUndefined()
  })

  it('resolves a [[...]]-wrapped link', () => {
    const file = makeFile('Notes/Foo.md')
    const app = makeApp({
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
    })
    expect(resolveWikilinkReadTarget(app, '[[Foo]]')?.file).toBe(file)
  })

  it('strips the "!" embed prefix from ![[...]]', () => {
    const file = makeFile('Notes/Foo.md')
    const app = makeApp({
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
    })
    expect(resolveWikilinkReadTarget(app, '![[Foo]]')?.file).toBe(file)
  })

  it('strips the |alias suffix before resolving', () => {
    const file = makeFile('Notes/Foo.md')
    const app = makeApp({
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
    })
    expect(resolveWikilinkReadTarget(app, '[[Foo|Nickname]]')?.file).toBe(file)
  })

  it('resolves whether or not the raw target carries a .md suffix', () => {
    const file = makeFile('Notes/Foo.md')
    const app = makeApp({
      resolver: (linkpath) =>
        linkpath === 'Foo' || linkpath === 'Foo.md' ? file : null,
    })
    expect(resolveWikilinkReadTarget(app, 'Foo')?.file).toBe(file)
    expect(resolveWikilinkReadTarget(app, 'Foo.md')?.file).toBe(file)
  })

  it('passes sourcePath through to getFirstLinkpathDest for relative resolution', () => {
    const file = makeFile('Notes/Sub/Foo.md')
    const resolver = jest.fn((linkpath: string, sourcePath: string) =>
      linkpath === 'Foo' && sourcePath === 'Notes/Sub/Other.md' ? file : null,
    )
    const app = makeApp({ resolver })
    const result = resolveWikilinkReadTarget(
      app,
      '[[Foo]]',
      'Notes/Sub/Other.md',
    )
    expect(result?.file).toBe(file)
    expect(resolver).toHaveBeenCalledWith('Foo', 'Notes/Sub/Other.md')
  })

  it('defaults sourcePath to "" (vault-wide best match) when omitted', () => {
    const file = makeFile('Notes/Foo.md')
    const resolver = jest.fn((linkpath: string, sourcePath: string) =>
      linkpath === 'Foo' && sourcePath === '' ? file : null,
    )
    const app = makeApp({ resolver })
    expect(resolveWikilinkReadTarget(app, '[[Foo]]')?.file).toBe(file)
    expect(resolver).toHaveBeenCalledWith('Foo', '')
  })

  it('returns null when the base link path does not resolve', () => {
    const app = makeApp({ resolver: () => null })
    expect(resolveWikilinkReadTarget(app, '[[Missing]]')).toBeNull()
  })

  it('resolves a heading subpath to a line range including deeper sub-sections, stopping before the next same-level heading', () => {
    const file = makeFile('Notes/Foo.md')
    const app = makeApp({
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
      fileCaches: new Map([
        [
          file,
          {
            headings: [
              { heading: 'Intro', level: 1, line0: 0 },
              { heading: 'Section A', level: 1, line0: 5 },
              { heading: 'Sub A.1', level: 2, line0: 8 },
              { heading: 'Section B', level: 1, line0: 15 },
            ],
          },
        ],
      ]),
    })
    const result = resolveWikilinkReadTarget(app, '[[Foo#Section A]]')
    // Section A starts at 0-based line 5 (1-based 6) and must extend through
    // its nested Sub A.1 (0-based line 8) up to but not including Section B
    // (0-based line 15, which equals 1-based line 15 as the end boundary).
    expect(result?.subpath).toEqual({
      type: 'heading',
      startLine: 6,
      endLine: 15,
    })
  })

  it('extends a heading section to end of file when there is no following heading', () => {
    const file = makeFile('Notes/Foo.md')
    const app = makeApp({
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
      fileCaches: new Map([
        [
          file,
          {
            headings: [
              { heading: 'Intro', level: 1, line0: 0 },
              { heading: 'Last', level: 1, line0: 10 },
            ],
          },
        ],
      ]),
    })
    const result = resolveWikilinkReadTarget(app, '[[Foo#Last]]')
    expect(result?.subpath?.type).toBe('heading')
    expect(result?.subpath?.startLine).toBe(11)
    expect(result?.subpath?.endLine).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('resolves a block subpath to the block position line range', () => {
    const file = makeFile('Notes/Foo.md')
    const app = makeApp({
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
      fileCaches: new Map([
        [
          file,
          {
            blocks: [{ id: 'abcd1', startLine0: 20, endLine0: 21 }],
          },
        ],
      ]),
    })
    const result = resolveWikilinkReadTarget(app, '[[Foo#^abcd1]]')
    expect(result?.subpath).toEqual({
      type: 'block',
      startLine: 21,
      endLine: 22,
    })
  })

  it('falls back to file-only with a subpathError when the heading is not found', () => {
    const file = makeFile('Notes/Foo.md')
    const app = makeApp({
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
      fileCaches: new Map([[file, { headings: [] }]]),
    })
    const result = resolveWikilinkReadTarget(app, '[[Foo#Missing]]')
    expect(result?.file).toBe(file)
    expect(result?.subpath).toBeUndefined()
    expect(result?.subpathError).toMatch(/Missing/)
  })

  it('falls back to file-only with a subpathError when the target file is not markdown', () => {
    const file = makeFile('Attachments/foo.canvas', 'canvas')
    const app = makeApp({
      resolver: (linkpath) => (linkpath === 'foo' ? file : null),
    })
    const result = resolveWikilinkReadTarget(app, '[[foo#Missing]]')
    expect(result?.file).toBe(file)
    expect(result?.subpath).toBeUndefined()
    expect(result?.subpathError).toBeDefined()
  })
})
