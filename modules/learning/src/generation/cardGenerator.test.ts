import type {
  LearningVaultFile,
  LearningVaultReadApi,
} from '../domain/learningVaultReadApi'
import type {
  LearningVaultFileSnapshot,
  LearningVaultWriteApi,
} from '../domain/learningVaultWriteApi'

import {
  assertKnowledgeUnchanged,
  buildCardsContent,
  collectExistingCardUuids,
  createCardUuid,
  extractMarkdownBody,
  hasResumableCardsFile,
} from './cardGenerator'
import type { LearningGenerationHost } from './host'

describe('buildCardsContent', () => {
  it('produces a header-only shell when there are no cards', () => {
    expect(buildCardsContent('Chapter One', [])).toBe(
      '---\ntitle: Chapter One\n---\n',
    )
  })

  it('joins card blocks under the frontmatter header', () => {
    const content = buildCardsContent('Chapter One', [
      '## A\n\nfront\n---\nback',
    ])
    expect(content).toBe(
      '---\ntitle: Chapter One\n---\n\n## A\n\nfront\n---\nback\n',
    )
  })
})

describe('extractMarkdownBody', () => {
  it('strips the frontmatter block', () => {
    expect(extractMarkdownBody('---\ntitle: X\n---\n\nBody text\n')).toBe(
      'Body text',
    )
  })

  it('returns the content unchanged when there is no frontmatter', () => {
    expect(extractMarkdownBody('Body text')).toBe('Body text')
  })
})

describe('createCardUuid', () => {
  it('generates an 8-character lowercase hex id', () => {
    expect(createCardUuid()).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('assertKnowledgeUnchanged', () => {
  const path = 'project/chapter/knowledge.md'
  const expected: LearningVaultFileSnapshot = {
    path,
    content: 'stable content',
  }

  it('resolves when the file is unchanged', async () => {
    const host = {
      vaultWriter: {
        readTextSnapshot: async () => ({ ...expected }),
      } as unknown as LearningVaultWriteApi,
    } as LearningGenerationHost
    await expect(
      assertKnowledgeUnchanged(host, expected),
    ).resolves.toBeUndefined()
  })

  it('rejects when the file content changed', async () => {
    const host = {
      vaultWriter: {
        readTextSnapshot: async () => ({
          ...expected,
          content: 'edited content',
        }),
      } as unknown as LearningVaultWriteApi,
    } as LearningGenerationHost
    await expect(assertKnowledgeUnchanged(host, expected)).rejects.toThrow(
      `Knowledge file changed during generation: ${path}`,
    )
  })

  it('rejects when the file disappeared', async () => {
    const host = {
      vaultWriter: {
        readTextSnapshot: async () => null,
      } as unknown as LearningVaultWriteApi,
    } as LearningGenerationHost
    await expect(assertKnowledgeUnchanged(host, expected)).rejects.toThrow(
      `Knowledge file disappeared: ${path}`,
    )
  })
})

describe('collectExistingCardUuids', () => {
  it('collects card UUIDs only from cards.md files inside the project', () => {
    const projectPath = 'Learning/project'
    const files: LearningVaultFile[] = [
      {
        kind: 'file',
        path: `${projectPath}/chapter-1/cards.md`,
        name: 'cards.md',
        ctime: 0,
        mtime: 0,
      },
      {
        kind: 'file',
        path: `${projectPath}/chapter-2/cards.md`,
        name: 'cards.md',
        ctime: 0,
        mtime: 0,
      },
      {
        kind: 'file',
        path: 'Learning/other-project/chapter-1/cards.md',
        name: 'cards.md',
        ctime: 0,
        mtime: 0,
      },
    ]
    const contents = new Map<string, string>([
      [
        `${projectPath}/chapter-1/cards.md`,
        '## A <!--card:AAAAAAAA kp:11111111-->\n',
      ],
      [`${projectPath}/chapter-2/cards.md`, '## B <!--card:bbbbbbbb-->\n'],
      [
        'Learning/other-project/chapter-1/cards.md',
        '## C <!--card:cccccccc-->\n',
      ],
    ])
    const vault = {
      listMarkdownFiles: () => files,
      readText: async (path: string) => contents.get(path) ?? '',
    } as unknown as LearningVaultReadApi

    return collectExistingCardUuids(vault, projectPath).then((uuids) => {
      expect(uuids).toEqual(new Set(['aaaaaaaa', 'bbbbbbbb']))
    })
  })
})

describe('hasResumableCardsFile', () => {
  const cardsPath = 'project/chapter/cards.md'
  const chapterTitle = 'Chapter'

  it('is false when the cards file does not exist', async () => {
    const host = {
      vault: { getEntry: () => null } as unknown as LearningVaultReadApi,
      vaultWriter: {} as unknown as LearningVaultWriteApi,
    }
    await expect(
      hasResumableCardsFile(host, cardsPath, chapterTitle),
    ).resolves.toBe(false)
  })

  it('is false when the cards file is still the empty shell', async () => {
    const host = {
      vault: {
        getEntry: () => ({
          kind: 'file' as const,
          path: cardsPath,
          name: 'cards.md',
          ctime: 0,
          mtime: 0,
        }),
      } as unknown as LearningVaultReadApi,
      vaultWriter: {
        readTextSnapshot: async () => ({
          path: cardsPath,
          content: buildCardsContent(chapterTitle, []),
        }),
      } as unknown as LearningVaultWriteApi,
    }
    await expect(
      hasResumableCardsFile(host, cardsPath, chapterTitle),
    ).resolves.toBe(false)
  })

  it('is true when the cards file has real content', async () => {
    const host = {
      vault: {
        getEntry: () => ({
          kind: 'file' as const,
          path: cardsPath,
          name: 'cards.md',
          ctime: 0,
          mtime: 0,
        }),
      } as unknown as LearningVaultReadApi,
      vaultWriter: {
        readTextSnapshot: async () => ({
          path: cardsPath,
          content: buildCardsContent(chapterTitle, [
            '## A\n\nfront\n---\nback',
          ]),
        }),
      } as unknown as LearningVaultWriteApi,
    }
    await expect(
      hasResumableCardsFile(host, cardsPath, chapterTitle),
    ).resolves.toBe(true)
  })
})
