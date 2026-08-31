import {
  basenameWithoutExtension,
  cardNoteContent,
  fileNodeKind,
  folderPathOf,
  generateBoardFileName,
  generateCardNoteFileName,
  isCanvasPath,
  isMarkdownPath,
} from './naming'

describe('fileNodeKind', () => {
  it('classifies each kind of card a file node can render as', () => {
    expect(fileNodeKind('Cards/概念A.md')).toBe('markdown')
    expect(fileNodeKind('Assets/photo.PNG')).toBe('image')
    expect(fileNodeKind('Assets/scan.svg')).toBe('image')
    expect(fileNodeKind('Assets/talk.m4a')).toBe('audio')
    expect(fileNodeKind('Assets/talk.opus')).toBe('audio')
    expect(fileNodeKind('Assets/clip.mp4')).toBe('video')
    expect(fileNodeKind('Assets/clip.mkv')).toBe('video')
  })

  it('reads .webm as video — the container carries either, and a video element plays both', () => {
    expect(fileNodeKind('Assets/clip.webm')).toBe('video')
  })

  it('leaves everything else unsupported, PDF included (its card is M2)', () => {
    expect(fileNodeKind('papers/foo.pdf')).toBe('unsupported')
    expect(fileNodeKind('data/table.csv')).toBe('unsupported')
    expect(fileNodeKind('Assets/README')).toBe('unsupported')
    expect(fileNodeKind('.gitignore')).toBe('unsupported')
  })
})

describe('basenameWithoutExtension', () => {
  it('strips a vault-relative directory path and extension', () => {
    expect(basenameWithoutExtension('Cards/concept a.md')).toBe('concept a')
  })

  it('handles a bare filename with no directory', () => {
    expect(basenameWithoutExtension('foo.pdf')).toBe('foo')
  })

  it('leaves a leading dot (dotfile) alone rather than treating it as the extension', () => {
    expect(basenameWithoutExtension('.gitignore')).toBe('.gitignore')
  })

  it('leaves a file with no extension alone', () => {
    expect(basenameWithoutExtension('Cards/README')).toBe('README')
  })
})

describe('folderPathOf', () => {
  it('returns the containing folder', () => {
    expect(folderPathOf('A/B/board.yoloboard')).toBe('A/B')
  })

  it('returns the empty string for a file at the vault root', () => {
    expect(folderPathOf('board.yoloboard')).toBe('')
  })
})

describe('isMarkdownPath / isCanvasPath', () => {
  it('recognizes markdown regardless of case', () => {
    expect(isMarkdownPath('Notes/A.md')).toBe(true)
    expect(isMarkdownPath('Notes/A.MD')).toBe(true)
    expect(isMarkdownPath('Notes/A.pdf')).toBe(false)
    expect(isMarkdownPath('Notes/mdfile')).toBe(false)
  })

  it('recognizes canvas files regardless of case', () => {
    expect(isCanvasPath('Boards/A.canvas')).toBe(true)
    expect(isCanvasPath('Boards/A.Canvas')).toBe(true)
    expect(isCanvasPath('Boards/A.yoloboard')).toBe(false)
  })
})

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

describe('cardNoteContent', () => {
  it('takes a leading markdown heading as the name and drops it from the body', () => {
    expect(cardNoteContent('# Reading list\n\nbody', 'Untitled')).toEqual({
      baseName: 'Reading list',
      body: 'body',
    })
    expect(cardNoteContent('###### Deep\n', 'Untitled')).toEqual({
      baseName: 'Deep',
      body: '',
    })
    expect(cardNoteContent('# Only a title', 'Untitled')).toEqual({
      baseName: 'Only a title',
      body: '',
    })
  })

  it('keeps CRLF text intact around the heading it removes', () => {
    expect(cardNoteContent('# Title\r\n\r\nbody\r\nmore', 'Untitled')).toEqual({
      baseName: 'Title',
      body: 'body\r\nmore',
    })
  })

  it('leaves the text alone when no heading named the file', () => {
    // Ordinary prose is not a heading — a whole sentence must not become a
    // file name, and the prose must stay in the note.
    expect(cardNoteContent('Reading list\n# later', 'Untitled')).toEqual({
      baseName: 'Untitled',
      body: 'Reading list\n# later',
    })
    expect(cardNoteContent('#NoSpace', 'Untitled')).toEqual({
      baseName: 'Untitled',
      body: '#NoSpace',
    })
    expect(cardNoteContent('', 'Untitled')).toEqual({
      baseName: 'Untitled',
      body: '',
    })
  })

  it('strips characters a vault file name cannot carry', () => {
    expect(cardNoteContent('# a/b:c*d?e"f<g>h|i', 'Untitled').baseName).toBe(
      'a b c d e f g h i',
    )
    expect(cardNoteContent('# trailing.', 'Untitled').baseName).toBe('trailing')
  })

  it('keeps a heading that sanitized away to nothing — it named no file', () => {
    expect(cardNoteContent('# ...\n\nbody', 'Untitled')).toEqual({
      baseName: 'Untitled',
      body: '# ...\n\nbody',
    })
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
