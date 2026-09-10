jest.mock('obsidian')

import { App, TFile } from 'obsidian'

import { expandPromptEmbeds } from './expand-prompt-embeds'

type FakeHeading = { heading: string; level: number; line0: number }

type FakeNote = {
  path: string
  content: string
  extension?: string
  headings?: FakeHeading[]
}

function makeVault(notes: FakeNote[], onRead?: (path: string) => void) {
  const files = new Map<string, TFile>()
  const contents = new Map<string, string>()
  const headings = new Map<string, FakeHeading[]>()

  for (const note of notes) {
    const extension = note.extension ?? 'md'
    const file = Object.assign(new TFile(), { path: note.path, extension })
    files.set(note.path, file)
    contents.set(note.path, note.content)
    if (note.headings) headings.set(note.path, note.headings)
  }

  // Mirrors getFirstLinkpathDest closely enough for these tests: match on the
  // full path first, then on the basename.
  const resolve = (linkpath: string): TFile | null => {
    const direct = files.get(linkpath) ?? files.get(`${linkpath}.md`)
    if (direct) return direct
    for (const [path, file] of files) {
      const basename = path.split('/').pop() ?? path
      const withoutExt = basename.replace(/\.[^.]+$/, '')
      if (withoutExt === linkpath || basename === linkpath) return file
    }
    return null
  }

  const app = {
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string) => resolve(linkpath),
      getFileCache: (file: TFile) => {
        const entries = headings.get(file.path)
        if (!entries) return null
        return {
          headings: entries.map((h) => ({
            heading: h.heading,
            level: h.level,
            position: {
              start: { line: h.line0, col: 0, offset: 0 },
              end: { line: h.line0, col: 0, offset: 0 },
            },
          })),
        }
      },
    },
    vault: {
      cachedRead: (file: TFile) => {
        onRead?.(file.path)
        const content = contents.get(file.path)
        if (content === undefined) {
          return Promise.reject(new Error(`unreadable: ${file.path}`))
        }
        return Promise.resolve(content)
      },
    },
  } as unknown as App

  return app
}

describe('expandPromptEmbeds', () => {
  it('replaces an embed with the note body in place', async () => {
    const app = makeVault([{ path: 'soul.md', content: 'I am terse.' }])
    const result = await expandPromptEmbeds(app, 'Persona:\n![[soul]]\nEnd.')
    expect(result).toBe('Persona:\nI am terse.\nEnd.')
  })

  it('leaves plain [[links]] untouched', async () => {
    const app = makeVault([{ path: 'soul.md', content: 'I am terse.' }])
    const result = await expandPromptEmbeds(app, 'See [[soul]] for details.')
    expect(result).toBe('See [[soul]] for details.')
  })

  it('leaves an unresolvable embed exactly as written', async () => {
    const app = makeVault([{ path: 'soul.md', content: 'I am terse.' }])
    const result = await expandPromptEmbeds(app, 'A ![[nowhere]] B')
    expect(result).toBe('A ![[nowhere]] B')
  })

  it('does not expand non-markdown targets', async () => {
    const app = makeVault([
      { path: 'diagram.png', content: 'binary', extension: 'png' },
    ])
    const result = await expandPromptEmbeds(app, 'Look: ![[diagram.png]]')
    expect(result).toBe('Look: ![[diagram.png]]')
  })

  it('expands several embeds in document order', async () => {
    const app = makeVault([
      { path: 'a.md', content: 'AAA' },
      { path: 'b.md', content: 'BBB' },
    ])
    const result = await expandPromptEmbeds(app, '1:![[a]] 2:![[b]]')
    expect(result).toBe('1:AAA 2:BBB')
  })

  it('expands nested embeds to unlimited depth', async () => {
    const app = makeVault([
      { path: 'a.md', content: 'A>![[b]]' },
      { path: 'b.md', content: 'B>![[c]]' },
      { path: 'c.md', content: 'C' },
    ])
    const result = await expandPromptEmbeds(app, '![[a]]')
    expect(result).toBe('A>B>C')
  })

  it('terminates on a cycle, leaving the repeat visit unexpanded', async () => {
    const app = makeVault([
      { path: 'a.md', content: 'A[![[b]]]' },
      { path: 'b.md', content: 'B[![[a]]]' },
    ])
    const result = await expandPromptEmbeds(app, '![[a]]')
    expect(result).toBe('A[B[![[a]]]]')
  })

  it('expands a repeated target only once', async () => {
    const reads: string[] = []
    const app = makeVault([{ path: 'a.md', content: 'AAA' }], (path) =>
      reads.push(path),
    )
    const result = await expandPromptEmbeds(app, '![[a]] and ![[a]]')
    expect(result).toBe('AAA and ![[a]]')
    expect(reads).toEqual(['a.md'])
  })

  it('expands two different sections of the same note', async () => {
    const app = makeVault([
      {
        path: 'long.md',
        content: '# One\nfirst\n# Two\nsecond',
        headings: [
          { heading: 'One', level: 1, line0: 0 },
          { heading: 'Two', level: 1, line0: 2 },
        ],
      },
    ])
    const result = await expandPromptEmbeds(app, '![[long#One]]|![[long#Two]]')
    // The heading line is part of its own section, matching how Obsidian
    // itself renders `![[Note#Section]]`.
    expect(result).toBe('# One\nfirst|# Two\nsecond')
  })

  it('expands only the requested section', async () => {
    const app = makeVault([
      {
        path: 'long.md',
        content: '# One\nfirst\n# Two\nsecond',
        headings: [
          { heading: 'One', level: 1, line0: 0 },
          { heading: 'Two', level: 1, line0: 2 },
        ],
      },
    ])
    const result = await expandPromptEmbeds(app, '![[long#Two]]')
    expect(result).toBe('# Two\nsecond')
  })

  it('does not fall back to the full note when a section is missing', async () => {
    const app = makeVault([
      {
        path: 'long.md',
        content: '# One\nfirst',
        headings: [{ heading: 'One', level: 1, line0: 0 }],
      },
    ])
    const result = await expandPromptEmbeds(app, '![[long#Nope]]')
    expect(result).toBe('![[long#Nope]]')
  })

  it('strips an alias before resolving', async () => {
    const app = makeVault([{ path: 'soul.md', content: 'I am terse.' }])
    const result = await expandPromptEmbeds(app, '![[soul|My persona]]')
    expect(result).toBe('I am terse.')
  })

  it('leaves the link in place when the file cannot be read', async () => {
    const file = Object.assign(new TFile(), {
      path: 'broken.md',
      extension: 'md',
    })
    const app = {
      metadataCache: {
        getFirstLinkpathDest: () => file,
        getFileCache: () => null,
      },
      vault: {
        cachedRead: () => Promise.reject(new Error('boom')),
      },
    } as unknown as App
    const result = await expandPromptEmbeds(app, 'X ![[broken]] Y')
    expect(result).toBe('X ![[broken]] Y')
  })

  it('returns the input unchanged when there is nothing to expand', async () => {
    const app = makeVault([])
    const result = await expandPromptEmbeds(app, 'no embeds here')
    expect(result).toBe('no embeds here')
  })
})
