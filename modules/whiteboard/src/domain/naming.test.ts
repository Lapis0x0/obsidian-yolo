import {
  cardNoteBaseName,
  generateBoardFileName,
  generateCardNoteFileName,
} from './naming'

describe('generateBoardFileName', () => {
  it('returns the plain name when nothing collides', () => {
    expect(generateBoardFileName('Whiteboard', new Set())).toBe(
      'Whiteboard.yoloboard',
    )
  })

  it('appends " 1" on a single collision', () => {
    const existing = new Set(['Whiteboard.yoloboard'])
    expect(generateBoardFileName('Whiteboard', existing)).toBe(
      'Whiteboard 1.yoloboard',
    )
  })

  it('finds the first free numeric suffix across multiple collisions', () => {
    const existing = new Set([
      'Whiteboard.yoloboard',
      'Whiteboard 1.yoloboard',
      'Whiteboard 2.yoloboard',
    ])
    expect(generateBoardFileName('Whiteboard', existing)).toBe(
      'Whiteboard 3.yoloboard',
    )
  })

  it('leaves a gap unfilled — picks the first free suffix scanning upward, not the smallest overall', () => {
    const existing = new Set(['Whiteboard.yoloboard', 'Whiteboard 2.yoloboard'])
    expect(generateBoardFileName('Whiteboard', existing)).toBe(
      'Whiteboard 1.yoloboard',
    )
  })

  it('works for a non-Latin base name', () => {
    const existing = new Set(['白板.yoloboard'])
    expect(generateBoardFileName('白板', existing)).toBe('白板 1.yoloboard')
  })
})

describe('cardNoteBaseName', () => {
  it('takes a leading markdown heading and falls back otherwise', () => {
    expect(cardNoteBaseName('# Reading list\n\nbody', 'Untitled')).toBe(
      'Reading list',
    )
    expect(cardNoteBaseName('###### Deep\n', 'Untitled')).toBe('Deep')
    // Ordinary prose is not a heading — a whole sentence must not become a
    // file name.
    expect(cardNoteBaseName('Reading list\n# later', 'Untitled')).toBe(
      'Untitled',
    )
    expect(cardNoteBaseName('#NoSpace', 'Untitled')).toBe('Untitled')
    expect(cardNoteBaseName('', 'Untitled')).toBe('Untitled')
  })

  it('strips characters a vault file name cannot carry', () => {
    expect(cardNoteBaseName('# a/b:c*d?e"f<g>h|i', 'Untitled')).toBe(
      'a b c d e f g h i',
    )
    expect(cardNoteBaseName('# ...', 'Untitled')).toBe('Untitled')
    expect(cardNoteBaseName('# trailing.', 'Untitled')).toBe('trailing')
  })
})

describe('generateCardNoteFileName', () => {
  it('shares the whiteboard conflict rule', () => {
    expect(generateCardNoteFileName('Untitled', new Set())).toBe('Untitled.md')
    expect(
      generateCardNoteFileName(
        'Untitled',
        new Set(['Untitled.md', 'Untitled 1.md']),
      ),
    ).toBe('Untitled 2.md')
  })
})
