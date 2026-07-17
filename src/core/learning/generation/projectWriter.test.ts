import type { LearningVaultReadApi } from '../learningVaultReadApi'
import type { LearningVaultWriteApi } from '../learningVaultWriteApi'

import {
  appendKnowledgePointDraft,
  createProjectScaffold,
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
      '---\ntitle: Basics\n---\n\n\n',
    )
    expect(boundary.contents.get(scaffold.indexPath)).toBe(
      '---\ntopic: React\ngoal: Build an app\nstatus: building\nchapters:\n  - 01-Basics\n---\n\n1. [[01-Basics/knowledge|Basics]]\n',
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
})
