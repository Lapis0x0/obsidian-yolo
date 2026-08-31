import type { LearningVaultReadApi } from '../domain/learningVaultReadApi'
import type { LearningVaultWriteApi } from '../domain/learningVaultWriteApi'

import {
  appendKnowledgePointDraft,
  buildChapterKnowledgeBaseline,
  createProjectScaffold,
  markChapterKnowledgeComplete,
  markProjectStudying,
} from './projectWriter'

function createVaultBoundary(existingNames: readonly string[] = []) {
  const contents = new Map<string, string>()
  const ensureFolder = jest.fn(async () => undefined)
  const createText = jest.fn(async (path: string, content: string) => {
    contents.set(path, content)
    return { path, mtime: 100 }
  })
  const writeText = jest.fn(async (path: string, content: string) => {
    contents.set(path, content)
    return { path, mtime: 4242 }
  })
  const writer = {
    ensureFolder,
    listChildNames: jest.fn(async () => existingNames),
    createText,
    writeText,
  } as unknown as LearningVaultWriteApi
  const vault = {
    getEntry: (path: string) =>
      contents.has(path)
        ? {
            kind: 'file' as const,
            path,
            name: path.split('/').at(-1) ?? '',
            ctime: 0,
            mtime: 0,
          }
        : null,
    readText: async (path: string) => {
      const content = contents.get(path)
      if (content === undefined) throw new Error(`Missing test file: ${path}`)
      return content
    },
  } as unknown as LearningVaultReadApi
  return { contents, createText, ensureFolder, vault, writer, writeText }
}

describe('Learning project writer boundary', () => {
  it('normalizes paths, selects a unique slug, and writes the scaffold Markdown', async () => {
    const boundary = createVaultBoundary(['React', 'React-2'])

    const scaffold = await createProjectScaffold({
      writer: boundary.writer,
      baseDir: '/Learning//',
      topic: 'React',
      goal: 'Build an app',
      level: 'beginner',
      outputLanguage: 'English',
      chapters: [{ title: 'Basics', contract: 'Core concepts' }],
    })

    expect(scaffold).toEqual({
      projectPath: 'Learning/React-3',
      projectSlug: 'React-3',
      indexPath: 'Learning/React-3/index.md',
      chapters: [
        {
          chapterIndex: 0,
          chapterTitle: 'Basics',
          chapterSlug: '01-Basics',
          chapterPath: 'Learning/React-3/01-Basics',
          knowledgePath: 'Learning/React-3/01-Basics/knowledge.md',
          cardsPath: 'Learning/React-3/01-Basics/cards.md',
        },
      ],
    })
    expect(boundary.ensureFolder.mock.calls).toEqual([
      ['Learning'],
      ['Learning/React-3'],
      ['Learning/React-3/01-Basics'],
    ])
    expect(boundary.contents.get(scaffold.chapters[0].knowledgePath)).toBe(
      '---\ntitle: Basics\ncontract: Core concepts\ncomplete: false\n---\n\n\n',
    )
    expect(boundary.contents.get(scaffold.indexPath)).toBe(
      '---\ntopic: React\ngoal: Build an app\nstatus: building\nchapters:\n  - 01-Basics\nlevel: beginner\noutputLanguage: English\n---\n\n1. [[01-Basics/knowledge|Basics]]\n',
    )
  })

  it('appends a stable knowledge block and returns the adapter mtime', async () => {
    const boundary = createVaultBoundary()
    const knowledgePath = 'Learning/React/01-Basics/knowledge.md'
    boundary.contents.set(knowledgePath, '---\ntitle: Basics\n---\n')

    const point = await appendKnowledgePointDraft({
      vault: boundary.vault,
      writer: boundary.writer,
      projectPath: 'Learning/React',
      chapter: {
        chapterIndex: 0,
        chapterTitle: 'Basics',
        chapterSlug: '01-Basics',
        chapterPath: 'Learning/React/01-Basics',
        knowledgePath,
        cardsPath: 'Learning/React/01-Basics/cards.md',
      },
      point: { title: 'State', body: '  A durable value.  ' },
      uuid: '1234abcd',
    })

    expect(boundary.contents.get(knowledgePath)).toBe(
      '---\ntitle: Basics\n---\n\n## State <!--kp:1234abcd-->\n\nA durable value.\n',
    )
    expect(point.mtime).toBe(4242)
    expect(point.id).toBe('Learning/React/01-Basics/1234abcd')
  })

  it('changes only the project status field', async () => {
    const boundary = createVaultBoundary()
    const indexPath = 'Learning/React/index.md'
    boundary.contents.set(
      indexPath,
      '---\nstatus: building\n---\n\nThe word building stays.\n',
    )

    await markProjectStudying({
      vault: boundary.vault,
      writer: boundary.writer,
      indexPath,
    })

    expect(boundary.contents.get(indexPath)).toBe(
      '---\nstatus: studying\n---\n\nThe word building stays.\n',
    )
  })

  it('marks only the frontmatter flag complete, leaving a same-looking body line alone', async () => {
    const boundary = createVaultBoundary()
    const knowledgePath = 'Learning/React/01-Basics/knowledge.md'
    const baseline = buildChapterKnowledgeBaseline({
      title: 'Basics',
      contract: 'Core concepts',
    })
    // A knowledge point body that happens to contain the exact same line as
    // the frontmatter flag. Since `.replace` without the `g` flag only
    // touches the first match, and the frontmatter always comes first, this
    // decoy line must survive untouched.
    boundary.contents.set(
      knowledgePath,
      `${baseline.trimEnd()}\n\n## Odd example <!--kp:1234abcd-->\n\ncomplete: false\n`,
    )

    await markChapterKnowledgeComplete({
      vault: boundary.vault,
      writer: boundary.writer,
      knowledgePath,
    })

    const updated = boundary.contents.get(knowledgePath) ?? ''
    expect(updated).toContain(
      'title: Basics\ncontract: Core concepts\ncomplete: true\n---',
    )
    expect(updated).toContain(
      '## Odd example <!--kp:1234abcd-->\n\ncomplete: false\n',
    )
  })

  it('is a no-op when a chapter is already marked complete', async () => {
    const boundary = createVaultBoundary()
    const knowledgePath = 'Learning/React/01-Basics/knowledge.md'
    const alreadyComplete = buildChapterKnowledgeBaseline({
      title: 'Basics',
      contract: 'Core concepts',
    }).replace('complete: false', 'complete: true')
    boundary.contents.set(knowledgePath, alreadyComplete)

    await markChapterKnowledgeComplete({
      vault: boundary.vault,
      writer: boundary.writer,
      knowledgePath,
    })

    expect(boundary.writeText).not.toHaveBeenCalled()
  })
})
